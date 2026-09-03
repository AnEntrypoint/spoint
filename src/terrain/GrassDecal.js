// Sparse per-cell burn/flatten DECAL scalar field for grass -- permanent/semi-permanent world-state
// (explosion craters, vehicle tracks, fire scorch) as distinct from Grass.js's existing player-bend
// uniform system (uBenderPosXZ etc, see the "Bend grass around nearby players/actors" commit), which
// is a TRANSIENT per-frame displacement fed fresh every frame from live player/actor positions and
// carries no persisted state at all. This module mirrors HeightDelta.js's sparse quantized-cell Map
// pattern (same accumulate-with-falloff shape, same toJSON/load round-trip contract) but stores a
// dimensionless 0..1 "scorch" scalar per cell instead of a metre height offset.
//
// Coordinate space: LOCAL planet-frame XZ world metres -- the same authoritative (unshifted) space
// Grass.js's blade instanceMatrix positions live in (see RenderGraph.nodes.js's bender-buffer comment
// for why: the floating-origin rebase only ever translates the InstancedMesh2 root, never the
// per-instance transforms, so any world-space buffer fed to the vertex shader must already be in that
// same authoritative space or it silently desyncs after the first rebase).
//
// Storage: sparse Map of quantized grid cells (CELL_M metres/cell) -> accumulated scorch value
// (0=untouched .. 1=fully scorched/flattened), written via markScorched's cosine falloff stamp,
// clamped to 1 per cell (repeated overlapping stamps saturate rather than exceed full effect).
//
// Regrowth: each stamp decays exponentially toward 0 based on wall-clock elapsed time since it was
// applied (half-life based, see DEFAULT_HALF_LIFE_S below) -- the store is now a function of applied
// stamps AND elapsed time, not a pure function of stamps alone. A stamp's EFFECTIVE strength at query
// time is `strength * 0.5^(elapsedS / halfLifeS)`; the store re-derives the accumulated `cells` Map from
// every still-live stamp's CURRENT effective strength (not the peak-at-application-time value) whenever
// decay has progressed enough to matter, so sampleAt/nearestStamps/the vertex-shader uniform feed all
// see the same decayed picture. A stamp whose effective strength drops below PRUNE_EPS is dropped
// entirely (garbage-collected out of `appliedStamps`/`cells`) so a long-lived world doesn't accumulate an
// ever-growing list of fully-healed-but-still-tracked stamps.

export const DECAL_CELL_M = 2 // coarser than HeightDelta's 1m: grass decals are visual-only (no collider precision needed), and Grass.js's own placement CELL is 2m (GRASS.CELL), so this matches blade density granularity.
export const DEFAULT_HALF_LIFE_S = 120 // real wall-clock seconds for a decal's strength to halve; a full scorch (strength=1) reads ~0.06 after 5 half-lives (~10min) and is pruned below PRUNE_EPS well before that.
const PRUNE_EPS = 0.02 // below this effective strength a stamp is visually indistinguishable from untouched grass (cosine falloff further attenuates it toward the edges) -- prune rather than carry dead weight forever.

function cellKey(cx, cz) {
  // packed integer key, same PKEY_BIG-style pattern as HeightDelta.js/patch-baker.js: supports
  // +-4M cells (+-8,000,000m at CELL_M=2) per axis before collision.
  const BIG = 1 << 23, OFF = BIG >> 1
  return (cx + OFF) * BIG + (cz + OFF)
}

