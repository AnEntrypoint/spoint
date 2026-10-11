import { unpackBinRecord, primeEntryDecode } from '../netcode/SnapshotEncoder.js'
import { neighborCells, packCellKey, resolveCell, worldToCell } from '../terrain/CubeSphereCells.js'

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

const AOI_CELL_BASE_MAX = 512

const aoiRingWork = {
  ringComputes: 0,
  ringHits: 0,
  cellComputes: 0,
  cellHits: 0,
  cellCentreSolves: 0,
  neighbourCellsCalls: 0,
  cellBaseComputes: 0,
  cellBaseHits: 0,
  cellBaseMisses: 0,
  cellBaseStaleDrops: 0,
  cellBaseUnusable: 0,
  statefulQueries: 0,
  evictions: 0,
  epochDrops: 0,
  epochRefusedCodeEpochNotInstalled: 0,
  epochRefusedMutationsNotACount: 0,
  epochRefusedRelevanceRadiusNotPositive: 0,
  epochRefusedPlanetRadiusNegative: 0,
}

export function resetAoiRingWork() {
  for (const key of Object.keys(aoiRingWork)) aoiRingWork[key] = 0
}

export { aoiRingWork }

export const AOI_EPOCH_CASE = Object.freeze({
  unset: 'unset',
  disabled: 'disabled',
  unrepresentable: 'unrepresentable',
  active: 'active',
})

export const AOI_EPOCH_REFUSAL = Object.freeze({
  codeEpochNotInstalled: 'codeEpochNotInstalled',
  mutationsNotACount: 'mutationsNotACount',
  relevanceRadiusNotPositive: 'relevanceRadiusNotPositive',
  planetRadiusNegative: 'planetRadiusNegative',
})

export const AOI_EPOCH_RADIUS_SOURCE = Object.freeze({
  index: 'index',
  caller: 'caller',
  callerAgainstIndex: 'callerAgainstIndex',
})

export const AOI_CELL_BASE_CASE = Object.freeze({
  hit: 'hit',
  miss: 'miss',
  stale: 'stale',
  unusable: 'unusable',
})

const _cellBaseCache = new Map()
let _aoiCodeEpoch = ''

const AOI_CODE_EPOCH_LEN = 16

const AOI_EPOCH_UNSET = Object.freeze({ case: AOI_EPOCH_CASE.unset, key: null })
const AOI_EPOCH_DISABLED = Object.freeze({ case: AOI_EPOCH_CASE.disabled, key: null })
const AOI_CELL_BASE_MISS = Object.freeze({ case: AOI_CELL_BASE_CASE.miss })
const AOI_CELL_BASE_STALE = Object.freeze({ case: AOI_CELL_BASE_CASE.stale })
const AOI_CELL_BASE_UNUSABLE = Object.freeze({ case: AOI_CELL_BASE_CASE.unusable })

let _aoiCellBaseEpoch = AOI_EPOCH_UNSET

export function aoiCodeEpoch() {
  return _aoiCodeEpoch
}

export function aoiCellBaseEpoch() {
  return _aoiCellBaseEpoch
}

export function aoiCellBaseCacheSize() {
  return _cellBaseCache.size
}

export async function installAoiCodeEpoch() {
  const fs = await import((() => 'node:' + 'fs')())
  const crypto = await import((() => 'node:' + 'crypto')())
  const sources = ['./TickHandlerAOI.js', '../terrain/CubeSphereCells.js', '../spatial/Octree.js', '../apps/AppRuntime.js', '../stage/Stage.js']
  const digest = crypto.createHash('sha256')
  for (const rel of sources) digest.update(fs.readFileSync(new URL(rel, import.meta.url)))
  const epoch = digest.digest('hex').slice(0, AOI_CODE_EPOCH_LEN)
  if (_aoiCodeEpoch !== epoch) { _aoiCodeEpoch = epoch; _cellBaseCache.clear() }
  return epoch
}

