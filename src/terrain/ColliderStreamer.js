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

import { yieldToLoop } from './loopYield.js'
import { latticeFor, ringAroundLocal, chunkCentreLocal } from './PlacementChart.js'
import { reanchoredSeaLevelXZ } from './ChartLocalPoint.js'

const CENTER_SCALE_REFERENCE = 8
const CENTER_SCALE_MAX = 8
const DEFAULT_MAX_CENTERS = 192
const BOOT_CLUSTER_BATCH = 8
const MAX_BOOT_BATCHES = 4
function centerScale(centerCount) {
  return Math.min(CENTER_SCALE_MAX, Math.max(1, Math.ceil(centerCount / CENTER_SCALE_REFERENCE)))
}

function orderCenters(centers, curCenters) {
  if (!curCenters || curCenters.length === 0) return centers.slice()
  return centers
    .map((c, i) => {
      let nearest = Infinity
      for (const p of curCenters) { const dx = c[0] - p[0], dz = c[1] - p[1], d = dx * dx + dz * dz; if (d < nearest) nearest = d }
      return { c, i, d: nearest }
    })
    .sort((a, b) => a.d - b.d || a.c[0] - b.c[0] || a.c[1] - b.c[1] || a.i - b.i)
    .map(e => e.c)
}

function clusterCenters(centers, mergeRadius, maxCenters) {
  const picked = []
  const dropped = []
  const mergeRadiusSq = mergeRadius * mergeRadius
  for (const c of centers) {
    let covered = false
    for (const p of picked) { const dx = c[0] - p[0], dz = c[1] - p[1]; if (dx * dx + dz * dz <= mergeRadiusSq) { covered = true; break } }
    if (covered) continue
    if (picked.length < maxCenters) picked.push(c)
    else dropped.push(c)
  }
  return { picked, dropped }
}

