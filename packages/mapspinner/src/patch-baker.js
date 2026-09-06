// PatchBaker.js -- bakes terrain height patches off the REAL GPU shader (mapspinner) inside the
// singleplayer/host Web Worker (which has OffscreenCanvas WebGL2), feeding them straight into the
// physics collider. Measured ~2ms per 130^2 tile = ~0.0001ms/sample, ~200-400x faster than the CPU
// fractal AND faster than a JS bilinear lookup -- so the worker bakes patches LIVE on demand and stores
// nothing (the patch IS the GPU's composeHeight, exact). Whole planet reachable: any (face,ox,oy,l)
// bakeable. Runtime-safe (worker). Falls back to null (caller uses the CPU sampler) when GL2 is absent
// (dedicated Node server) or init fails.
//
// Tile->world convention (pinned, gap 0.00/texel vs sampleGroundM): texel (ix,iz) over a tile placed at
// face param corner (ox,oy) spanning l face-metres -> p=(ox+ix/(res-1)*l, oy+iz/(res-1)*l);
// faceLocal=faceWarp(p)=R*tan((p/R)*PI/4); dir=normalize(U*faceLocal_x + V*faceLocal_y + center*R)
// where (U,V,center)=FACE_FRAME[face]; tile.heights[iz*res+ix]=composeHeight(dir) exactly.

import { TERRAIN_DEFAULTS as TD } from './terrain-defaults.js'

const FACE_FRAME = [
  { c: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] }, { c: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { c: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] }, { c: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { c: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, { c: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
]
const _dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

// pick the cube face a unit dir falls on + its pre-warp face-UV (ox,oy), matching the renderer's
// quadtree coord (ox = (4/pi)R atan(dot(dir,U)/dot(dir,center))).
export function dirToFace(dir, R) {
  let bf = 0, bd = -Infinity
  for (let i = 0; i < 6; i++) { const d = _dot(dir, FACE_FRAME[i].c); if (d > bd) { bd = d; bf = i } }
  const F = FACE_FRAME[bf]
  const cc = _dot(dir, F.c), cu = _dot(dir, F.u), cv = _dot(dir, F.v)
  const k = (4 / Math.PI) * R
  return { face: bf, ox: k * Math.atan(cu / cc), oy: k * Math.atan(cv / cc) }
}

// LAST-FACE MEMO (perf, coherent-sweep hot path -- placement/collision lookups call dirToFace with
// nearby dir vectors: continuous player movement, or the ~1.5m 5-tap finite-difference pattern used
// by placement code). Face selection is argmax_i dot(dir, FACE_FRAME[i].c); each FACE_FRAME[i].c is a
// signed standard basis vector, so cc=dot(dir,c) equals +-one coordinate of dir. Since dir is unit
// length, if cc>1/sqrt(2) then dir's OTHER two coordinates satisfy dy^2+dz^2=1-cc^2<0.5, so neither can
// exceed cc -- no other face's dot can beat it. This is an EXACT (not heuristic) sufficient condition,
// proven via the algebra above + a 2M-sample Monte Carlo cross-check (zero violations); strict `>`
// (not `>=`) is required so an exact tie (two faces equidistant, e.g. a cube edge) always falls through
// to the full 6-way argmax rather than risking a wrong face. This only skips the 5 redundant face-normal
// dot products + comparisons of the argmax search -- cc/cu/cv and the two atan calls for the winning
// face are still computed fresh every call (ox/oy are load-bearing outputs, not skippable).
// makeDirToFaceMemo(R) returns a dirToFace(dir)-compatible function with per-instance memo state (so
// concurrent bakers, e.g. server + client in the same process, never share/corrupt each other's cache).
export function makeDirToFaceMemo(R) {
  const k = (4 / Math.PI) * R
  let lastFace = -1
  return function dirToFaceMemo(dir) {
    if (lastFace >= 0) {
      const F = FACE_FRAME[lastFace]
      const cc = _dot(dir, F.c)
      if (cc > Math.SQRT1_2) {
        const cu = _dot(dir, F.u), cv = _dot(dir, F.v)
        return { face: lastFace, ox: k * Math.atan(cu / cc), oy: k * Math.atan(cv / cc) }
      }
    }
    let bf = 0, bd = -Infinity
    for (let i = 0; i < 6; i++) { const d = _dot(dir, FACE_FRAME[i].c); if (d > bd) { bd = d; bf = i } }
    lastFace = bf
    const F = FACE_FRAME[bf]
    const cc = _dot(dir, F.c), cu = _dot(dir, F.u), cv = _dot(dir, F.v)
    return { face: bf, ox: k * Math.atan(cu / cc), oy: k * Math.atan(cv / cc) }
  }
}

export function applyThermalErosion(heights, res, opts = {}) {
  const talusM = opts.talusM ?? 0.6
  const iterations = opts.iterations ?? 20
  const carryFrac = opts.carryFrac ?? 0.5
  const out = new Float32Array(heights)
  const scratch = new Float32Array(res * res)
  for (let iter = 0; iter < iterations; iter++) {
    scratch.set(out)
    for (let z = 0; z < res; z++) {
      for (let x = 0; x < res; x++) {
        const i = z * res + x
        const hi = scratch[i]
        let lowestJ = -1, lowestH = hi, lowestDist = 0
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dz === 0) continue
            const nx = x + dx, nz = z + dz
            if (nx < 0 || nx >= res || nz < 0 || nz >= res) continue
            const j = nz * res + nx
            const hj = scratch[j]
            if (hj < lowestH) { lowestH = hj; lowestJ = j; lowestDist = Math.sqrt(dx * dx + dz * dz) }
          }
        }
        if (lowestJ < 0) continue
        const drop = hi - lowestH
        if (drop <= talusM * lowestDist) continue
        const excess = drop - talusM * lowestDist
        const move = excess * carryFrac * 0.5
        out[i] -= move
        out[lowestJ] += move
      }
    }
  }
  return out
}