export function invalidateAoiCellBaseCache() {
  _aoiCellBaseEpoch = AOI_EPOCH_UNSET
  _cellBaseCache.clear()
}

export function disableAoiCellBaseCache() {
  _aoiCodeEpoch = ''
  invalidateAoiCellBaseCache()
  _aoiCellBaseEpoch = AOI_EPOCH_DISABLED
}

function aoiEpochRefused(refusal) {
  return Object.freeze({ case: AOI_EPOCH_CASE.unrepresentable, refusal, key: null })
}

function aoiRadiusSource(indexRadius, relevanceRadius) {
  if (indexRadius === null) return AOI_EPOCH_RADIUS_SOURCE.caller
  return indexRadius === relevanceRadius ? AOI_EPOCH_RADIUS_SOURCE.index : AOI_EPOCH_RADIUS_SOURCE.callerAgainstIndex
}

function parseAoiCellBaseEpoch(codeEpoch, mutations, relevanceRadius, planetRadius, indexRadius) {
  if (codeEpoch.length !== AOI_CODE_EPOCH_LEN) return aoiEpochRefused(AOI_EPOCH_REFUSAL.codeEpochNotInstalled)
  if (!Number.isInteger(mutations) || mutations < 0) return aoiEpochRefused(AOI_EPOCH_REFUSAL.mutationsNotACount)
  if (!Number.isFinite(relevanceRadius) || relevanceRadius <= 0) return aoiEpochRefused(AOI_EPOCH_REFUSAL.relevanceRadiusNotPositive)
  if (!Number.isFinite(planetRadius) || planetRadius < 0) return aoiEpochRefused(AOI_EPOCH_REFUSAL.planetRadiusNegative)
  const key = `${codeEpoch}|${mutations}|${relevanceRadius}|${planetRadius}|${indexRadius}`
  if (_aoiCellBaseEpoch.case === AOI_EPOCH_CASE.active && _aoiCellBaseEpoch.key === key) return _aoiCellBaseEpoch
  return Object.freeze({
    case: AOI_EPOCH_CASE.active,
    key,
    codeEpoch,
    mutations,
    relevanceRadius,
    planetRadius,
    indexRadius,
    radiusSource: aoiRadiusSource(indexRadius, relevanceRadius),
  })
}

const AOI_EPOCH_REFUSAL_COUNTER = {
  [AOI_EPOCH_REFUSAL.codeEpochNotInstalled]: 'epochRefusedCodeEpochNotInstalled',
  [AOI_EPOCH_REFUSAL.mutationsNotACount]: 'epochRefusedMutationsNotACount',
  [AOI_EPOCH_REFUSAL.relevanceRadiusNotPositive]: 'epochRefusedRelevanceRadiusNotPositive',
  [AOI_EPOCH_REFUSAL.planetRadiusNegative]: 'epochRefusedPlanetRadiusNegative',
}

function countAoiEpochRefusal(epoch) {
  const counter = AOI_EPOCH_REFUSAL_COUNTER[epoch.refusal]
  if (counter !== undefined) aoiRingWork[counter]++
}

export function setAoiCellBaseEpoch(relevanceRadius, planetRadius, appRuntime) {
  const spatial = appRuntime?._stageLoader?._activeStage?.spatial
  const mutations = spatial ? spatial.mutations : null
  const indexRadius = spatial && Number.isFinite(spatial.relevanceRadius) ? spatial.relevanceRadius : null
  _aoiCellBaseEpoch = parseAoiCellBaseEpoch(_aoiCodeEpoch, mutations, relevanceRadius, planetRadius, indexRadius)
  if (_aoiCellBaseEpoch.case !== AOI_EPOCH_CASE.active) {
    aoiRingWork.epochDrops += _cellBaseCache.size
    _cellBaseCache.clear()
    countAoiEpochRefusal(_aoiCellBaseEpoch)
  }
}

