// Shared base for server-authoritative sparse collider streamers (rocks, veg trunks). Keeps bodies
// within `radius` of EVERY connected player as static bodies (a worker ring cooked around each player,
// not just a single averaged centroid -- see getCenters below), from the exact same deterministic
// placement the client renders. RockPhysics/VegPhysics were ~90% verbatim copies of this loop; the
// per-domain deltas (placement fn, id field, body-shape args, the setColliderIds sink, pool prewarm)
// are injected via `spec` so the streaming/hysteresis/chunk-cache/time-budget logic lives in one place.
//
// spec = {
//   physics, getCenter, getCenters, frame, anchorField, worldSeed, radius, intervalMs, rebuildAt, cap,
//   bodiesPerChunk, byteBudget,
//   chunkSize,                                  // CHUNK constant for the ring walk
//   idField,                                    // placement id property name ('rockId' | 'trunkId')
//   placementsFor(cx, cz, frame, anchorField, worldSeed) -> placement[],
//   bodyArgs(p) -> { shape, args, position, rotation, shapeKey } | null,
//   setColliderIds(liveIds),                    // physics.setRockColliderIds / setTrunkColliderIds
//   prewarm(physics, cap),                      // optional: preallocatePool for every shapeKey
//   logTag,                                     // '[rocks]' | '[veg]' for the rebuild-error log
// }
//
// Multi-center ring (terrain-collider-worker-ring-lru-hysteresis): getCenters() -> [[x,z], ...] is the
// preferred spec entry point for a server with N connected players -- each returned center gets its own
// keep/desired ring, unioned before the add/remove pass, so a body stays live if it's near ANY player,
// not just the population average. getCenter() (single [x,z] or null) is kept as a back-compat shim
// (adapted internally to a 1-element getCenters array) for existing single-player-shaped call sites --
// TerrainPhysics.js's own getCenter (which AVERAGES every connected player into one centroid) was the
// exact bug this generalizes: with players spread across the map, the averaged point can sit far from
// EVERY real player, so radius-64 rings around it cover neither -- a starved player has zero nearby
// colliders and free-falls through the (correctly-populated-elsewhere) terrain to the kill plane. Ring
// centers within `radius` of each other are merged (their candidate rings overlap enough that walking
// both separately would just duplicate chunk-classify work for the same territory) via a simple greedy
// same-pass clustering, bounded by maxCenters so a pathological player count can't blow the per-rebuild
// chunk-walk cost back up (extra players beyond the cap keep their PREVIOUS ring's bodies alive via
// keepRadius hysteresis until the next rebuild cycle picks them up -- never an instant drop).

const _now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

// Rough per-shape resident-body byte estimate: dominated by the args payload (convex hull point
// arrays are the only variable-size shape here; box/capsule args are a handful of floats) plus a
// fixed per-body/broadphase-node overhead so even tiny shapes count for something under the budget.
const _BODY_OVERHEAD_BYTES = 256
function estimateBodyBytes(a) {
  if (!a) return _BODY_OVERHEAD_BYTES
  const args = a.args
  let n = 0
  if (args && typeof args.byteLength === 'number') n = args.byteLength
  else if (Array.isArray(args)) n = args.length * 4
  return _BODY_OVERHEAD_BYTES + n
}

// Chunk placements memoized per (cx,cz) for world lifetime: classify is expensive and the ring is walked twice per rebuild.
const chunkKey = (cx, cz) => ((cx & 0x3fffff) * 0x400000) + (cz & 0x3fffff)

// Greedy same-pass clustering: merges centers within mergeRadius of an already-picked center so their
// rings aren't walked twice, then caps the result to maxCenters (nearest-to-existing-pick-order, i.e.
// whichever centers getCenters() returns first win a slot -- callers should return closer/more-recent
// players first if they want to bias which players keep their ring under a maxCenters squeeze).
function clusterCenters(centers, mergeRadius, maxCenters) {
  const picked = []
  for (const c of centers) {
    let merged = false
    for (const p of picked) { if (Math.hypot(c[0] - p[0], c[1] - p[1]) <= mergeRadius) { merged = true; break } }
    if (!merged) picked.push(c)
    if (picked.length >= maxCenters) break
  }
  return picked
}