// Create the patch baker. opts: { radius, reliefScale, seed }. Returns
// { bakeTile, bakeTileAsync, dirToFace, res, planet } or NULL on any of several environment
// failures: no OffscreenCanvas (e.g. a plain Node worker with no GPU), no webgl2 context, missing
// EXT_color_buffer_float/OES_texture_float_linear, or an init throw (each logs a
// '[PatchBaker] unavailable: ...' warning naming the cause before returning null).
// CONSUMER CONTRACT: this null is NOT itself thrown/guarded further down the chain --
// createPatchHeightFn({baker: null, ...}) explicitly checks `if (!baker) return null` and
// itself returns null rather than throwing, so a caller that destructures its result
// (`const {heightFn} = createPatchHeightFn(...)`) WITHOUT checking for a null return will hit a
// generic "Cannot destructure property 'heightFn' of null" TypeError with no PatchBaker-specific
// context. Always check the createPatchBaker() result (or the createPatchHeightFn() result) for
// null before use; on GPU-less environments (most game servers), skip the fast-path baker
// entirely and use frame.groundHeightLocal / createHeightSampler's heightAt directly instead.
// bakeTile(face,ox,oy,l) -> Float32Array(res*res) of absolute composeHeight, or null.
export async function createPatchBaker(opts = {}) {
  const warn = (m) => { try { console.warn('[PatchBaker] unavailable: ' + m) } catch (_) {} }
  if (typeof OffscreenCanvas === 'undefined') { warn('no OffscreenCanvas (dedicated Node?)'); return null }
  let gl
  try {
    const oc = new OffscreenCanvas(8, 8)
    gl = oc.getContext('webgl2', { antialias: false, depth: false })
    if (!gl) { warn('no webgl2 context'); return null }
    if (!gl.getExtension('EXT_color_buffer_float') || !gl.getExtension('OES_texture_float_linear')) { warn('no float-buffer extensions'); return null }
  } catch (e) { warn('gl init threw: ' + (e && e.message)); return null }
  const _isNode = typeof process !== 'undefined' && process.versions?.node
  let initMapspinnerPlanet
  try { ({ initMapspinnerPlanet } = await import('./planet-orchestrator.js')) }
  catch (e) { warn('orchestrator import threw: ' + (e && e.message)); return null }
  let planet
  // bakeOnly: this second planet exists ONLY for the _HEIGHTBAKE_ program (bakeTile*/__thcBake*). gl-render
  // skips its terrain/water/sky/upscale programs, atmosphere LUT bakes, surface-texture decode and mesh
  // buffers for a bakeOnly instance -- none of them are reachable from the bake path. GLOBAL-WRITE ORDER:
  // both this init and a same-context render planet (client main thread: TerrainBackdrop.js inits the
  // render planet first, then this baker) assign the SAME globalThis.__thcBakeReadback/__thcEnsureBake/
  // __thcBakeIssueAsync/__thcBakePollAsync/__thcBakeFlush globals; the later init wins, i.e. THIS baker's
  // (unchanged behavior -- bakeTile/bakeTileAsync below read `g.__thc*` after this await, so they always
  // resolve to this instance's own bake context).
  try { planet = await initMapspinnerPlanet(gl, { radius: opts.radius, gridMeshSize: TD.gridMeshSize, reliefScale: opts.reliefScale, hpfSeed: opts.seed, bakeOnly: true }) }
  catch (e) { warn('initMapspinnerPlanet threw: ' + (e && e.message)); return null }
  // bakeTileReadback is exposed on self (window in worker) after init; ensure the bake program is built.
  const g = (typeof self !== 'undefined') ? self : (typeof window !== 'undefined' ? window : globalThis)
  if (typeof g.__thcEnsureBake === 'function') g.__thcEnsureBake()
  // the bake program compiles lazily on the first bakeTileReadback; poll briefly for it to appear.
  for (let k = 0; k < 20 && typeof g.__thcBakeReadback !== 'function'; k++) await new Promise(r => setTimeout(r, 100))
  if (typeof g.__thcBakeReadback !== 'function') { warn('__thcBakeReadback never appeared after init'); return null }
  // give the lazy bake-program build a moment (it compiles the _HEIGHTBAKE_ shader on first call).
  await new Promise(r => setTimeout(r, 200))
  let res = 130
  // bakeTile: SYNCHRONOUS, blocking (bounded retry). Use for physics-collider-prep callers that need a
  // resolved height NOW and cannot tolerate a stale/fallback value -- e.g. the server/host authoritative
  // collider build, where a wrong or missing patch would desync physics for every connected player.
  function bakeTile(face, ox, oy, l, level = 0) {
    for (let k = 0; k < 12; k++) {
      const r = g.__thcBakeReadback(face | 0, ox, oy, l, level)
      if (r && r.heights) {
        res = r.res
        return opts.erosion ? applyThermalErosion(r.heights, r.res, opts.erosion === true ? {} : opts.erosion) : r.heights
      }
    }
    return null
  }
  // bakeTileAsync: TRULY NON-BLOCKING (2026-07-02, evidence-driven -- a live stack-trace CDP profile
  // showed getBufferSubData, the harvest inside __thcBakeReadback, as the #1 measured cost even on THIS
  // caller, because the prior version still called the same synchronous readback -- only the outer retry
  // loop was removed, the inner bounded-spin-then-block harvest was not). Now issues via
  // __thcBakeIssueAsync (draw + PBO read + fence, returns immediately, ZERO wait) and polls via
  // __thcBakePollAsync (non-blocking clientWaitSync timeout 0) on each call -- first call for a tile
  // issues the bake and returns null (caller's fallbackFn covers this frame); a LATER call for the same
  // tile (once the fence has signaled, no CPU stall to check) harvests and returns the real heights.
  // Falls back to the old one-shot synchronous __thcBakeReadback if the async pair isn't exposed (an
  // older gl-render.js build without them) so this stays forward-compatible.
  //
  // SLOT RING (2026-07-03, ms-async-bake-slot-ring): __thcBakeIssueAsync now backs onto a small ring of
  // N independent GPU slots (gl-render.js) instead of one -- prefetchAround below issues up to 8 neighbor
  // bakes per call, and with only one slot every issue() after the first was a silent no-op (7 of 8
  // prefetch requests dropped every time anything was already in flight). _asyncInFlight tracks EVERY key
  // this caller has an outstanding issue() for (was a single _asyncTileKey), so bakeTileAsync knows not to
  // re-issue a key that's already occupying one of the ring's slots, and drains the ring on every call
  // (not just once) since several neighbor bakes can complete in the same tick.
  const _asyncInFlight = new Set()
  const _asyncDone = new Map()   // key -> heights, for a completed bake that belongs to a DIFFERENT call than the one that harvested it
  const _ASYNC_DONE_MAX = 8      // small: bridges the one-call-behind race, not a real cache (createPatchHeightFn owns the real LRU)
  // deferFlush (prefetchAround only): skip the per-issue gl.flush() inside __thcBakeIssueAsync and let the
  // caller issue ONE __thcBakeFlush() after the whole burst -- same GPU work, one command-buffer submit
  // instead of up to 8. A lone bakeTileAsync (heightFn miss) keeps the immediate flush so its fence can
  // signal by the next frame exactly as before.
  function bakeTileAsync(face, ox, oy, l, level = 0, deferFlush = false) {
    if (typeof g.__thcBakeIssueAsync !== 'function' || typeof g.__thcBakePollAsync !== 'function') {
      const r = g.__thcBakeReadback(face | 0, ox, oy, l, level)
      if (r && r.heights) { res = r.res; return r.heights }
      return null
    }
    const key = face + ':' + ox + ':' + oy + ':' + l + ':' + level
    if (_asyncDone.has(key)) { const h = _asyncDone.get(key); _asyncDone.delete(key); return h }   // a prior call already harvested this exact tile
    // Harvest: drain every slot that has completed since the last call (non-blocking per slot; the ring
    // may hold several finished bakes at once when prefetchAround issued a batch last frame).
    let result = null
    for (let guard = 0; guard < 8; guard++) {   // bounded: never more completions than slots exist
      const done = g.__thcBakePollAsync()
      if (!done) break
      res = done.res
      const doneKey = done.face + ':' + done.ox + ':' + done.oy + ':' + done.l + ':' + done.level
      _asyncInFlight.delete(doneKey)
      if (doneKey === key) { result = done.heights; continue }   // this call's own tile finished -- keep draining the rest, return it below
      // A DIFFERENT tile finished than the one THIS call wants (the caller moved on since issuing it, or
      // it was a prefetchAround neighbor). Stash it rather than discard the completed GPU work -- the
      // tile that requested it will very likely be re-queried again soon (patch-span-sized cells,
      // revisited on the next lookup in that area) and will hit the stash above instead of re-issuing.
      _asyncDone.set(doneKey, done.heights)
      if (_asyncDone.size > _ASYNC_DONE_MAX) _asyncDone.delete(_asyncDone.keys().next().value)
    }
    if (result) {
      // prefetch context (deferFlush): the caller discards return values, so a harvested own-key tile
      // would be thrown away and re-baked on the next heightFn miss -- stash it for that lookup instead.
      if (deferFlush) { _asyncDone.set(key, result); if (_asyncDone.size > _ASYNC_DONE_MAX) _asyncDone.delete(_asyncDone.keys().next().value); return null }
      return result
    }
    if (!_asyncInFlight.has(key)) { if (g.__thcBakeIssueAsync(face | 0, ox, oy, l, level, deferFlush)) { _asyncInFlight.add(key); return deferFlush ? false : null } }
    return null
  }
  // one flush for a whole prefetch burst (see bakeTileAsync's deferFlush); no-op on an older gl-render.js
  function flushBakes() { if (typeof g.__thcBakeFlush === 'function') g.__thcBakeFlush() }
  // Per-baker memoized dirToFace (see makeDirToFaceMemo above) -- the placement/collision hot path
  // calls this every heightFn/prefetchAround lookup with coherent (nearby) dir vectors.
  const _dirToFaceMemo = makeDirToFaceMemo(opts.radius)
  return { bakeTile, bakeTileAsync, flushBakes, dirToFace: _dirToFaceMemo, res, planet }
}