function ringMoved(centers, curCenters, moveThreshold) {
  if (curCenters.length !== centers.length) return true
  const moveThresholdSq = moveThreshold * moveThreshold
  for (let i = 0; i < centers.length; i++) {
    let nearest = Infinity
    for (let j = 0; j < curCenters.length; j++) {
      const dx = centers[i][0] - curCenters[j][0], dz = centers[i][1] - curCenters[j][1]
      const d = dx * dx + dz * dz
      if (d < nearest) nearest = d
    }
    if (nearest > moveThresholdSq) return true
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
  const baseCap = Number.isFinite(spec.cap) && spec.cap > 0 ? spec.cap : 128
  const bodiesPerChunk = Number.isFinite(spec.bodiesPerChunk) && spec.bodiesPerChunk > 0 ? spec.bodiesPerChunk : 16
  const keepRadius = radius * KEEP_RADIUS_HYSTERESIS_FACTOR
  const mergeRadius = radius * 0.75
  const baseByteBudget = Number.isFinite(spec.byteBudget) && spec.byteBudget > 0 ? spec.byteBudget : baseCap * DEFAULT_BYTE_BUDGET_CAP_MULTIPLE * DEFAULT_BYTE_BUDGET_BYTES_PER_BODY
  const maxCentersRaw = spec.maxCenters
  const maxCentersExplicit = Number.isFinite(maxCentersRaw) && maxCentersRaw >= 1
  if (maxCentersRaw !== undefined && !maxCentersExplicit) console.warn(`${logTag} colliderMaxCenters ${String(maxCentersRaw)} is not a finite number >= 1, so the ${DEFAULT_MAX_CENTERS} cluster default is used instead`)
  const maxCenters = maxCentersExplicit ? Math.floor(maxCentersRaw) : DEFAULT_MAX_CENTERS
  let effectiveCap = baseCap
  let effectiveByteBudget = baseByteBudget
  const latticeSpec = spec.latticeSpec
  const idField = spec.idField
  const placementsFor = spec.placementsFor
  const bodyArgs = spec.bodyArgs
  const setColliderIds = spec.setColliderIds
  let excludePlacement = typeof spec.excludePlacement === 'function' ? spec.excludePlacement : null
  const logTag = spec.logTag || '[collider]'

  const live = new Map()
  const placedAt = new Map()
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
  let rebuildFault = null
  function recordRebuildFault(e, phase, centers, resident) {
    rebuildFault = { error: e, phase, resident, cap: effectiveCap, centers }
    console.error(`${logTag} FATAL collider rebuild failed in phase ${phase} with ${resident}/${effectiveCap} collider(s) resident for ${centers} center(s), so the ring is partial and no further rebuild is scheduled:`, e)
  }
  let curCenters = []
  let prewarmMs = 0
  let ringBuildMsTotal = 0, ringBuildStartedAt = 0, lastCenterCounts = [], lastDroppedCount = 0, droppedWarned = 0
  let classifyMsTotal = 0, addMsTotal = 0, removeMsTotal = 0, lastStarved = []
  let newChunkTotal = 0, tailMsTotal = 0, lastCands = 0
  let ringMsTotal = 0, scanMsTotal = 0, ringFreshTotal = 0, lastChunkKeys = 0, computeMsTotal = 0
  let scanLookupMsTotal = 0, scanBodyMsTotal = 0, examinedTotal = 0, nearTestsTotal = 0, lastExaminedCount = 0

  function warnDroppedCenters(dropped, total) {
    lastDroppedCount = dropped
    if (dropped === 0) { droppedWarned = 0; return }
    if (dropped <= droppedWarned) return
    droppedWarned = dropped
    console.warn(`${logTag} ${dropped} of ${total} collider cluster(s) get no veg or rock colliders: maxCenters is ${maxCenters}${maxCentersExplicit ? ' (world config)' : ` (the ${DEFAULT_MAX_CENTERS} cluster default)`} and ${total} cluster(s) are in play, so the ${dropped} farthest from the served clusters are uncovered. Raise vegetation.colliderMaxCenters to cover them.`)
  }

  function pickCenters(raw) {
    const { picked, dropped } = clusterCenters(orderCenters(raw, curCenters), mergeRadius, maxCenters)
    warnDroppedCenters(dropped.length, raw.length)
    return picked
  }

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
  const COMPUTE_BUDGET_MS = 8
  const MAX_NEW_CHUNKS_PER_PASS = 64
  const _EMPTY = Object.freeze([])
  let _budgetDeadline = 0, _newThisPass = 0, _deferred = false, _budgetOff = false
  function _beginBudget(unbudgeted) { _budgetDeadline = _now() + COMPUTE_BUDGET_MS; _newThisPass = 0; _deferred = false; _budgetOff = !!unbudgeted }
  function chunkPlacements(k) {
    let v = _chunkCacheGet(k)
    if (v) return v
    if (!_budgetOff && (_newThisPass >= MAX_NEW_CHUNKS_PER_PASS || _now() >= _budgetDeadline)) { _deferred = true; return _EMPTY }
    const _c0 = _now()
    v = placementsFor(k, frame, anchorField, worldSeed); _chunkCacheSet(k, v); _newThisPass++; newChunkTotal++
    computeMsTotal += _now() - _c0
    return v
  }

  const radiusSq = radius * radius, keepRadiusSq = keepRadius * keepRadius
  const CENTER_QUANTUM_M = 4
  const RING_CACHE_CAP = 512
  const GRID_KEY_SPAN = 65536
  const _ringCache = new Map()
  function ringKeyOf(cx, cz) { return Math.round(cx / CENTER_QUANTUM_M) + '|' + Math.round(cz / CENTER_QUANTUM_M) }
  function ringCacheGet(key) {
    const v = _ringCache.get(key)
    if (v !== undefined) { _ringCache.delete(key); _ringCache.set(key, v) }
    return v
  }
  function ringCacheSet(key, v) {
    if (_ringCache.size >= RING_CACHE_CAP) _ringCache.delete(_ringCache.keys().next().value)
    _ringCache.set(key, v)
  }
  function clearRingCache() { _ringCache.clear() }
  let _lattice = null
  function latticeOf() { if (!_lattice) _lattice = latticeFor(frame, latticeSpec); return _lattice }

  const _chunkCentre = [0, 0]
  function newAccumulator(centerCount, quota) {
    const buckets = new Array(centerCount)
    for (let i = 0; i < centerCount; i++) buckets[i] = []
    return {
      quota, buckets,
      avail: new Array(centerCount).fill(0),
      keep: new Set(), chunkKeys: [], seenKeys: new Set(),
      candP: [], candD: [], candC: [], overflow: [], candCount: 0, lastWorkMs: 0,
    }
  }
  function gatherDesired(acc, centers) {
    const tt = _now()
    const taken = new Array(centers.length).fill(0)
    const desired = []
    for (let round = 0; round < acc.quota && desired.length < effectiveCap; round++) {
      for (let i = 0; i < centers.length && desired.length < effectiveCap; i++) {
        const idx = acc.buckets[i][round]
        if (idx === undefined) continue
        taken[i]++
        desired.push(idx)
      }
    }
    if (desired.length < effectiveCap && acc.overflow.length > 0) {
      acc.overflow.sort((a, b) => acc.candD[a] - acc.candD[b])
      for (let i = 0; i < acc.overflow.length && desired.length < effectiveCap; i++) {
        const idx = acc.overflow[i]
        taken[acc.candC[idx]]++
        desired.push(idx)
      }
    }
    const starved = []
    for (let i = 0; i < centers.length; i++) if (taken[i] === 0 && acc.avail[i] > 0) starved.push(centers[i])
    tailMsTotal += _now() - tt
    lastCands = acc.candCount
    return { desired, truncated: acc.candCount > desired.length, starved, counts: taken }
  }
  function batchDesired(acc, from, to) {
    const desired = []
    for (let i = from; i < to; i++) {
      const b = acc.buckets[i]
      for (let j = 0; j < b.length; j++) desired.push(b[j])
    }
    return desired
  }
  async function classifyRings(centers, unbudgeted, acc, ringFrom, ringTo, yieldOnly = false) {
    const budgeted = !unbudgeted || yieldOnly
    const lattice = latticeOf()
    const { keep, chunkKeys, seenKeys, buckets, avail, candP, candD, candC, overflow } = acc
    const quota = acc.quota
    const ringRadius = keepRadius + CENTER_QUANTUM_M + lattice.chunkM
    const scanFrom = chunkKeys.length
    let deadline = _now() + CLASSIFY_BUDGET_MS
    let workMs = 0, sliceAt = _now(), ringWork = 0, scanWork = 0, phase = 'ring'
    let scanLookupMs = 0, scanBodyMs = 0, examinedHere = 0
    markPhase('ring')
    async function yieldNow() {
      const d = _now() - sliceAt
      workMs += d
      if (phase === 'ring') ringWork += d
      else scanWork += d
      await yieldSlice()
      sliceAt = _now()
      deadline = sliceAt + CLASSIFY_BUDGET_MS
      return !disposed
    }
    function closePhase() {
      const d = _now() - sliceAt
      workMs += d
      if (phase === 'ring') ringWork += d
      else scanWork += d
      sliceAt = _now()
    }
    for (let i = ringFrom; i < ringTo; i++) {
      if (i > ringFrom && budgeted && _now() >= deadline && !await yieldNow()) return null
      const cx = centers[i][0], cz = centers[i][1]
      const rk = ringKeyOf(cx, cz)
      let keys = ringCacheGet(rk)
      if (keys === undefined) {
        const ring = ringAroundLocal(lattice, frame, cx, cz, ringRadius)
        keys = ring.slice()
        ringCacheSet(rk, keys)
        ringFreshTotal++
      }
      for (let r = 0; r < keys.length; r++) {
        const k = keys[r]
        if (!seenKeys.has(k)) { seenKeys.add(k); chunkKeys.push(k) }
      }
    }
    closePhase()
    ringMsTotal += ringWork
    phase = 'scan'
    markPhase('scan')
    lastChunkKeys = chunkKeys.length - scanFrom
    const cellM = keepRadius + lattice.chunkM
    const n = centers.length
    const centX = new Float64Array(n), centZ = new Float64Array(n)
    for (let i = 0; i < n; i++) { centX[i] = centers[i][0]; centZ[i] = centers[i][1] }
    const grid = new Map()
    for (let i = 0; i < n; i++) {
      const gk = Math.floor(centX[i] / cellM) * GRID_KEY_SPAN + Math.floor(centZ[i] / cellM)
      const arr = grid.get(gk)
      if (arr) arr.push(i)
      else grid.set(gk, [i])
    }
    const nearRadiusSq = (keepRadius + lattice.chunkM) * (keepRadius + lattice.chunkM)
    const near = []
    for (let ci = scanFrom; ci < chunkKeys.length; ci++) {
      if (budgeted && _now() >= deadline && !await yieldNow()) return null
      const cp0 = _now()
      const list = chunkPlacements(chunkKeys[ci])
      const cp1 = _now()
      if (list.length !== 0) {
      chunkCentreLocal(lattice, frame, chunkKeys[ci], _chunkCentre)
      const qx = _chunkCentre[0], qz = _chunkCentre[1]
      near.length = 0
      const gx = Math.floor(qx / cellM), gz = Math.floor(qz / cellM)
      for (let ox = -1; ox <= 1; ox++) {
        for (let oz = -1; oz <= 1; oz++) {
          const arr = grid.get((gx + ox) * GRID_KEY_SPAN + (gz + oz))
          if (arr === undefined) continue
          for (let a = 0; a < arr.length; a++) {
            const i = arr[a]
            const dx = qx - centX[i], dz = qz - centZ[i]
            if (dx * dx + dz * dz <= nearRadiusSq) near.push(i)
          }
        }
      }
      if (near.length === 0) { scanBodyMs += _now() - cp1; continue }
      for (let k = 0; k < list.length; k++) {
        examinedTotal++
        examinedHere++
        const p = list[k]
        const id = p[idField]
        if (excludePlacement !== null && excludePlacement(id)) continue
        let bestC = -1, bestD = Infinity
        for (let a = 0; a < near.length; a++) {
          nearTestsTotal++
          const i = near[a]
          const dx = p.x - centX[i], dz = p.z - centZ[i]
          const d2 = dx * dx + dz * dz
          if (d2 > keepRadiusSq || d2 >= bestD) continue
          bestD = d2
          bestC = i
        }
        if (bestC < 0) continue
        keep.add(id)
        if (bestD > radiusSq) continue
        acc.candCount++
        avail[bestC]++
        const idx = candP.length
        candP.push(p); candD.push(bestD); candC.push(bestC)
        const b = buckets[bestC]
        const full = b.length >= quota
        if (full && candD[b[quota - 1]] <= bestD) { overflow.push(idx); continue }
        let j = full ? quota - 1 : b.length
        const displaced = full ? b[j] : -1
        while (j > 0 && candD[b[j - 1]] > bestD) { b[j] = b[j - 1]; j-- }
        b[j] = idx
        if (displaced >= 0) overflow.push(displaced)
      }
      scanBodyMs += _now() - cp1
      }
      scanLookupMs += cp1 - cp0
    }
    closePhase()
    scanMsTotal += scanWork
    scanLookupMsTotal += scanLookupMs
    scanBodyMsTotal += scanBodyMs
    markPhase('tail')
    lastExaminedCount = examinedHere
    acc.lastWorkMs = workMs
    return acc
  }

  const _PENDING = -1
  const _useQueue = typeof physics.enqueueAdd === 'function' && typeof physics.enqueueRemove === 'function'
  const pendingTicket = new Map()
  let nextTicket = 0
  function scheduleAdd(p) {
    const a = bodyArgsTimed(p, 2); if (!a) return
    const placementId = p[idField]
    placedAt.set(placementId, [p.x, p.z])
    _touch(placementId, estimateBodyBytes(a))
    if (_useQueue) {
      live.set(placementId, _PENDING)
      const ticket = ++nextTicket
      pendingTicket.set(placementId, ticket)
      physics.enqueueAdd(a.shape, a.args, a.position, 'static', { rotation: a.rotation, shapeKey: a.shapeKey }, (id) => {
        if (pendingTicket.get(placementId) !== ticket) { if (id != null) physics.removeBody(id); return }
        pendingTicket.delete(placementId)
        if (disposed) { if (id != null) physics.removeBody(id, true); live.delete(placementId); placedAt.delete(placementId); _untouch(placementId); return }
        if (id == null) { live.delete(placementId); placedAt.delete(placementId); _untouch(placementId); return }
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
    placedAt.delete(placementId)
    if (bodyId === _PENDING) { pendingTicket.delete(placementId); live.delete(placementId); return }
    if (_useQueue) physics.enqueueRemove(bodyId); else physics.removeBody(bodyId)
    live.delete(placementId)
    _liveIds.delete(bodyId)
  }
  function evictOverBudget() {
    let evicted = 0
    if (_residentBytes <= effectiveByteBudget) return evicted
    for (const [placementId] of _lru) {
      if (_residentBytes <= effectiveByteBudget) break
      const bodyId = live.get(placementId)
      if (bodyId === undefined) { _untouch(placementId); continue }
      scheduleRemove(placementId, bodyId)
      evicted++
    }
    return evicted
  }

  async function evictOverCap(centers, target = effectiveCap, protect = null) {
    if (live.size <= target) return 0
    const ids = [], bodies = [], dists = []
    let deadline = _now() + ADD_BUDGET_MS
    for (const [placementId, bodyId] of live) {
      const at = placedAt.get(placementId)
      if (at === undefined) continue
      let nearest = Infinity
      for (let i = 0; i < centers.length; i++) {
        const dx = at[0] - centers[i][0], dz = at[1] - centers[i][1]
        const d = dx * dx + dz * dz
        if (d < nearest) nearest = d
      }
      ids.push(placementId); bodies.push(bodyId); dists.push(nearest)
      if (ids.length % 256 === 0 && _now() >= deadline) { await yieldSlice(); deadline = _now() + ADD_BUDGET_MS }
    }
    const order = new Array(ids.length)
    for (let i = 0; i < order.length; i++) order[i] = i
    order.sort((a, b) => dists[b] - dists[a] || ids[a] - ids[b])
    let trimmed = 0
    for (let i = 0; i < order.length && live.size > target; i++) {
      const j = order[i]
      if (protect && protect.has(ids[j])) continue
      scheduleRemove(ids[j], bodies[j])
      trimmed++
      if (trimmed % 64 === 0 && _now() >= deadline) { await yieldSlice(); deadline = _now() + ADD_BUDGET_MS }
    }
    return trimmed
  }

  let bodyArgsMsTotal = 0, bodyArgsCalls = 0, bodyArgsSlowCalls = 0
  const bodyArgsSite = [0, 0, 0]
  function bodyArgsTimed(p, site) {
    const t0 = _now()
    const a = bodyArgs(p)
    const d = _now() - t0
    bodyArgsMsTotal += d
    bodyArgsCalls++
    bodyArgsSite[site]++
    if (d > 0.05) bodyArgsSlowCalls++
    return a
  }
  async function prewarmPools(desired, candP, keep, unbudgeted) {
    prewarmDemand = 0
    prewarmKeys = 0
    if (typeof physics.preallocatePool !== 'function') return
    const demand = new Map()
    let deadline = _now() + ADD_BUDGET_MS
    let survivors = 0
    for (const placementId of live.keys()) if (keep.has(placementId)) survivors++
    let room = Math.max(0, effectiveCap - survivors)
    for (let i = 0; i < desired.length && room > 0; i++) {
      if (i > 0 && !unbudgeted && _now() >= deadline) {
        await yieldSlice()
        deadline = _now() + ADD_BUDGET_MS
      }
      const p = candP[desired[i]]
      if (live.has(p[idField])) continue
      const a = bodyArgsTimed(p, 0)
      if (!a || !a.shapeKey) continue
      prewarmDemand++
      room--
      const d = demand.get(a.shapeKey)
      if (d) d.count++
      else demand.set(a.shapeKey, { count: 1, shape: a.shape, args: a.args })
    }
    for (const [shapeKey, d] of demand) {
      if (!unbudgeted && _now() >= deadline) {
        await yieldSlice()
        deadline = _now() + ADD_BUDGET_MS
      }
      prewarmKeys++
      physics.preallocatePool(d.shape, d.args, shapeKey, d.count)
    }
  }

  const ADD_BUDGET_MS = 2
  const CLASSIFY_BUDGET_MS = 2
  const epochOf = () => (frame && Number.isFinite(frame.chartEpoch) ? frame.chartEpoch : 0)
  let staleEpochAborts = 0, reanchoredEpoch = -1, starvedWarned = 0
  let sliceStart = 0, maxSliceMs = 0, lastSliceMaxMs = 0, slicePhase = 'idle', maxSlicePhase = 'idle', lastMaxSlicePhase = 'idle'
  let workMsTotal = 0
  let prewarmDemand = 0, prewarmKeys = 0
  const workByPhase = new Map()
  function beginSlice() { if (!sliceStart) { sliceStart = _now(); if (!_budgetOff) _budgetDeadline = sliceStart + COMPUTE_BUDGET_MS } }
  function endSlice() {
    if (!sliceStart) return
    const d = _now() - sliceStart
    sliceStart = 0
    workMsTotal += d
    workByPhase.set(slicePhase, (workByPhase.get(slicePhase) || 0) + d)
    if (d > lastSliceMaxMs) { lastSliceMaxMs = d; lastMaxSlicePhase = slicePhase }
    if (d > maxSliceMs) { maxSliceMs = d; maxSlicePhase = slicePhase }
  }
  async function yieldSlice() {
    endSlice()
    await yieldToLoop()
    beginSlice()
  }
  function markPhase(name) {
    endSlice()
    slicePhase = name
    beginSlice()
  }
  const FNV_PRIME = 16777619
  const SETTLE_QUANTUM_M = 1
  const misses = { nullIds: 0, pending: 0, fingerprint: 0, size: 0, missing: 0 }
  let settledFingerprint = 0, settledIds = null, settledSkips = 0
  function centerFingerprint(centers) {
    let h = 2166136261
    for (let i = 0; i < centers.length; i++) {
      h = Math.imul(h ^ Math.round(centers[i][0] / SETTLE_QUANTUM_M), FNV_PRIME) >>> 0
      h = Math.imul(h ^ Math.round(centers[i][1] / SETTLE_QUANTUM_M), FNV_PRIME) >>> 0
    }
    h = Math.imul(h ^ effectiveCap, FNV_PRIME) >>> 0
    h = Math.imul(h ^ epochOf(), FNV_PRIME) >>> 0
    return h >>> 0
  }
  function settled(centers) {
    if (settledIds === null) { misses.nullIds++; return false }
    if (pendingTicket.size !== 0) { misses.pending++; return false }
    if (settledFingerprint !== centerFingerprint(centers)) { misses.fingerprint++; return false }
    if (live.size !== settledIds.size) { misses.size++; return false }
    for (const placementId of live.keys()) if (!settledIds.has(placementId)) { misses.missing++; return false }
    return true
  }
  function clearSettled() { settledIds = null; settledFingerprint = 0 }
  async function _rebuildMulti(centers, unbudgeted = false, opts = null) {
    if (rebuilding || disposed || !frame || typeof physics?.addBody !== 'function') return
    if (!Array.isArray(centers) || centers.length === 0) return
    rebuilding = true
    if (!ringBuildStartedAt) ringBuildStartedAt = _now()
    const rbT0 = _now()
    lastSliceMaxMs = 0
    beginSlice()
    const scale = centerScale(centers.length)
    effectiveCap = baseCap * scale
    effectiveByteBudget = baseByteBudget * scale
    _beginBudget(unbudgeted)
    const epochAtStart = epochOf()
    const batched = opts !== null
    const finalize = !batched || opts.finalize === true
    const acc = batched ? opts.acc : newAccumulator(centers.length, Math.max(1, Math.ceil(effectiveCap / centers.length)))
    const ringFrom = batched ? opts.ringFrom ?? 0 : 0
    const ringTo = batched ? opts.ringTo ?? centers.length : centers.length
    try {
      if (!batched && settled(centers)) { settledSkips++; markPhase('settled'); return false }
      const classified = await classifyRings(centers, unbudgeted, acc, ringFrom, ringTo, batched)
      if (classified === null) return _deferred
      const gathered = finalize ? gatherDesired(acc, centers) : null
      const desired = finalize ? gathered.desired : batchDesired(acc, ringFrom, ringTo)
      const { truncated, starved, counts } = finalize ? gathered : { truncated: false, starved: [], counts: null }
      classifyMsTotal += acc.lastWorkMs
      lastStarved = starved
      if (truncated && starved.length) {
        if (starved.length > starvedWarned) {
          starvedWarned = starved.length
        const named = starved.slice(0, 8).map(([x, z]) => `(${x.toFixed(0)}, ${z.toFixed(0)})`).join(', ')
        console.warn(`${logTag} ${starved.length} of ${centers.length} collider clusters got none of the colliders inside their radius: the body cap ${effectiveCap} (${baseCap} x ${scale} for ${centers.length} clusters) is shared by every cluster, so these chart-local centres have no collider: ${named}${starved.length > 8 ? ` and ${starved.length - 8} more` : ''}. Raise the collider cap or lower the collider radius.`)
        }
      } else if (starvedWarned !== 0) starvedWarned = 0
      if (!finalize) {
        const roomForBatch = Math.max(0, effectiveCap - live.size)
        if (desired.length > roomForBatch) desired.length = roomForBatch
      }
      const desiredIds = new Set()
      for (let i = 0; i < desired.length; i++) desiredIds.add(acc.candP[desired[i]][idField])
      const bootDrop = batched && finalize ? desiredIds : null
      let missing = 0
      for (const placementId of desiredIds) if (!live.has(placementId)) missing++
      const roomTarget = effectiveCap - missing
      markPhase('evict')
      if (live.size > roomTarget) await evictOverCap(centers, roomTarget, desiredIds)
      const tp = _now()
      markPhase('prewarm')
      await prewarmPools(desired, acc.candP, acc.keep, unbudgeted && !batched)
      prewarmMs = _now() - tp
      let addDeadline = _now() + ADD_BUDGET_MS
      const ta = _now()
      markPhase('add')
      for (let i = 0; i < desired.length; i++) {
        if (disposed) return
        if (epochOf() !== epochAtStart) { staleEpochAborts++; return true }
        const p = acc.candP[desired[i]]
        if (live.has(p[idField])) {
          _touch(p[idField], _lru.get(p[idField]) ?? estimateBodyBytes(bodyArgsTimed(p, 1)))
          continue
        }
        scheduleAdd(p)
        if (_now() >= addDeadline) {
          await yieldSlice()
          if (disposed) return
          addDeadline = _now() + ADD_BUDGET_MS
        }
      }
      if (epochOf() !== epochAtStart) { staleEpochAborts++; return true }
      addMsTotal += _now() - ta
      if (finalize && !_deferred) {
        const tr = _now()
        markPhase('remove')
        let removeDeadline = _now() + ADD_BUDGET_MS
        for (const [placementId, bodyId] of [...live.entries()]) {
          if (bootDrop ? bootDrop.has(placementId) : acc.keep.has(placementId)) continue
          scheduleRemove(placementId, bodyId)
          if (_now() >= removeDeadline) { await yieldSlice(); removeDeadline = _now() + ADD_BUDGET_MS }
        }
        removeMsTotal += _now() - tr
      }
      if (!_deferred) {
        markPhase('evict')
        const evicted = evictOverBudget()
        if (evicted > 0) console.log(`${logTag} LRU evicted ${evicted} colliders over byte budget (${_residentBytes}/${effectiveByteBudget}B resident)`)
      }
      if (finalize && !_deferred) { curCenters = centers; curCenter = centers[0] || null; lastCenterCounts = counts; rebuildCount++ }
      if (finalize) {
        markPhase('trim')
        const trimmed = await evictOverCap(centers)
        if (trimmed > 0) console.log(`${logTag} trimmed ${trimmed} collider(s) beyond the body cap: ${live.size}/${effectiveCap} resident for ${centers.length} center(s)`)
      }
      if (finalize && !_deferred) { settledFingerprint = centerFingerprint(centers); settledIds = new Set(live.keys()) }
      markPhase('ids')
      setColliderIds(_liveIds)
    } catch (e) {
      recordRebuildFault(e, slicePhase, centers.length, live.size)
      clearSettled()
      throw e
    }
    finally { endSlice(); ringBuildMsTotal += _now() - rbT0; rebuilding = false }
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
        const centers = pickCenters(raw)
        if (!curCenters.length || ringMoved(centers, curCenters, radius * rebuildAt)) {
          _rebuildMulti(centers).then(d => _scheduleNext(!!d)).catch(() => { if (!disposed) console.error(`${logTag} periodic rebuild halted after the fault above; ${rebuildFault.resident} collider(s) still resident for ${rebuildFault.centers} center(s)`) })
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
    const centers = raw.length ? pickCenters(raw) : [[0, 0]]
    const quota = Math.max(1, Math.ceil((baseCap * centerScale(centers.length)) / centers.length))
    const acc = newAccumulator(centers.length, quota)
    let batches = 0
    const bootBatch = Math.max(BOOT_CLUSTER_BATCH, Math.ceil(centers.length / MAX_BOOT_BATCHES))
    for (let from = 0; from < centers.length; from += bootBatch) {
      const to = Math.min(centers.length, from + bootBatch)
      await _rebuildMulti(centers, true, { acc, ringFrom: from, ringTo: to, finalize: to >= centers.length })
      batches++
      if (to < centers.length && !disposed) await yieldToLoop()
    }
    console.log(`${logTag} initial ring: ${live.size}/${effectiveCap} collider(s) over ${_chunkCache.size} chunk(s) for ${centers.length} center(s) of maxCenters ${maxCenters}${maxCentersExplicit ? '' : ' (default)'}, dropped ${lastDroppedCount} (radius ${radius}m keep ${keepRadius.toFixed(1)}m) in ${(_now() - t0).toFixed(1)}ms over ${batches} cluster batch(es) of ${bootBatch} (pool prewarm ${prewarmMs.toFixed(1)}ms)`)
    if (disposed) return
    setColliderIds(_liveIds)
    _timer = setTimeout(_check, intervalMs)
  }

  function reanchor({ from, to, transfer, epoch }) {
    if (epoch === reanchoredEpoch) return 0
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
    clearRingCache()
    clearSettled()
    reanchoredEpoch = epoch
    return moved
  }

  return {
    start, reanchor,
    release(placementId) {
      const bodyId = live.get(placementId)
      if (bodyId === undefined) return false
      scheduleRemove(placementId, bodyId)
      return true
    },
    refresh() { return curCenters.length ? _rebuildMulti(curCenters, true) : null },
    setExclude(fn) {
      if (fn !== null && typeof fn !== 'function') throw new TypeError(`${logTag} setExclude needs a function or null`)
      excludePlacement = fn
      clearSettled()
    },
    sweepExcluded() {
      if (excludePlacement === null) return 0
      let released = 0
      for (const [placementId, bodyId] of [...live]) if (excludePlacement(placementId)) { scheduleRemove(placementId, bodyId); released++ }
      return released
    },
    get staleEpochAborts() { return staleEpochAborts },
    get isRebuilding() { return rebuilding },
    stop() { disposed = true; if (_timer) clearTimeout(_timer); for (const id of live.values()) { if (id === _PENDING) continue; try { physics.removeBody(id, true) } catch (_) {} } live.clear(); placedAt.clear(); _liveIds.clear(); _lru.clear(); _ringCache.clear(); _residentBytes = 0 },
    get liveCount() { return live.size },
    get center() { return curCenter },
    get centers() { return curCenters },
    get rebuildCount() { return rebuildCount },
    get centerCounts() { return lastCenterCounts },
    get droppedCenters() { return lastDroppedCount },
    get ringBuildMs() { return ringBuildMsTotal },
    get classifyMs() { return classifyMsTotal },
    get addMs() { return addMsTotal },
    get removeMs() { return removeMsTotal },
    get newChunks() { return newChunkTotal },
    get tailMs() { return tailMsTotal },
    get ringMs() { return ringMsTotal },
    get scanMs() { return scanMsTotal },
    get ringFresh() { return ringFreshTotal },
    get chunkKeys() { return lastChunkKeys },
    get computeMs() { return computeMsTotal },
    get scanLookupMs() { return scanLookupMsTotal },
    get scanBodyMs() { return scanBodyMsTotal },
    get examined() { return examinedTotal },
    get lastExamined() { return lastExaminedCount },
    get nearTests() { return nearTestsTotal },
    get cands() { return lastCands },
    get maxSliceMs() { return maxSliceMs },
    get maxSlicePhase() { return maxSlicePhase },
    get lastMaxSliceMs() { return lastSliceMaxMs },
    get lastMaxSlicePhase() { return lastMaxSlicePhase },
    get prewarmMs() { return prewarmMs },
    get workMs() { return workMsTotal },
    get prewarmDemand() { return prewarmDemand },
    get prewarmKeys() { return prewarmKeys },
    get bodyArgsMs() { return bodyArgsMsTotal },
    get bodyArgsCalls() { return bodyArgsCalls },
    get bodyArgsSlowCalls() { return bodyArgsSlowCalls },
    get bodyArgsPrewarm() { return bodyArgsSite[0] },
    get bodyArgsTouch() { return bodyArgsSite[1] },
    get bodyArgsAdd() { return bodyArgsSite[2] },
    get settledSkips() { return settledSkips },
    get settledMisses() { return { ...misses } },
    get fault() { return rebuildFault },
    get starvedClusters() { return lastStarved },
    get ringBuildMsPerSecond() { const secs = (_now() - ringBuildStartedAt) / 1000; return ringBuildStartedAt && secs > 0 ? ringBuildMsTotal / secs : 0 },
    get chunkCacheSize() { return _chunkCache.size },
    get ringCacheSize() { return _ringCache.size },
    get cap() { return effectiveCap },
    get residentBytes() { return _residentBytes },
    get byteBudget() { return effectiveByteBudget },
    clearChunkCache() { _chunkCache.clear(); clearRingCache(); clearSettled() },
    _rebuild, _rebuildMulti, _live: live,
  }
}