function readCellBase(key) {
  const epoch = _aoiCellBaseEpoch
  if (epoch.case !== AOI_EPOCH_CASE.active) { aoiRingWork.cellBaseUnusable++; return AOI_CELL_BASE_UNUSABLE }
  const hit = _cellBaseCache.get(key)
  if (hit === undefined) { aoiRingWork.cellBaseMisses++; return AOI_CELL_BASE_MISS }
  if (hit.epoch !== epoch) {
    _cellBaseCache.delete(key)
    aoiRingWork.epochDrops++
    aoiRingWork.cellBaseStaleDrops++
    return AOI_CELL_BASE_STALE
  }
  _cellBaseCache.delete(key)
  _cellBaseCache.set(key, hit)
  return hit
}

function storeCellBase(key, cellViewerPos, baseRelevantIds) {
  const epoch = _aoiCellBaseEpoch
  if (epoch.case !== AOI_EPOCH_CASE.active) return
  _cellBaseCache.set(key, { case: AOI_CELL_BASE_CASE.hit, epoch, cellViewerPos, baseRelevantIds })
  if (_cellBaseCache.size > AOI_CELL_BASE_MAX) {
    const oldest = _cellBaseCache.keys().next().value
    _cellBaseCache.delete(oldest)
    aoiRingWork.evictions++
  }
}

function flatCellKey(cx, cz) {
  if (cx >= -32768 && cx <= 32767 && cz >= -32768 && cz <= 32767) return (cx * 65536 + cz) | 0
  return `${cx},${cz}`
}

export function resolvePlayerCell(viewerPos, planetRadius, relevanceRadius) {
  if (planetRadius > 0) {
    const c = worldToCell(viewerPos[0], viewerPos[1], viewerPos[2], planetRadius, relevanceRadius)
    const cellsPerFace = Math.ceil((2 * planetRadius) / relevanceRadius)
    const r = resolveCell(c.face, c.cx, c.cy, cellsPerFace)
    return { cellKey: packCellKey(r.face, r.cx, r.cy, cellsPerFace), cellFace: r.face, cellCx: r.cx, cellCy: r.cy, cellsPerFace }
  }
  const cx = Math.floor(viewerPos[0] / relevanceRadius), cz = Math.floor(viewerPos[2] / relevanceRadius)
  return { cellKey: flatCellKey(cx, cz), cellFace: -1, cellCx: cx, cellCy: cz, cellsPerFace: 0 }
}

export function solveCellViewer(face, cx, cy, planetRadius, relevanceRadius) {
  if (planetRadius > 0) {
    const ATAN_K = Math.PI / 4.0
    const foX = (cx + 0.5) * relevanceRadius - planetRadius
    const foY = (cy + 0.5) * relevanceRadius - planetRadius
    const wx = planetRadius * Math.tan((foX / planetRadius) * ATAN_K)
    const wy = planetRadius * Math.tan((foY / planetRadius) * ATAN_K)
    return _cellCenterWorld(face, wx, wy, planetRadius, planetRadius)
  }
  return [(cx + 0.5) * relevanceRadius, 0, (cy + 0.5) * relevanceRadius]
}

function cellBaseIds(appRuntime, cvp, planetRadius, relevanceRadius) {
  const stageLoader = appRuntime?._stageLoader
  if (planetRadius <= 0 && stageLoader) return stageLoader.getRelevantEntitiesHorizontal(cvp, relevanceRadius)
  return appRuntime.relevantEntities(cvp, relevanceRadius)
}