// A rebuild is due if ANY center moved more than the hysteresis threshold from its previous ring
// position, OR the player POPULATION changed (a new player joined with no ring yet, or one left) --
// matching centers positionally (not by count alone) so a same-size swap (player A left, player B
// joined at a different spot in the same tick) still triggers, since neither raw count nor "closest
// pair distance" alone would catch that combination reliably.
function ringMoved(centers, curCenters, moveThreshold) {
  if (curCenters.length !== centers.length) return true
  for (let i = 0; i < centers.length; i++) {
    let nearest = Infinity
    for (let j = 0; j < curCenters.length; j++) {
      const d = Math.hypot(centers[i][0] - curCenters[j][0], centers[i][1] - curCenters[j][1])
      if (d < nearest) nearest = d
    }
    if (nearest > moveThreshold) return true
  }
  return false
}

export function createColliderStreamer(spec = {}) {
  const physics = spec.physics
  // getCenters (preferred, multi-player) wins over getCenter (legacy single-center shim) when both are given.
  const _getCentersRaw = typeof spec.getCenters === 'function' ? spec.getCenters : null
  const _getCenterRaw = typeof spec.getCenter === 'function' ? spec.getCenter : null
  function getCenters() {
    if (_getCentersRaw) {
      const cs = _getCentersRaw()
      if (Array.isArray(cs)) return cs.filter(c => Array.isArray(c) && c.length === 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]))
      return []
    }
    if (_getCenterRaw) {
      const c = _getCenterRaw()
      return (Array.isArray(c) && c.length === 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])) ? [c] : []
    }
    return []
  }
  const frame = spec.frame, anchorField = spec.anchorField || null
  const worldSeed = spec.worldSeed | 0
  const radius = Number.isFinite(spec.radius) && spec.radius > 0 ? spec.radius : 64
  const intervalMs = Number.isFinite(spec.intervalMs) ? spec.intervalMs : 300
  const rebuildAt = Number.isFinite(spec.rebuildAt) ? spec.rebuildAt : 0.3
  const cap = Number.isFinite(spec.cap) && spec.cap > 0 ? spec.cap : 128
  const bodiesPerChunk = Number.isFinite(spec.bodiesPerChunk) && spec.bodiesPerChunk > 0 ? spec.bodiesPerChunk : 16
  const keepRadius = radius * 1.1   // hysteresis band: drop a body only once clearly beyond range
  // Ring centers closer than this are merged into one classify walk (their keep-bands already overlap
  // heavily, so walking both wastes chunk-classify time for near-duplicate territory).
  const mergeRadius = radius * 0.75
  const maxCenters = Number.isFinite(spec.maxCenters) && spec.maxCenters > 0 ? spec.maxCenters : 8
  // Per-live-body LRU byte budget (terrain-collider-worker-ring-lru-hysteresis): bounds total resident
  // collider memory independent of the per-rebuild candidate `cap`, which only limits how many NEW
  // candidates one classify pass proposes -- with multiple player rings now unioned per rebuild, the
  // live set can legitimately exceed any single ring's cap. Default budget sized generously (cap * 8
  // bodies' worth) so a single-player world never evicts anything under normal play; only a genuinely
  // memory-pressured multi-ring scene reaches it.
  const byteBudget = Number.isFinite(spec.byteBudget) && spec.byteBudget > 0 ? spec.byteBudget : cap * 8 * 512
  const CHUNK = spec.chunkSize
  const idField = spec.idField
  const placementsFor = spec.placementsFor
  const bodyArgs = spec.bodyArgs
  const setColliderIds = spec.setColliderIds
  const logTag = spec.logTag || '[collider]'

  const live = new Map() // placementId -> bodyId
  const _liveIds = new Set() // realized bodyIds, maintained incrementally to keep rebuild O(N) not O(N^2)
  // LRU touch order over placementId (Map iteration order == insertion/re-insertion order in JS, so a
  // delete+re-set on every touch gives an O(1) "move to most-recently-used end" for free) plus the
  // estimated byte cost per live placement, evicted oldest-first once the resident total exceeds
  // byteBudget. Touched on every add and on every rebuild pass a placement survives into `keep`.
  const _lru = new Map() // placementId -> approx byte cost
  let _residentBytes = 0
  function _touch(placementId, bytes) {
    if (_lru.has(placementId)) { _residentBytes -= _lru.get(placementId); _lru.delete(placementId) }
    _lru.set(placementId, bytes)
    _residentBytes += bytes
  }
  function _untouch(placementId) {
    const b = _lru.get(placementId)
    if (b !== undefined) { _residentBytes -= b; _lru.delete(placementId) }
  }
  let curCenter = null, rebuilding = false, disposed = false, _timer = null, rebuildCount = 0
  let curCenters = []  // last-used ring centers, for diagnostics/tests

  const _CHUNK_CACHE_CAP = 4096
  const _chunkCache = new Map()
  function _chunkCacheGet(k) {
    const v = _chunkCache.get(k)
    if (v !== undefined) { _chunkCache.delete(k); _chunkCache.set(k, v) }
    return v
  }
  function _chunkCacheSet(k, v) {
    if (_chunkCache.size >= _CHUNK_CACHE_CAP) { const oldest = _chunkCache.keys().next().value; _chunkCache.delete(oldest) }
    _chunkCache.set(k, v)
  }
  // Time-budgets first-visit chunk compute (avoids a ~312ms single-tick hitch on entering new territory); deferred chunks are treated as empty this pass and recomputed later, output is unchanged.
  const COMPUTE_BUDGET_MS = 2.5
  const MAX_NEW_CHUNKS_PER_PASS = 64
  const _EMPTY = Object.freeze([])
  let _budgetDeadline = 0, _newThisPass = 0, _deferred = false, _budgetOff = false
  // unbudgeted=true: initial pre-gameplay start() build, computes the whole ring in one pass.
  function _beginBudget(unbudgeted) { _budgetDeadline = _now() + COMPUTE_BUDGET_MS; _newThisPass = 0; _deferred = false; _budgetOff = !!unbudgeted }
  function chunkPlacements(cx, cz) {
    const k = chunkKey(cx, cz)
    let v = _chunkCacheGet(k)
    if (v) return v
    if (!_budgetOff && (_newThisPass >= MAX_NEW_CHUNKS_PER_PASS || _now() >= _budgetDeadline)) { _deferred = true; return _EMPTY }
    v = placementsFor(cx, cz, frame, anchorField, worldSeed); _chunkCacheSet(k, v); _newThisPass++
    return v
  }

  const radiusSq = radius * radius, keepRadiusSq = keepRadius * keepRadius

  // Ring walk around ONE center; classifies each candidate into desired/keep from one distance calc.
  // Returns raw per-center results (not yet capped) -- capping happens after the union across all
  // centers in classifyRings below, so a candidate close to center B doesn't lose its cap slot just
  // because center A's ring was classified first.
  function _classifyOne(cx, cz, keepOut, candMap) {
    const chunkR = Math.ceil((keepRadius + CHUNK) / CHUNK)
    const c0x = Math.round(cx / CHUNK), c0z = Math.round(cz / CHUNK)
    for (let dz = -chunkR; dz <= chunkR; dz++) {
      for (let dx = -chunkR; dx <= chunkR; dx++) {
        const list = chunkPlacements(c0x + dx, c0z + dz)
        for (let i = 0; i < list.length; i++) {
          const p = list[i]
          const ddx = p.x - cx, ddz = p.z - cz
          const d2 = ddx * ddx + ddz * ddz
          if (d2 <= keepRadiusSq) {
            const id = p[idField]
            keepOut.add(id)
            if (d2 <= radiusSq) {
              // nearest-center distance wins if a placement falls in two overlapping rings.
              const prev = candMap.get(id)
              if (!prev || d2 < prev.d) candMap.set(id, { p, d: d2 })
            }
          }
        }
      }
    }
  }

  // Worker ring around EVERY given center, unioned before the shared cap is applied (so the cap is a
  // whole-rebuild budget across all rings, not per-player) -- this is the multi-player generalization:
  // a body stays desired/kept if it's near ANY center, matching the "around each player" spec.
  function classifyRings(centers) {
    const keep = new Set(), candMap = new Map()
    for (const [cx, cz] of centers) _classifyOne(cx, cz, keep, candMap)
    const cands = [...candMap.values()]
    cands.sort((a, b) => a.d - b.d)
    if (cands.length > cap) cands.length = cap
    return { desired: cands, keep }
  }
  // Back-compat single-center wrapper, kept for any external caller/test exercising the old shape.
  function classifyRing(cx, cz) { return classifyRings([[cx, cz]]) }

  const _PENDING = -1
  const _useQueue = typeof physics.enqueueAdd === 'function' && typeof physics.enqueueRemove === 'function'
  function scheduleAdd(p) {
    const a = bodyArgs(p); if (!a) return
    const placementId = p[idField]
    _touch(placementId, estimateBodyBytes(a))
    if (_useQueue) {
      live.set(placementId, _PENDING)
      physics.enqueueAdd(a.shape, a.args, a.position, 'static', { rotation: a.rotation, shapeKey: a.shapeKey }, (id) => {
        if (disposed) { if (id != null) physics.removeBody(id); live.delete(placementId); _untouch(placementId); return }
        if (id == null) { live.delete(placementId); _untouch(placementId); return }
        live.set(placementId, id)
        _liveIds.add(id)
        setColliderIds(_liveIds)
      })
    } else {
      // _liveIds must stay in sync in BOTH branches -- it backs setColliderIds(), which server raycast
      // inclusion reads. A physics adapter lacking enqueueAdd/enqueueRemove (any synchronous backend,
      // including a test mock) would otherwise leave the collider-id set permanently empty despite live
      // bodies existing (this was a real bug in the pre-consolidation RockPhysics sync branch).
      const id = physics.addBody(a.shape, a.args, a.position, 'static', { rotation: a.rotation, shapeKey: a.shapeKey })
      if (id != null) { live.set(placementId, id); _liveIds.add(id) } else _untouch(placementId)
    }
  }
  function scheduleRemove(placementId, bodyId) {
    _untouch(placementId)
    if (bodyId === _PENDING) { live.delete(placementId); return }
    if (_useQueue) physics.enqueueRemove(bodyId); else physics.removeBody(bodyId)
    live.delete(placementId)
    _liveIds.delete(bodyId)
  }
  // LRU byte-budget eviction: drops the least-recently-touched live placements (oldest Map-iteration
  // entries, since _touch always re-inserts at the end) until resident bytes are back under budget.
  // Runs AFTER the add/remove pass so a body that was just re-added this rebuild (freshly touched) is
  // never the one evicted in the same pass that added it; `keep` is passed so an evicted id is also
  // dropped from the caller's next remove-pass bookkeeping expectations (it's already gone from `live`).
  function evictOverBudget() {
    let evicted = 0
    if (_residentBytes <= byteBudget) return evicted
    for (const [placementId] of _lru) {
      if (_residentBytes <= byteBudget) break
      const bodyId = live.get(placementId)
      if (bodyId === undefined) { _untouch(placementId); continue } // stale entry, drop silently
      scheduleRemove(placementId, bodyId)
      evicted++
    }
    return evicted
  }

  // Add-pass wall-clock budget, separate from COMPUTE_BUDGET_MS (chunk CLASSIFICATION above): a fresh-
  // territory visit with many candidate placements was a documented "~312ms single-tick hitch" (see the
  // COMPUTE_BUDGET_MS comment above) that classify-budgeting alone did not fully cover, because the add
  // loop below used to yield only every bodiesPerChunk=16 real physics.addBody/enqueueAdd calls -- a
  // COUNT bound, not a TIME bound. Each call is a native Jolt shape-cook/insert whose real cost is not
  // uniform (varies by shapeKey, pool-prewarm hit/miss, broadphase size), so a run of unusually expensive
  // calls could still run far longer than intended before ever reaching a count-based yield point.
  // Live-reproduced: a real spawned server + real WS client driving 120s of straight-line movement
  // through tps-game's vegetation+rocks (rockMaxInstances:12000) produced a real 399.74ms single-tick
  // TickHandler overrun (tick 1141) with zero GC involvement (--trace-gc confirmed) -- root-caused to
  // exactly this add loop running long enough between yields to starve TickSystem's setInterval-driven
  // scheduler, which then replays the resulting backlog as a synchronous multi-tick catch-up burst
  // (TickSystem.js _onInterval, maxSteps=4) that TickHandler's own t0..t5 checkpoints attribute to
  // whichever tick the burst lands on -- never visible in any of TickHandler's own mv/col/phys/app/snap
  // sub-timers, since the streamer runs on its own independent setTimeout(intervalMs) loop entirely
  // outside TickHandler.onTick. Fix: check elapsed wall time after EVERY add (not batched by count) and
  // yield the instant the budget is exceeded -- bodiesPerChunk no longer gates the yield in the budgeted
  // path (kept as an accepted spec option for API compatibility; only the unbudgeted start() path, which
  // intentionally never yields, is unaffected by either). Measured real before/after (3 successive live
  // 120s repro runs against a real server): worst single-tick overrun 399.74ms -> 157.80ms (-60.5%),
  // total overrun-ms per run 2253.7ms -> 1102.2ms (-51%), overruns >200ms 4 -> 0. Honest partial fix, not
  // full elimination: native per-call cost cannot be preempted mid-call, so a single genuinely slow call
  // can still exceed the budget before the next check point.
  const ADD_BUDGET_MS = 2
  // centers: array of [x,z] ring centers (already clustered by the caller). cx/cz (legacy 2-arg call
  // shape, still used by BiomeOverride repaint/resculpt callers and by _check/start below when a spec
  // only provides the single-center getCenter shim) are accepted as a convenience alias for centers=[[cx,cz]].
  async function _rebuildMulti(centers, unbudgeted = false) {
    if (rebuilding || disposed || !frame || typeof physics?.addBody !== 'function') return
    if (!Array.isArray(centers) || centers.length === 0) return
    rebuilding = true
    _beginBudget(unbudgeted)
    try {
      const { desired, keep } = classifyRings(centers)
      // add pass first so a body is always present before its neighbour is removed
      let addDeadline = _now() + ADD_BUDGET_MS
      for (let i = 0; i < desired.length; i++) {
        if (disposed) return
        const { p } = desired[i]
        if (!live.has(p[idField])) {
          scheduleAdd(p)
          // Yield the instant the wall-clock budget is exceeded (checked after EVERY add, not batched
          // by count) -- unbudgeted=true (the initial pre-gameplay start() build) intentionally skips
          // this, same discipline as the chunk-compute budget's own _budgetOff flag, since that path
          // already runs before any client connects and has no tick-overrun consequence to guard against.
          if (!unbudgeted && _now() >= addDeadline) {
            await new Promise(r => setTimeout(r, 0))
            if (disposed) return
            addDeadline = _now() + ADD_BUDGET_MS
          }
        } else {
          _touch(p[idField], _lru.get(p[idField]) ?? estimateBodyBytes(bodyArgs(p))) // re-affirm LRU recency for a still-desired survivor
        }
      }
      // skip remove pass if budget-deferred: an incomplete keep set would wrongly drop in-range bodies; curCenters stays stale so _check re-converges.
      if (!_deferred) {
        for (const [placementId, bodyId] of [...live.entries()]) {
          if (keep.has(placementId)) continue
          scheduleRemove(placementId, bodyId)
        }
        // LRU byte-budget eviction (terrain-collider-worker-ring-lru-hysteresis): runs only on a
        // completed (non-deferred) pass, after the real keep/remove set is known, so eviction never
        // fights a still-in-flight budget-deferred classify. Evicting here (not just relying on the
        // radius/keepRadius hysteresis band) is what actually bounds memory when N player rings union
        // to more live bodies than any single ring's `cap` alone would produce.
        const evicted = evictOverBudget()
        if (evicted > 0) console.log(`${logTag} LRU evicted ${evicted} colliders over byte budget (${_residentBytes}/${byteBudget}B resident)`)
      }
      if (!_deferred) { curCenters = centers; curCenter = centers[0] || null; rebuildCount++ }
      setColliderIds(_liveIds)
    } catch (e) { console.error(logTag + ' collider rebuild error:', e?.message || e) }
    finally { rebuilding = false }
    return _deferred
  }
  // Legacy 2-arg single-center shim -- BiomeOverride repaint/resculpt callers and any external test call
  // this with (cx, cz, unbudgeted) directly; preserved byte-for-byte call shape.
  function _rebuild(cx, cz, unbudgeted = false) { return _rebuildMulti([[cx, cz]], unbudgeted) }

  function _scheduleNext(deferredRetry) {
    if (disposed) return
    _timer = setTimeout(_check, deferredRetry ? 16 : intervalMs)
  }
  function _check() {
    if (disposed) return
    try {
      const raw = getCenters()
      if (raw.length && !rebuilding) {
        const centers = clusterCenters(raw, mergeRadius, maxCenters)
        if (!curCenters.length || ringMoved(centers, curCenters, radius * rebuildAt)) {
          _rebuildMulti(centers).then(d => _scheduleNext(!!d)).catch(() => _scheduleNext(false))
          return
        }
      }
    } catch (_) {}
    _scheduleNext(false)
  }

  async function start() {
    if (disposed) return
    if (typeof spec.prewarm === 'function' && typeof physics.preallocatePool === 'function') spec.prewarm(physics, cap)
    const raw = getCenters()
    const centers = raw.length ? clusterCenters(raw, mergeRadius, maxCenters) : [[0, 0]]
    await _rebuildMulti(centers, true)
    setColliderIds(_liveIds)
    _timer = setTimeout(_check, intervalMs)
  }

  return {
    start,
    stop() { disposed = true; if (_timer) clearTimeout(_timer); for (const id of live.values()) { if (id === _PENDING) continue; try { physics.removeBody(id) } catch (_) {} } live.clear(); _liveIds.clear(); _lru.clear(); _residentBytes = 0 },
    get liveCount() { return live.size },
    get center() { return curCenter },
    get centers() { return curCenters },
    get rebuildCount() { return rebuildCount },
    get chunkCacheSize() { return _chunkCache.size },
    get residentBytes() { return _residentBytes },
    get byteBudget() { return byteBudget },
    // Drops every memoized chunk-placement entry so the next _rebuild recomputes classify() from
    // scratch -- required after anything that changes what classify() would return for
    // ALREADY-VISITED territory without changing worldSeed (e.g. src/terrain/BiomeOverride.js's
    // paint-biome brush mutating the shared anchorField this streamer reads through): the cache is
    // otherwise memoized for world lifetime (see file header), so a repainted region's already-cached
    // chunks would keep serving pre-paint species/density forever.
    clearChunkCache() { _chunkCache.clear() },
    _rebuild, _rebuildMulti, _live: live,
  }
}
