// Client-side GPU-visible mirror of the server-authoritative sculpt-brush delta layer
// (src/terrain/HeightDelta.js). Closes the loop the mapspinner-side GPU sampler-texture plumbing
// (packages/mapspinner/src/gl-render.js's uSculptOverride/setSculptOverride + terrain.glsl's
// composeHeight/sculptOverrideAt) was built for: every prior raise/lower/smooth/flatten brush only
// ever mutated the server's COLLIDER heightFn (via HeightDelta.wrapHeightFn) -- the GPU-rendered mesh
// never moved, so a sculpted bump/pit was invisible even though a player could physically stand on it
// (see AGENTS.md/PRD terrain-gpu-visible-sculpt-mesh-deformation).
//
// SCOPE OF THIS FIRST SLICE: replays each live TERRAIN_SCULPT_ACK broadcast this client actually
// RECEIVES (i.e. strokes landed while connected) into a local HeightDelta instance, resamples a
// window around the stroke onto a flat Float32Array, and pushes it into the mapspinner render
// instance via setSculptOverride -- so a connected client's rendered mesh visually deforms in real
// time at the brush location, matching the server collider both in SIGN and MAGNITUDE (HeightDelta.js
// is the identical pure-JS module both sides import, no reimplementation drift possible). Covers ALL
// FOUR brushes including flatten (terrain-sculpt-flatten-gpu-visual-parity): flatten uses
// terrainBackdrop.frame.groundHeightLocal (the GPU-patch-cache-backed height lookup TerrainBackdrop.js
// already wires up for placement, matching the server collider's heightFn) as its client-side
// baseHeightFn -- see applyStroke below for the full derivation.
//
// LATE-JOIN BACKFILL (terrain-sculpt-late-join-gpu-resync): applyBackfill(json, centerX, centerZ, extent)
// closes the gap a client that joins AFTER strokes have already landed used to have -- the server
// collider (src/terrain/HeightDelta.js, the SAME store every collider rebuild reads through) was ALWAYS
// correct for a late joiner, but this client's own local mirror started empty and only accumulated
// strokes witnessed live from that point forward, same gap GRASS_DECAL_SYNC's documented join-time
// backfill already closes for grass decals. `json` is the server's HeightDelta.toJSON() payload (sent
// once via MSG.TERRAIN_SCULPT_SYNC right after connect, see ServerHandlers.js onClientConnect) --
// replayed onto THIS overlay's existing heightDelta instance (not a fresh one, so any strokes this
// client witnesses live afterward accumulate on top correctly) via the same applyRaiseBrush/
// applySmoothBrush dispatch applyStroke uses per-stroke. flatten strokes are skipped here for the exact
// reason applyStroke's own flatten branch is a no-op (see below) -- consistent scope, not a new gap.
// Only ONE gl-render.js uSculptOverride window can be shown at a time (see the WINDOW STRATEGY note
// below), so the backfill uploads a single window centered on the joining client's own spawn point --
// any other historical stroke becomes visible once the player wanders within range of it live, exactly
// like the live-broadcast path already behaves for every other connected client.
//
// WINDOW STRATEGY: rather than tracking the camera and re-centering/re-uploading every frame (the
// General approach RenderControls-driven systems like Weather.js use), this first slice centers the
// override window on the STROKE itself (the ack already carries the exact local-XZ center) with a
// fixed extent generous enough to cover the brush radius plus a margin, and only re-uploads on a new
// stroke -- a sculpt is an infrequent, discrete editor action, not a per-frame continuous simulation,
// so there is no benefit to Weather.js's per-frame camera-follow discipline here. A later slice
// (also filed as a sibling row) can grow this into a camera-following multi-window/tiled system if
// world-scale sculpting (rather than a single hand-placed brush window) becomes a real use case.

import { createHeightDelta } from '/src/terrain/HeightDelta.js'

const WINDOW_MARGIN = 1.5 // override window half-width = stroke radius * this margin, so the cosine falloff's outer edge (which reads 0) is fully inside the window rather than clipped at the boundary
const BACKFILL_EXTENT_DEFAULT = 48 // metres half-width for the late-join backfill window when no caller-supplied extent is given -- generous enough to cover a typical brush radius (see WINDOW_MARGIN usage above) around a joining player's spawn point without needing to know any specific stroke's own radius up front

