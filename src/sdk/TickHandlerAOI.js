import { unpackBinRecord, primeEntryDecode } from '../netcode/SnapshotEncoder.js'
import { neighborCells, packCellKey } from '../terrain/CubeSphereCells.js'

const PRIORITY_ENTITY_BUDGET = 64
const PRIORITY_DECAY = 0.02
const BANDWIDTH_BUDGET_BYTES_PER_TICK = 900
const BANDWIDTH_TRIM_MIN_ENTITIES = 6
const BANDWIDTH_TRIM_MAX_ITERATIONS = 32
const RECORD_FRAMING_BYTES_ESTIMATE = 8
const byFarthestFirst = (a, b) => b.d2 - a.d2

export { PRIORITY_ENTITY_BUDGET, PRIORITY_DECAY, BANDWIDTH_BUDGET_BYTES_PER_TICK }

const _CELL_FACE_FRAME = [
  { c: [ 1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { c: [-1, 0, 0], u: [0, 0,  1], v: [0, 1, 0] },
  { c: [0,  1, 0], u: [1, 0, 0],  v: [0, 0, -1] },
  { c: [0, -1, 0], u: [1, 0, 0],  v: [0, 0,  1] },
  { c: [0, 0,  1], u: [1, 0, 0],  v: [0, 1, 0] },
  { c: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
]
function _cellCenterWorld(face, wx, wy, R, dist) {
  const F = _CELL_FACE_FRAME[face]
  const dx = wx * F.u[0] + wy * F.v[0] + R * F.c[0]
  const dy = wx * F.u[1] + wy * F.v[1] + R * F.c[1]
  const dz = wx * F.u[2] + wy * F.v[2] + R * F.c[2]
  const len = Math.hypot(dx, dy, dz) || 1
  return [(dx / len) * dist, (dy / len) * dist, (dz / len) * dist]
}

function computeRingRelevantIds(cellKey, cellFace, cellCx, cellCy, cellsPerFace, planetRadius, relevanceRadius, appRuntime) {
  let ring = _ringCache.get(cellKey)
  if (ring) return ring
  const relSet = new Set(), nearSet = new Set()
  const addCell = (face, cx, cy, key) => {
    let c = _spatialCache.get(key)
    if (!c) {
      let cvp
      if (planetRadius > 0) {
        const ATAN_K = Math.PI / 4.0
        const foX = (cx + 0.5) * relevanceRadius - planetRadius
        const foY = (cy + 0.5) * relevanceRadius - planetRadius
        const wx = planetRadius * Math.tan((foX / planetRadius) * ATAN_K)
        const wy = planetRadius * Math.tan((foY / planetRadius) * ATAN_K)
        cvp = _cellCenterWorld(face, wx, wy, planetRadius, planetRadius)
      } else {
        cvp = [(cx + 0.5) * relevanceRadius, 0, (cy + 0.5) * relevanceRadius]
      }
      c = { nearbyPlayerIds: appRuntime.nearbyPlayerIdsHysteresis(cvp, relevanceRadius, key), relevantIds: appRuntime.getRelevantDynamicIdsWithStarvation(cvp, relevanceRadius, key), cellViewerPos: cvp }
      _spatialCache.set(key, c)
    }
    for (const id of c.relevantIds) relSet.add(id)
    for (const id of c.nearbyPlayerIds) nearSet.add(id)
  }
  if (planetRadius > 0) {
    const neighbors = neighborCells(cellFace, cellCx, cellCy, cellsPerFace)
    for (const n of neighbors) addCell(n.face, n.cx, n.cy, packCellKey(n.face, n.cx, n.cy, cellsPerFace))
  } else {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue
        const ncx = cellCx + dx, ncy = cellCy + dy
        addCell(-1, ncx, ncy, (ncx * 65536 + ncy) | 0)
      }
    }
  }
  ring = { relevantIds: relSet, nearbyPlayerIds: nearSet }
  _ringCache.set(cellKey, ring)
  return ring
}

const _spatialCache = new Map()
const _cellPackCache = new Map()
const _ringCache = new Map()
const _priorityAccumulators = new Map()
const _priorityBuckets = [[], [], [], []]

export function clearPlayerPriorityAccumulator(playerId) { _priorityAccumulators.delete(playerId) }
export function getPlayerPriorityIds(playerId, relevantIds, dynCache, viewerPos, tick) {
  let acc = _priorityAccumulators.get(playerId)
  if (!acc) { acc = new Map(); _priorityAccumulators.set(playerId, acc) }
  const vx = viewerPos[0], vy = viewerPos[1], vz = viewerPos[2]

  for (const id of relevantIds) {
    const entry = dynCache.get(id); if (!entry) continue
    primeEntryDecode(entry)
    const dx = entry._pX-vx, dy = entry._pY-vy, dz = entry._pZ-vz
    const distSq = dx*dx+dy*dy+dz*dz
    const distScore = 1 / (1 + distSq * 0.001)
    let h = acc.get(id)
    if (h === undefined) { h = { s: 0 }; acc.set(id, h) }
    h.s += distScore + entry._pVelScore + PRIORITY_DECAY
  }

  for (const id of acc.keys()) {
    if (!dynCache.has(id)) acc.delete(id)
  }

  if (acc.size <= PRIORITY_ENTITY_BUDGET) return relevantIds

  const buckets = _priorityBuckets
  buckets[0].length = 0; buckets[1].length = 0; buckets[2].length = 0; buckets[3].length = 0
  for (const [id, box] of acc) {
    const score = box.s
    if (score >= 3) buckets[0].push(id)
    else if (score >= 2) buckets[1].push(id)
    else if (score >= 1) buckets[2].push(id)
    else buckets[3].push(id)
  }
  const topIds = new Set()
  let remaining = PRIORITY_ENTITY_BUDGET
  for (const bucket of buckets) {
    for (const id of bucket) {
      if (remaining-- <= 0) break
      topIds.add(id)
      acc.get(id).s = 0
    }
    if (remaining <= 0) break
  }
  return topIds
}

const _budgetBin = {}
function estimateEntityBytes(enc, dynCache) {
  let n = RECORD_FRAMING_BYTES_ESTIMATE
  for (let i = 1; i < enc.length; i++) {
    const f = enc[i]
    if (f == null) continue
    if (f instanceof Uint8Array) n += f.byteLength
    else if (typeof f === 'string') n += f.length + 1
    else if (typeof f === 'number') n += 2
    else if (typeof f === 'object') {
      const entry = dynCache ? dynCache.get(enc[0]) : undefined
      const src = entry ? entry.srcEntity : null
      if (src && f === src.custom && typeof src._customV === 'number') {
        if (entry._custBytesV !== src._customV) {
          let len; try { len = JSON.stringify(f).length } catch (_) { len = 16 }
          entry._custBytes = len; entry._custBytesV = src._customV
        }
        n += entry._custBytes
      } else { try { n += JSON.stringify(f).length } catch (_) { n += 16 } }
    }
    else n += 1
  }
  return n
}

function trimEntitiesToBudget(entities, staticCount, viewerPos, dynCache) {
  if (entities.length - staticCount < BANDWIDTH_TRIM_MIN_ENTITIES) return { entities, trimmedCount: 0 }
  let total = 0
  const sized = new Array(entities.length)
  for (let i = 0; i < entities.length; i++) { const b = estimateEntityBytes(entities[i], dynCache); sized[i] = b; total += b }
  if (total <= BANDWIDTH_BUDGET_BYTES_PER_TICK) return { entities, trimmedCount: 0 }
  const vx = viewerPos ? viewerPos[0] : 0, vy = viewerPos ? viewerPos[1] : 0, vz = viewerPos ? viewerPos[2] : 0
  const candidates = []
  for (let i = staticCount; i < entities.length; i++) {
    const enc = entities[i]
    let d2 = Infinity
    const bin = (enc.length > 2 && enc[2] instanceof Uint8Array && enc[2].byteLength >= 12) ? enc[2] : null
    if (bin) {
      unpackBinRecord(bin, _budgetBin)
      const dx = _budgetBin.px - vx, dy = _budgetBin.py - vy, dz = _budgetBin.pz - vz
      d2 = dx * dx + dy * dy + dz * dz
    }
    candidates.push({ i, d2 })
  }
  candidates.sort(byFarthestFirst)
  const dropSet = new Set()
  let iterations = 0
  for (const c of candidates) {
    if (total <= BANDWIDTH_BUDGET_BYTES_PER_TICK) break
    if (++iterations > BANDWIDTH_TRIM_MAX_ITERATIONS) break
    dropSet.add(c.i)
    total -= sized[c.i]
  }
  if (dropSet.size === 0) return { entities, trimmedCount: 0 }
  const trimmed = entities.filter((_, i) => !dropSet.has(i))
  return { entities: trimmed, trimmedCount: dropSet.size }
}

export { trimEntitiesToBudget, estimateEntityBytes, computeRingRelevantIds, _cellCenterWorld, _spatialCache, _cellPackCache, _ringCache }