// Creates an empty decal store. `stamps` (optional) seeds it from a previously-serialized toJSON()
// payload -- an array of {x,z,radius,strength,appliedAt} scorch stamps replayed in order (NOT the
// flattened cell map itself), same exactness-regardless-of-CELL_M-changing contract as
// HeightDelta.loadHeightDelta. `opts.halfLifeS` (default DEFAULT_HALF_LIFE_S) sets the regrowth rate;
// `opts.now` (default Date.now) is an injectable clock for deterministic live-witness testing.
export function createGrassDecal(stamps, opts) {
  const halfLifeS = (opts && Number.isFinite(opts.halfLifeS) && opts.halfLifeS > 0) ? opts.halfLifeS : DEFAULT_HALF_LIFE_S
  const now = (opts && typeof opts.now === 'function') ? opts.now : Date.now
  const cells = new Map() // cellKey -> DECAYED scorch value 0..1 at that cell's center, as of the last rebuildCells() call
  const appliedStamps = [] // {x,z,radius,strength,appliedAt} -- strength is the PEAK (at-application-time) value; effective() derives the live decayed value
  let version = 0 // bumped on every mutation (apply, decay-driven prune/rebuild) so callers (Grass.js) can cheaply detect "did anything change"
  let cellsBuiltAt = -Infinity // now() timestamp cells[] was last rebuilt from appliedStamps -- rebuildCells() is O(stampCount * radius^2 cells), skip re-deriving on every read

  function cellCenter(cx, cz) { return [cx * DECAL_CELL_M + DECAL_CELL_M * 0.5, cz * DECAL_CELL_M + DECAL_CELL_M * 0.5] }

  // Effective (decayed) strength of a stamp at time `t` (ms epoch, same clock as appliedAt). Exponential
  // half-life decay: halves every halfLifeS seconds since the stamp was applied. halfLifeS<=0 (or
  // Infinity) is nonsensical for decay math but never reached (constructor clamps), so this is always a
  // real >0 divisor.
  function effectiveStrength(s, t) {
    const elapsedS = Math.max(0, (t - s.appliedAt) / 1000)
    return s.strength * Math.pow(0.5, elapsedS / halfLifeS)
  }

  // Drops any stamp whose effective strength at time `t` is below PRUNE_EPS, then re-accumulates `cells`
  // from the survivors' CURRENT decayed strengths (same cosine-falloff stamp math as markScorched, just
  // replayed with today's strength instead of the peak). Returns true if anything actually changed
  // (pruned a stamp or the cell values moved enough to matter) so callers can gate a version bump /
  // uniform refresh on real change rather than unconditionally.
  function rebuildCells(t) {
    let changed = false
    for (let i = appliedStamps.length - 1; i >= 0; i--) {
      if (effectiveStrength(appliedStamps[i], t) < PRUNE_EPS) { appliedStamps.splice(i, 1); changed = true }
    }
    cells.clear()
    for (const s of appliedStamps) {
      const eff = effectiveStrength(s, t)
      const cx0 = Math.floor((s.x - s.radius) / DECAL_CELL_M), cx1 = Math.ceil((s.x + s.radius) / DECAL_CELL_M)
      const cz0 = Math.floor((s.z - s.radius) / DECAL_CELL_M), cz1 = Math.ceil((s.z + s.radius) / DECAL_CELL_M)
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const [ccx, ccz] = cellCenter(cx, cz)
          const dx = ccx - s.x, dz = ccz - s.z
          const d = Math.hypot(dx, dz)
          if (d > s.radius) continue
          const falloff = 0.5 * (1 + Math.cos((d / s.radius) * Math.PI))
          const key = cellKey(cx, cz)
          const prev = cells.get(key) || 0
          const next = prev + eff * falloff
          cells.set(key, next > 1 ? 1 : next)
        }
      }
    }
    cellsBuiltAt = t
    if (changed) version++
    return changed
  }

  // Re-derives `cells` from the current clock if enough real time has passed since the last rebuild to
  // move a decayed value meaningfully (guards against O(stampCount*area) work every single call when
  // decay is slow relative to call frequency). `minIntervalS` (default 1s) is deliberately coarse --
  // regrowth is a multi-minute process, sub-second precision buys nothing visually.
  function tick(minIntervalS) {
    const t = now()
    const interval = Number.isFinite(minIntervalS) && minIntervalS > 0 ? minIntervalS : 1
    if (appliedStamps.length > 0 && (t - cellsBuiltAt) / 1000 >= interval) return rebuildCells(t)
    return false
  }

  // Stamp a scorch/flatten decal centered at local (x,z), radius metres, peak scorch `strength` (0..1,
  // defaults to 1 = fully scorched) at the center falling to 0 at the edge via the same smooth cosine
  // falloff HeightDelta.applyRaiseBrush uses. Accumulates additively (clamped to 1) onto any existing
  // (decayed) scorch at each touched cell so overlapping strokes (e.g. a spreading fire) saturate rather
  // than fight each other -- a fresh stamp always starts its OWN decay clock from now(), independent of
  // any older overlapping stamp's remaining life.
  function markScorched(x, z, radius, strength) {
    const s = Number.isFinite(strength) ? strength : 1
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius <= 0 || s === 0) return { touched: 0 }
    const t = now()
    rebuildCells(t) // decay existing stamps up to "now" first so the accumulate-and-clamp below saturates against today's values, not stale peaks
    const cx0 = Math.floor((x - radius) / DECAL_CELL_M), cx1 = Math.ceil((x + radius) / DECAL_CELL_M)
    const cz0 = Math.floor((z - radius) / DECAL_CELL_M), cz1 = Math.ceil((z + radius) / DECAL_CELL_M)
    let touched = 0
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const [ccx, ccz] = cellCenter(cx, cz)
        const dx = ccx - x, dz = ccz - z
        const d = Math.hypot(dx, dz)
        if (d > radius) continue
        touched++
      }
    }
    appliedStamps.push({ x, z, radius, strength: s, appliedAt: t })
    rebuildCells(t)
    version++
    // appliedAt returned alongside touched (additive, backward-compatible -- existing callers destructure
    // {touched} only) so a server-authoritative caller (src/sdk/EditorHandlers.js's GRASS_DECAL_STAMP
    // handler) can broadcast the EXACT timestamp this stamp's decay clock started from, letting every
    // client seed its own local store (via _seedStamp) with an identical clock rather than re-deriving a
    // slightly-different one from its own now() at receive time.
    return { touched, appliedAt: t }
  }

  // Bilinear read of the DECAYED sparse scorch grid at local (x,z), 0..1, as of right now. Cells never
  // stamped (or fully regrown) read as 0 (no decal = untouched grass there), safe to consume
  // unconditionally.
  function sampleAt(x, z) {
    tick()
    if (cells.size === 0) return 0
    const fx = x / DECAL_CELL_M, fz = z / DECAL_CELL_M
    const ix = Math.floor(fx), iz = Math.floor(fz)
    const tx = fx - ix, tz = fz - iz
    const h00 = cells.get(cellKey(ix, iz)) || 0
    const h10 = cells.get(cellKey(ix + 1, iz)) || 0
    const h01 = cells.get(cellKey(ix, iz + 1)) || 0
    const h11 = cells.get(cellKey(ix + 1, iz + 1)) || 0
    if (h00 === 0 && h10 === 0 && h01 === 0 && h11 === 0) return 0
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz
  }

  // Returns the up-to-`max` decal STAMPS (not raw cells -- one entry per surviving markScorched call, the
  // same shape the vertex-shader uniform buffer wants: {x,z,radius,strength}, with `strength` being the
  // CURRENT decayed effective value, not the original peak) nearest to (px,pz), sorted closest-first.
  // Mirrors Grass.js's own setBenders distance-filter-and-cap discipline so the caller (Grass.js's
  // per-frame update) can feed a small fixed-size uniform array without this module needing to know about
  // GPU uniform layout at all. Unbounded stamp count is fine to scan here (real-world decal counts --
  // explosion craters, tracks -- are orders of magnitude below live actor counts), but still O(n) so
  // callers should not call this every frame if the store hasn't changed (see `version`).
  function nearestStamps(px, pz, max, radius) {
    tick()
    if (appliedStamps.length === 0) return []
    const t = now()
    const r2 = Number.isFinite(radius) ? radius * radius : Infinity
    const withDist = []
    for (const s of appliedStamps) {
      const dx = s.x - px, dz = s.z - pz
      const distSq = dx * dx + dz * dz
      if (distSq > r2) continue
      withDist.push({ s: { x: s.x, z: s.z, radius: s.radius, strength: effectiveStrength(s, t) }, distSq })
    }
    withDist.sort((a, b) => a.distSq - b.distSq)
    const cap = Number.isFinite(max) ? max : withDist.length
    return withDist.slice(0, cap).map(w => w.s)
  }

  // Serializes the RAW (peak strength + appliedAt) stamps, not the decayed view -- loadGrassDecal replays
  // them through markScorched-equivalent seeding below, and effectiveStrength() re-derives the correct
  // decayed value at load time from the real elapsed wall-clock time (so a world reloaded a day later
  // correctly shows the decals as further regrown, not frozen at save-time strength).
  function toJSON() { return { version: 2, cellM: DECAL_CELL_M, halfLifeS, stamps: appliedStamps.map(s => ({ x: s.x, z: s.z, radius: s.radius, strength: s.strength, appliedAt: s.appliedAt })) } }

  function clear() { cells.clear(); appliedStamps.length = 0; cellsBuiltAt = -Infinity; version++ }

  // Internal seeding hook for loadGrassDecal: pushes a stamp with an EXPLICIT appliedAt (preserving its
  // original decay clock, unlike markScorched which always stamps `now()`) without rebuilding cells --
  // the caller rebuilds once after seeding every stamp, not once per stamp, since a saved world can carry
  // many decals. `appliedAt` missing/non-finite (old pre-regrowth save format, version:1) falls back to
  // `now()` -- a decal saved before this feature existed starts its decay clock fresh on first load
  // rather than crashing on undefined arithmetic.
  function _seedStamp(x, z, radius, strength, appliedAt) {
    const s = Number.isFinite(strength) ? strength : 1
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius <= 0 || s === 0) return
    appliedStamps.push({ x, z, radius, strength: s, appliedAt: Number.isFinite(appliedAt) ? appliedAt : now() })
    version++
  }

  return {
    markScorched, sampleAt, nearestStamps, toJSON, clear, tick, _seedStamp,
    get cellCount() { return cells.size },
    get stampCount() { return appliedStamps.length },
    get version() { return version },
    get halfLifeS() { return halfLifeS },
  }
}