// Build a groundHeightLocal-compatible O(1) patch lookup over a baker, matching the FINEST display LOD
// density (no reduction). Shared by the server collider (TerrainPhysics) AND the client placement frame
// (veg/grass/rock) so BOTH derive height from the identical GPU bake -> byte-identical placement parity,
// and the per-candidate fractal (~0.4ms) becomes a per-chunk-amortized patch lookup. frame supplies
// radius/anchorHeight/localToDir; tcfg supplies maxLevel/offsetY. Returns null if no baker.
// fallbackFn(x,z) is used when a patch bake transiently fails (keeps determinism on a miss).
//
// blocking (default true): the server/host authoritative collider MUST resolve to the real GPU-baked
// height (never a stale/fallback value) since every connected player's physics derives from it -- keep
// the bounded-retry bakeTile() there. A CLIENT-side placement/render caller should pass blocking:false:
// veg/grass/rock placement is consumed at a distance/rate where a value resolved up to ~100 frames late
// is indistinguishable, so bakeTileAsync's one-shot non-retried attempt (cache hit -> instant, cache miss
// -> fallbackFn now, GPU bake completes in the background and the NEXT lookup at that cell hits cache)
// removes the retry-loop's busy-spin GL cost from the hot placement path entirely.
export function createPatchHeightFn({ baker, frame, maxLevel = TD.maxLevel, offsetY = 0, fallbackFn, blocking = true }) {
  if (!baker) return null
  const R = frame.radius, aH = frame.anchorHeight, res = baker.res, gridMeshSize = TD.gridMeshSize
  const finestLeaf = 2 * R / Math.pow(2, maxLevel)
  const visualSpacing = finestLeaf / (gridMeshSize - 1)
  const patchSpan = Math.max(8, visualSpacing * (res - 1))
  // MAX 384 (up from 96, ~2026-07-02 fps-drop investigation): a synchronous readPixels-bound cache MISS
  // is the dominant frame cost (profiled ~3.3ms/frame, 48% of the 144Hz budget) -- during sustained
  // movement (not a static profile snapshot) the player continuously enters new patch cells, evicting
  // recently-baked neighbors from a too-small LRU before they're revisited, forcing needless re-bakes.
  // 384 entries * ~67KB/patch (130^2 float32) = ~25MB, trivial against a modern GPU/heap budget, and
  // covers a much larger contiguous streamed area before any eviction -- correctness unchanged (still an
  // exact re-bake of the SAME deterministic GPU shader on a miss, just fewer misses).
  // DECISION (ms-client-patchcache-quant, considered + declined): a sector-quantized u16+per-patch-
  // min/max encoding (mirroring heightfield-codec.js's already-shipped sector-quant pattern) would
  // shrink this cache from ~25MB (384 * 130^2 float32) to ~13MB. Declined for three compounding reasons:
  // (1) heightFn (below) is the hottest call in the whole terrain pipeline -- 5 taps/candidate x 3
  //     placement modules (veg/rock/grass) plus every server collider query -- and its bilinear read
  //     already does 4 array reads + lerp math per call; quantized storage adds a dequant (2 FMA/corner,
  //     8 extra flops/call) to EVERY read, which is precisely the fast-synchronous-lookup cost this cache
  //     exists to avoid paying (the reason `createPatchHeightFn` exists at all is to replace a per-call
  //     ~0.4ms CPU fractal with an O(1) lookup -- shaving allocation at the cost of slowing every lookup
  //     works against that goal).
  // (2) `cache`/`patchFor`/`heightFn` below are SHARED verbatim by the server-authoritative blocking path
  //     (`blocking:true`, exact-float32-required for collider parity) and the client non-blocking path --
  //     scoping quantization to "client only" would mean forking this cache/heightFn into two code paths
  //     (or branching on `blocking` inside the hottest function), a real complexity/maintenance cost for
  //     a 12MB saving against a heap budget where 25MB is already "trivial" per the MAX=384 comment above.
  // (3) heightfield-codec.js's sector format (JSON header + per-sector min/max over a whole serialized
  //     grid) is shaped for a monolithic on-disk/network artifact, not a per-tile (130x130) in-memory
  //     cache entry -- reusing it here is not a drop-in, it is a from-scratch bespoke reimplementation of
  //     the same idea at a different granularity, i.e. sub-item (2) plus new code with no shared tests.
  // Net: the CPU-cost-per-read regression on the hottest lookup path outweighs the memory win. Declined.
  const cache = new Map(); const MAX = 384
  const _bakeFn = blocking ? baker.bakeTile : (baker.bakeTileAsync || baker.bakeTile)   // non-blocking callers fall back to bakeTile if an older baker lacks the async variant
  // Packed-integer patch key (perf 2026-07-03): was a string concat (`face:pi:pj`) per lookup. face is
  // 0-5; pi/pj = floor(ox/patchSpan), and ox spans the whole +-2R atan-warped face extent, so the worst
  // case (patchSpan floor-clamped to its minimum of 8) is |pi| <= 4R/8 = R/2 -- for Earth-scale R=6.36e6
  // that's ~3.18M. PKEY_BIG=2^23 (8388608) gives an offset of 2^22 (~4.19M), safely above that bound
  // with margin, while (face*BIG+pj)*BIG+pi stays a safe integer (<2^53, verified max ~4.2e14) even at
  // face=5 and both indices maxed. A radius/patchSpan combination exceeding this (sub-4m patches at
  // Earth scale) is far outside any realistic config; patchSpan is visualSpacing*(res-1) with res=130,
  // so a sub-4m patchSpan would need sub-3cm visual leaf spacing, never a real configuration.
  const PKEY_BIG = 1 << 23, PKEY_OFF = PKEY_BIG >> 1
  const _patchKey = (face, pi, pj) => (face * PKEY_BIG + (pj + PKEY_OFF)) * PKEY_BIG + (pi + PKEY_OFF)
  // LAST-PATCH MEMO: the placement/collision caller sweeps coherently (continuous movement, or the
  // ~1.5m 5-tap finite-difference pattern) so consecutive lookups overwhelmingly land in the SAME patch
  // cell. Cache the last resolved {face,pi,pj,patch} and, before building the packed key + hitting the
  // Map, cheaply check plain integer equality against the cached pi/pj/face -- exact (pi/pj/face are
  // always freshly and fully computed from the real ox/oy first), zero risk of a stale/wrong hit.
  let _lastFace = -1, _lastPi = 0, _lastPj = 0, _lastPatch = null
  function patchFor(face, ox, oy) {
    const pi = Math.floor(ox / patchSpan), pj = Math.floor(oy / patchSpan)
    if (_lastPatch !== null && face === _lastFace && pi === _lastPi && pj === _lastPj) return _lastPatch
    const key = _patchKey(face, pi, pj)
    let p = cache.get(key)
    if (!p) {
      const heights = _bakeFn(face, pi * patchSpan, pj * patchSpan, patchSpan, 0)
      if (!heights) return null
      p = { heights, ox: pi * patchSpan, oy: pj * patchSpan }
      cache.set(key, p); if (cache.size > MAX) cache.delete(cache.keys().next().value)
    }
    _lastFace = face; _lastPi = pi; _lastPj = pj; _lastPatch = p
    return p
  }
  // heightFnOrNull: heightFn WITHOUT the fallback -- returns null on a patch-cache miss instead of running
  // the CPU fractal (~0.4ms). For a per-frame consumer that can reuse its previous value across the few
  // miss frames of a freshly-entered cell (TerrainBackdrop.js's surfElev), never for placement/collision.
  function heightFnOrNull(x, z) {
    const d = frame.localToDir(x, z)
    const { face, ox, oy } = baker.dirToFace(d)
    const p = patchFor(face, ox, oy)
    if (!p) return null
    return _sampleAbs(p, x, z, ox, oy)
  }
  function _sampleAbs(p, x, z, ox, oy) {
    const fx = (ox - p.ox) / patchSpan * (res - 1), fy = (oy - p.oy) / patchSpan * (res - 1)
    const ix = Math.max(0, Math.min(res - 2, Math.floor(fx))), iz = Math.max(0, Math.min(res - 2, Math.floor(fy)))
    const tx = fx - ix, tz = fy - iz, h = p.heights
    const h00 = h[iz * res + ix], h10 = h[iz * res + ix + 1], h01 = h[(iz + 1) * res + ix], h11 = h[(iz + 1) * res + ix + 1]
    const abs = (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz
    const r2 = x * x + z * z, s = r2 / (R * R), sq = Math.sqrt(1 + s), drop = r2 / R / ((sq + 1) * sq)
    return (abs - aH) - drop + offsetY
  }
  function heightFn(x, z) {
    const d = frame.localToDir(x, z)
    const { face, ox, oy } = baker.dirToFace(d)
    const p = patchFor(face, ox, oy)
    if (!p) return fallbackFn ? fallbackFn(x, z) : frame.groundHeightLocal(x, z)
    const fx = (ox - p.ox) / patchSpan * (res - 1), fy = (oy - p.oy) / patchSpan * (res - 1)
    const ix = Math.max(0, Math.min(res - 2, Math.floor(fx))), iz = Math.max(0, Math.min(res - 2, Math.floor(fy)))
    const tx = fx - ix, tz = fy - iz, h = p.heights
    const h00 = h[iz * res + ix], h10 = h[iz * res + ix + 1], h01 = h[(iz + 1) * res + ix], h11 = h[(iz + 1) * res + ix + 1]
    const abs = (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz
    const r2 = x * x + z * z, s = r2 / (R * R), sq = Math.sqrt(1 + s), drop = r2 / R / ((sq + 1) * sq)
    return (abs - aH) - drop + offsetY
  }
  // PREFETCH (2026-07-02, non-blocking-fallback follow-up): heightFn's non-blocking bakeTileAsync path
  // always misses (falls back to the CPU fractal) the FIRST time a patch cell is entered, since the bake
  // is only ISSUED on that call and harvested on a later one. During sustained movement the player keeps
  // entering never-before-seen cells, so misses recur continuously rather than being a one-time cost.
  // prefetchAround(x,z) issues bakes for the 3x3 patch neighborhood around a position (skipping the
  // center cell, which heightFn's own call already covers) BEFORE the player's next placement/render
  // lookup needs them -- call once per frame from the moving entity's (or camera's) position. Each issue
  // is a single bakeTileAsync call (immediate return, no wait); a cell already cached is skipped, and
  // re-issuing an already-in-flight cell is a no-op against _asyncInFlight (cheap, not wrong). With the
  // gl-render.js slot-ring backing __thcBakeIssueAsync (ms-async-bake-slot-ring, 2026-07-03), up to
  // BAKE_ASYNC_SLOTS of these 8 neighbor requests actually land concurrently instead of only the most
  // recent one surviving -- once the ring is full, further issues in this same call return false from
  // __thcBakeIssueAsync and bakeTileAsync simply does not add them to _asyncInFlight, so they are retried
  // on a later prefetchAround call once a slot frees up. blocking:true bakers (server/host collider) never
  // need this -- prefetch only pays off the async miss cost, which only exists on the non-blocking path.
  function prefetchAround(x, z) {
    const d = frame.localToDir(x, z)
    const { face, ox, oy } = baker.dirToFace(d)
    const pi0 = Math.floor(ox / patchSpan), pj0 = Math.floor(oy / patchSpan)
    let issued = 0
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue
        const pi = pi0 + di, pj = pj0 + dj
        const key = _patchKey(face, pi, pj)
        if (cache.has(key)) continue
        // deferFlush=true: bakeTileAsync returns `false` (not null) when it ISSUED a deferred bake
        if (typeof baker.bakeTileAsync === 'function' && baker.bakeTileAsync(face, pi * patchSpan, pj * patchSpan, patchSpan, 0, true) === false) issued++
      }
    }
    // ONE gl.flush() per prefetch burst (was one per issued bake, up to 8 per call)
    if (issued > 0 && typeof baker.flushBakes === 'function') baker.flushBakes()
  }
  return { heightFn, heightFnOrNull, prefetchAround, patchSpan, res, spacing: visualSpacing, maxLevel }
}
