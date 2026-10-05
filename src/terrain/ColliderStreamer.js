const _now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

const _BODY_OVERHEAD_BYTES = 256
const KEEP_RADIUS_HYSTERESIS_FACTOR = 1.1
const DEFAULT_BYTE_BUDGET_CAP_MULTIPLE = 8
const DEFAULT_BYTE_BUDGET_BYTES_PER_BODY = 512
function estimateBodyBytes(a) {
  if (!a) return _BODY_OVERHEAD_BYTES
  const args = a.args
  let n = 0
  if (args && typeof args.byteLength === 'number') n = args.byteLength
  else if (args && args.vertices && args.indices) n = args.vertices.byteLength + args.indices.byteLength
  else if (Array.isArray(args)) n = args.length * 4
  return _BODY_OVERHEAD_BYTES + n
}

import { latticeFor, ringAroundLocal } from './PlacementChart.js'
import { reanchoredSeaLevelXZ } from './ChartLocalPoint.js'

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
  const keepRadius = radius * KEEP_RADIUS_HYSTERESIS_FACTOR
  const mergeRadius = radius * 0.75
  const maxCenters = Number.isFinite(spec.maxCenters) && spec.maxCenters > 0 ? spec.maxCenters : 8
  const byteBudget = Number.isFinite(spec.byteBudget) && spec.byteBudget > 0 ? spec.byteBudget : cap * DEFAULT_BYTE_BUDGET_CAP_MULTIPLE * DEFAULT_BYTE_BUDGET_BYTES_PER_BODY
  const latticeSpec = spec.latticeSpec
  const idField = spec.idField
  const placementsFor = spec.placementsFor
  const bodyArgs = spec.bodyArgs
  const setColliderIds = spec.setColliderIds
  const logTag = spec.logTag || '[collider]'

  const live = new Map()
  const _liveIds = new Set()
  const _lru = new Map()
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
  let curCenters = []
  let prewarmMs = 0

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
  const COMPUTE_BUDGET_MS = 2.5
  const MAX_NEW_CHUNKS_PER_PASS = 64
  const _EMPTY = Object.freeze([])
  let _budgetDeadline = 0, _newThisPass = 0, _deferred = false, _budgetOff = false
  function _beginBudget(unbudgeted) { _budgetDeadline = _now() + COMPUTE_BUDGET_MS; _newThisPass = 0; _deferred = false; _budgetOff = !!unbudgeted }
  function chunkPlacements(k) {
    let v = _chunkCacheGet(k)
    if (v) return v
    if (!_budgetOff && (_newThisPass >= MAX_NEW_CHUNKS_PER_PASS || _now() >= _budgetDeadline)) { _deferred = true; return _EMPTY }
    v = placementsFor(k, frame, anchorField, worldSeed); _chunkCacheSet(k, v); _newThisPass++
    return v
  }

  const radiusSq = radius * radius, keepRadiusSq = keepRadius * keepRadius

  function _classifyOne(cx, cz, keepOut, candMap) {
    const lattice = latticeFor(frame, latticeSpec)
    const ring = ringAroundLocal(lattice, frame, cx, cz, keepRadius + lattice.chunkM)
    for (let r = 0; r < ring.length; r++) {
      const list = chunkPlacements(ring[r].key)
      for (let i = 0; i < list.length; i++) {
        const p = list[i]
        const ddx = p.x - cx, ddz = p.z - cz
        const d2 = ddx * ddx + ddz * ddz
        if (d2 <= keepRadiusSq) {
          const id = p[idField]
          keepOut.add(id)
          if (d2 <= radiusSq) {
            const prev = candMap.get(id)
            if (!prev || d2 < prev.d) candMap.set(id, { p, d: d2 })
          }
        }
      }
    }
  }

  function classifyRings(centers) {
    const keep = new Set(), candMap = new Map()
    for (const [cx, cz] of centers) _classifyOne(cx, cz, keep, candMap)
    const cands = [...candMap.values()]
    cands.sort((a, b) => a.d - b.d)
    if (cands.length > cap) cands.length = cap
    return { desired: cands, keep }
  }
  function classifyRing(cx, cz) { return classifyRings([[cx, cz]]) }

  const _PENDING = -1
  const _useQueue = typeof physics.enqueueAdd === 'function' && typeof physics.enqueueRemove === 'function'
  const pendingTicket = new Map()
  let nextTicket = 0
  function scheduleAdd(p) {
    const a = bodyArgs(p); if (!a) return
    const placementId = p[idField]
    _touch(placementId, estimateBodyBytes(a))
    if (_useQueue) {
      live.set(placementId, _PENDING)
      const ticket = ++nextTicket
      pendingTicket.set(placementId, ticket)
      physics.enqueueAdd(a.shape, a.args, a.position, 'static', { rotation: a.rotation, shapeKey: a.shapeKey }, (id) => {
        if (pendingTicket.get(placementId) !== ticket) { if (id != null) physics.removeBody(id); return }
        pendingTicket.delete(placementId)
        if (disposed) { if (id != null) physics.removeBody(id); live.delete(placementId); _untouch(placementId); return }
        if (id == null) { live.delete(placementId); _untouch(placementId); return }
        live.set(placementId, id)
        _liveIds.add(id)
        setColliderIds(_liveIds)
      })
    } else {
      const id = physics.addBody(a.shape, a.args, a.position, 'static', { rotation: a.rotation, shapeKey: a.shapeKey })
      if (id != null) { live.set(placementId, id); _liveIds.add(id) } else _untouch(placementId)
    }
  }
  function scheduleRemove(placementId, bodyId) {
    _untouch(placementId)
    if (bodyId === _PENDING) { pendingTicket.delete(placementId); live.delete(placementId); return }
    if (_useQueue) physics.enqueueRemove(bodyId); else physics.removeBody(bodyId)
    live.delete(placementId)
    _liveIds.delete(bodyId)
  }
  function evictOverBudget() {
    let evicted = 0
    if (_residentBytes <= byteBudget) return evicted
    for (const [placementId] of _lru) {
      if (_residentBytes <= byteBudget) break
      const bodyId = live.get(placementId)
      if (bodyId === undefined) { _untouch(placementId); continue }
      scheduleRemove(placementId, bodyId)
      evicted++
    }
    return evicted
  }

  function prewarmPools(desired) {
    if (typeof physics.preallocatePool !== 'function') return
    const demand = new Map()
    for (let i = 0; i < desired.length; i++) {
      const a = bodyArgs(desired[i].p)
      if (!a || !a.shapeKey) continue
      const d = demand.get(a.shapeKey)
      if (d) d.count++
      else demand.set(a.shapeKey, { count: 1, shape: a.shape, args: a.args })
    }
    for (const [shapeKey, d] of demand) physics.preallocatePool(d.shape, d.args, shapeKey, d.count)
  }

  const ADD_BUDGET_MS = 2
  const epochOf = () => (frame && Number.isFinite(frame.chartEpoch) ? frame.chartEpoch : 0)
  let staleEpochAborts = 0, reanchoredEpoch = -1
  async function _rebuildMulti(centers, unbudgeted = false) {
    if (rebuilding || disposed || !frame || typeof physics?.addBody !== 'function') return
    if (!Array.isArray(centers) || centers.length === 0) return
    rebuilding = true
    _beginBudget(unbudgeted)
    const epochAtStart = epochOf()
    try {
      const { desired, keep } = classifyRings(centers)
      const tp = _now()
      prewarmPools(desired)
      prewarmMs = _now() - tp
      let addDeadline = _now() + ADD_BUDGET_MS
      for (let i = 0; i < desired.length; i++) {
        if (disposed) return
        if (epochOf() !== epochAtStart) { staleEpochAborts++; return true }
        const { p } = desired[i]
        if (!live.has(p[idField])) {
          scheduleAdd(p)
          if (!unbudgeted && _now() >= addDeadline) {
            await new Promise(r => setTimeout(r, 0))
            if (disposed) return
            addDeadline = _now() + ADD_BUDGET_MS
          }
        } else {
          _touch(p[idField], _lru.get(p[idField]) ?? estimateBodyBytes(bodyArgs(p)))
        }
      }
      if (epochOf() !== epochAtStart) { staleEpochAborts++; return true }
      if (!_deferred) {
        for (const [placementId, bodyId] of [...live.entries()]) {
          if (keep.has(placementId)) continue
          scheduleRemove(placementId, bodyId)
        }
        const evicted = evictOverBudget()
        if (evicted > 0) console.log(`${logTag} LRU evicted ${evicted} colliders over byte budget (${_residentBytes}/${byteBudget}B resident)`)
      }
      if (!_deferred) { curCenters = centers; curCenter = centers[0] || null; rebuildCount++ }
      setColliderIds(_liveIds)
    } catch (e) { console.error(logTag + ' collider rebuild error:', e?.message || e) }
    finally { rebuilding = false }
    return _deferred
  }
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
    const t0 = _now()
    const raw = getCenters()
    const centers = raw.length ? clusterCenters(raw, mergeRadius, maxCenters) : [[0, 0]]
    await _rebuildMulti(centers, true)
    console.log(`${logTag} initial ring: ${live.size}/${cap} collider(s) over ${_chunkCache.size} chunk(s) for ${centers.length} center(s) (radius ${radius}m keep ${keepRadius.toFixed(1)}m) in ${(_now() - t0).toFixed(1)}ms (pool prewarm ${prewarmMs.toFixed(1)}ms)`)
    setColliderIds(_liveIds)
    _timer = setTimeout(_check, intervalMs)
  }

  function reanchor({ from, to, transfer, epoch }) {
    if (epoch === reanchoredEpoch) return 0
    reanchoredEpoch = epoch
    if (typeof physics.drainBodyQueue === 'function') physics.drainBodyQueue()
    const position = [0, 0, 0], rotation = [0, 0, 0, 1]
    let moved = 0
    for (const [placementId, bodyId] of live) {
      if (bodyId === _PENDING) throw new Error(`${logTag} placement ${placementId} is still pending after the body queue drained, so it would stay on the old chart`)
      transfer.point(physics.getBodyPosition(bodyId), position)
      transfer.quat(physics.getBodyRotation(bodyId), rotation)
      physics.setBodyTransform(bodyId, position, rotation)
      moved++
    }
    curCenters = curCenters.map(([x, z]) => reanchoredSeaLevelXZ(from, to, x, z))
    curCenter = curCenters[0] || null
    _chunkCache.clear()
    return moved
  }

  return {
    start, reanchor,
    get staleEpochAborts() { return staleEpochAborts },
    get isRebuilding() { return rebuilding },
    stop() { disposed = true; if (_timer) clearTimeout(_timer); for (const id of live.values()) { if (id === _PENDING) continue; try { physics.removeBody(id) } catch (_) {} } live.clear(); _liveIds.clear(); _lru.clear(); _residentBytes = 0 },
    get liveCount() { return live.size },
    get center() { return curCenter },
    get centers() { return curCenters },
    get rebuildCount() { return rebuildCount },
    get chunkCacheSize() { return _chunkCache.size },
    get residentBytes() { return _residentBytes },
    get byteBudget() { return byteBudget },
    clearChunkCache() { _chunkCache.clear() },
    _rebuild, _rebuildMulti, _live: live,
  }
}