// Rebuild a GrassDecal from a previously-serialized toJSON() payload by seeding its stamps in order --
// exact regardless of DECAL_CELL_M ever changing between the versions that wrote/read it. Uses the
// internal _seedStamp hook (not markScorched) so each stamp's ORIGINAL appliedAt timestamp survives the
// round-trip -- a decal saved 10 minutes ago and reloaded now correctly shows ~10 minutes of regrowth
// already applied, rather than every saved decal resetting to full strength on load (which would make
// regrowth invisible across a save/reload cycle, defeating the whole feature). `json.halfLifeS` (from a
// version:2 payload) is honored if present so a world's saved regrowth RATE survives too; `opts` still
// lets a caller override either explicitly.
export function loadGrassDecal(json, opts) {
  const halfLifeS = (opts && Number.isFinite(opts.halfLifeS)) ? opts.halfLifeS : (json && Number.isFinite(json.halfLifeS) ? json.halfLifeS : undefined)
  const gd = createGrassDecal(null, { ...(opts || {}), halfLifeS })
  if (json && Array.isArray(json.stamps)) {
    for (const s of json.stamps) {
      if (s && Number.isFinite(s.x) && Number.isFinite(s.z) && Number.isFinite(s.radius)) {
        gd._seedStamp(s.x, s.z, s.radius, s.strength, s.appliedAt)
      }
    }
    gd.tick(0) // force an immediate rebuildCells so cellCount/sampleAt are correct before the first natural tick interval elapses, and prune anything already fully regrown since it was saved
  }
  return gd
}