function computeRingRelevantIds(cellKey, cellFace, cellCx, cellCy, cellsPerFace, planetRadius, relevanceRadius, appRuntime) {
  let ring = _ringCache.get(cellKey)
  if (ring) { aoiRingWork.ringHits++; return ring }
  aoiRingWork.ringComputes++
  const relSet = new Set()
  const addCell = (face, cx, cy, key) => {
    let c = _spatialCache.get(key)
    if (!c) {
      aoiRingWork.cellComputes++
      aoiRingWork.statefulQueries += 1
      const base = readCellBase(key)
      let cvp, baseRelevantIds
      if (base.case === AOI_CELL_BASE_CASE.hit) { cvp = base.cellViewerPos; baseRelevantIds = base.baseRelevantIds; aoiRingWork.cellBaseHits++ }
      else {
        aoiRingWork.cellBaseComputes++
        aoiRingWork.cellCentreSolves++
        cvp = solveCellViewer(face, cx, cy, planetRadius, relevanceRadius)
        baseRelevantIds = cellBaseIds(appRuntime, cvp, planetRadius, relevanceRadius)
        storeCellBase(key, cvp, baseRelevantIds)
      }
      let relevantIds = appRuntime.getRelevantDynamicIdsWithStarvation(cvp, relevanceRadius, key, 300, baseRelevantIds)
      if (relevantIds instanceof Set && relevantIds.size > baseRelevantIds.length) {
        const r2 = relevanceRadius * relevanceRadius
        const gate = [cvp[0], cvp[1], cvp[2]]
        const kept = new Set()
        for (const id of relevantIds) {
          const p = _positionOfEntity(appRuntime, id)
          if (!p || _withinAny(p, gate, planetRadius, r2)) kept.add(id)
        }
        relevantIds = kept
      }
      c = {
        relevantIds,
        cellViewerPos: cvp,
        baseRelevantIds,
      }
      _spatialCache.set(key, c)
    } else aoiRingWork.cellHits++
    for (const id of c.relevantIds) relSet.add(id)
  }
  if (planetRadius > 0) {
    aoiRingWork.neighbourCellsCalls++
    const neighbors = neighborCells(cellFace, cellCx, cellCy, cellsPerFace)
    for (const n of neighbors) addCell(n.face, n.cx, n.cy, packCellKey(n.face, n.cx, n.cy, cellsPerFace))
  } else {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue
        const ncx = cellCx + dx, ncy = cellCy + dy
        addCell(-1, ncx, ncy, flatCellKey(ncx, ncy))
      }
    }
  }
  ring = { relevantIds: relSet }
  _ringCache.set(cellKey, ring)
  return ring
}

function _positionOfEntity(appRuntime, id) {
  const spatial = appRuntime?._stageLoader?._activeStage?.spatial
  if (spatial && typeof spatial.getPosition === 'function') {
    const p = spatial.getPosition(id)
    if (p) return p
  }
  const e = appRuntime?.entities?.get(id)
  return e && e.position ? e.position : null
}

function _withinAny(p, gatePoints, planetRadius, r2) {
  const points = gatePoints.length / 3 | 0
  for (let i = 0; i < points; i++) {
    const dx = p[0] - gatePoints[i * 3]
    const dy = planetRadius > 0 ? p[1] - gatePoints[i * 3 + 1] : 0
    const dz = p[2] - gatePoints[i * 3 + 2]
    if (dx * dx + dy * dy + dz * dz <= r2) return true
  }
  return false
}

function resolveDeliveredIds(ringRelevantIds, unmanagedIds, gatePoints, planetRadius, relevanceRadius, appRuntime) {
  if (!unmanagedIds || unmanagedIds.length === 0) return ringRelevantIds
  const delivered = new Set(ringRelevantIds)
  if (!gatePoints || gatePoints.length < 3) {
    for (const id of unmanagedIds) delivered.add(id)
    return delivered
  }
  const r2 = relevanceRadius * relevanceRadius
  for (const id of unmanagedIds) {
    const p = _positionOfEntity(appRuntime, id)
    if (!p || _withinAny(p, gatePoints, planetRadius, r2)) delivered.add(id)
  }
  return delivered
}

const _spatialCache = new Map()
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

export { trimEntitiesToBudget, estimateEntityBytes, computeRingRelevantIds, resolveDeliveredIds, _cellCenterWorld, _spatialCache, _ringCache }