export function createSculptOverlay(terrainBackdrop) {
  // Local mirror -- deliberately a FRESH, independent HeightDelta instance from the server's, replaying
  // only the strokes THIS client witnesses live (see the late-join-resync note above). No baseHeightFn
  // is stored on the HeightDelta itself (matches the file-level design invariant that the layer never
  // caches a reference to the base fn) -- a flatten stroke's baseHeightFn is resolved fresh per-call in
  // applyStroke below via terrainBackdrop.frame.groundHeightLocal, the same lazy-getter discipline
  // _render()/_frame() already use so a post-reseed fresh terrainBackdrop is always followed.
  const heightDelta = createHeightDelta()
  let _lastExtent = 0

  // planet.render is the real mapspinner gl-render instance (setSculptOverride/clearSculptOverride/
  // SCULPT_RES) -- resolved lazily via a getter each call rather than captured once at construction,
  // since terrainBackdrop can be a fresh instance after a reseed (client/app.js's reseed path replaces
  // terrainBackdrop wholesale) and a captured stale reference would silently stop taking effect.
  function _render() { return terrainBackdrop?.planet?.render }
  function _frame() { return terrainBackdrop?.frame }

  // Resamples heightDelta.deltaAt onto a SCULPT_RES x SCULPT_RES row-major Float32Array covering
  // [center-extent, center+extent] on both local XZ axes, and pushes it + the current PlanetFrame
  // basis into the render instance. Cheap (SCULPT_RES^2, default 256*256=64K deltaAt calls, each a
  // handful of Map lookups + a bilinear blend -- sub-millisecond in practice, matches the "cheap"
  // characterization already documented in gl-render.js's own setSculptOverride comment).
  function _upload(centerX, centerZ, extent) {
    const render = _render(), frame = _frame()
    if (!render || typeof render.setSculptOverride !== 'function' || !frame) return false
    const res = render.SCULPT_RES || 256
    const heights = new Float32Array(res * res)
    const step = (2 * extent) / (res - 1)
    for (let row = 0; row < res; row++) {
      const z = centerZ - extent + row * step
      const base = row * res
      for (let col = 0; col < res; col++) {
        const x = centerX - extent + col * step
        heights[base + col] = heightDelta.deltaAt(x, z)
      }
    }
    render.setSculptOverride([centerX, centerZ], extent, { up: frame.up, east: frame.east, north: frame.north }, heights)
    _lastExtent = extent
    return true
  }

  // Replays one server-authoritative TERRAIN_SCULPT_ACK payload into the local mirror + GPU texture.
  // `payload` is the exact ack shape EditorHandlers.js's TERRAIN_SCULPT handler broadcasts:
  // {ok, brush, x, z, radius, strength, targetHeight}. Mirrors onTerrainPaintBiomeAck's own
  // preset-relookup-from-a-frozen-table pattern -- brush is a closed enum re-dispatched here exactly
  // like BIOME_PRESETS[biome] is there, not raw untrusted data driving arbitrary behavior.
  function applyStroke(payload) {
    if (!payload || payload.ok === false) return false
    const { brush, x, z, radius, strength, targetHeight } = payload
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius <= 0) return false
    if (brush === 'smooth') {
      heightDelta.applySmoothBrush(x, z, radius, Math.min(1, Math.abs(strength)))
    } else if (brush === 'flatten') {
      // GPU-visual-parity fix (terrain-sculpt-flatten-gpu-visual-parity): flatten needs a client-side
      // baseHeightFn(x,z) at each touched cell to compute the delta that cancels the base and pins the
      // composed surface to targetHeight (the ABSOLUTE elevation the server flattened to, carried on the
      // ack). frame.groundHeightLocal is exactly this: TerrainBackdrop.js overrides it with the same
      // GPU-patch-cache lookup (createPatchHeightFn, blocking:false) the server's collider heightFn uses
      // -- "byte-identical tree parity" per that file's own comment -- falling back to the CPU fractal
      // heightFn when the GPU patch bake is unavailable. Either fallback is deterministic and a function
      // of (seed, x, z) alone, so it composes correctly with HeightDelta.applyFlattenBrush's contract
      // (targetDelta = targetHeight - base(cell)) without ever mutating/re-deriving the base itself.
      // blocking:false means a given cell CAN read a stale (up to ~100-frame-old) patch value relative to
      // the server's own blocking:true collider sample -- for a static seed-derived height field that
      // gap is only ever visible mid-flight during a fresh-area cache warm, not a persistent seam; the
      // window-resample below re-reads groundHeightLocal fresh on every stroke regardless, so a repeat
      // flatten stroke at the same spot self-corrects. If no frame (fallback backdrop, no planet) or no
      // groundHeightLocal, skip exactly like before rather than writing wrong deltas.
      const frame = _frame()
      if (!frame || typeof frame.groundHeightLocal !== 'function' || !Number.isFinite(targetHeight)) return false
      heightDelta.applyFlattenBrush((cx, cz) => frame.groundHeightLocal(cx, cz), x, z, radius, targetHeight, Math.min(1, Math.abs(strength)))
    } else {
      heightDelta.applyRaiseBrush(x, z, radius, brush === 'lower' ? -Math.abs(strength) : Math.abs(strength))
    }
    const extent = Math.max(radius * WINDOW_MARGIN, 4)
    return _upload(x, z, extent)
  }

  function clear() {
    heightDelta.clear()
    const render = _render()
    if (render && typeof render.clearSculptOverride === 'function') render.clearSculptOverride()
  }

  // Replays a server HeightDelta.toJSON() payload ({strokes:[{brush,x,z,radius,strength,targetHeight?}]})
  // onto this overlay's EXISTING heightDelta mirror (see the class-level LATE-JOIN BACKFILL comment) --
  // used for the one-time MSG.TERRAIN_SCULPT_SYNC join backfill (client/app.js's onTerrainSculptSync).
  // Each stroke is dispatched through the exact same apply* fns applyStroke uses (not loadHeightDelta,
  // which would allocate a throwaway second HeightDelta instance this overlay would then have to merge
  // or swap in -- replaying directly onto the live instance keeps a single source of truth and lets any
  // stroke witnessed live afterward accumulate on top correctly). flatten strokes are skipped (see
  // applyStroke's own flatten branch for why -- identical scope, no client-side baseHeightFn available).
  // `centerX/centerZ` (the joining client's own spawn local-XZ) + `extent` (BACKFILL_EXTENT_DEFAULT
  // unless the caller has a better estimate) drive the SINGLE gl-render.js window upload -- see the
  // WINDOW STRATEGY note above for why only one window can be shown. Returns {replayed, uploaded} so a
  // caller/live-witness can confirm strokes actually landed in the local mirror even when uploaded is
  // false (e.g. render not ready yet at the moment the backfill arrives).
  function applyBackfill(json, centerX, centerZ, extent) {
    if (!json || !Array.isArray(json.strokes) || json.strokes.length === 0) return { replayed: 0, uploaded: false }
    let replayed = 0
    for (const s of json.strokes) {
      if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.z) || !Number.isFinite(s.radius) || !Number.isFinite(s.strength)) continue
      if (s.brush === 'flatten') continue // see applyStroke's flatten branch -- no client-side baseHeightFn to replay it correctly
      if (s.brush === 'smooth') heightDelta.applySmoothBrush(s.x, s.z, s.radius, Math.min(1, Math.abs(s.strength)))
      else heightDelta.applyRaiseBrush(s.x, s.z, s.radius, s.brush === 'lower' ? -Math.abs(s.strength) : Math.abs(s.strength))
      replayed++
    }
    if (replayed === 0) return { replayed: 0, uploaded: false }
    const cx = Number.isFinite(centerX) ? centerX : 0
    const cz = Number.isFinite(centerZ) ? centerZ : 0
    const ext = Number.isFinite(extent) && extent > 0 ? extent : BACKFILL_EXTENT_DEFAULT
    const uploaded = _upload(cx, cz, ext)
    return { replayed, uploaded }
  }

  return { applyStroke, applyBackfill, clear, get cellCount() { return heightDelta.cellCount }, get strokeCount() { return heightDelta.strokeCount }, get lastExtent() { return _lastExtent } }
}
