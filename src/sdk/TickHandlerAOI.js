// Area-of-interest / priority / bandwidth-budget helpers for TickHandler.js's buildAndSendSnapshots:
// cube-sphere-cell ring AOI resolution, per-viewer entity priority scoring, and outgoing-payload
// byte-budget trimming. Split out as TickHandler.js's largest stateless block -- every function here
// only touches its own module-scoped caches (_spatialCache/_ringCache/_cellPackCache/etc, cleared once
// per tick by the caller) or explicit parameters, never buildAndSendSnapshots's own closure state. See
// each function's own comment for the AOI/priority/bandwidth rationale.

import { unpackBinRecord } from '../netcode/SnapshotEncoder.js'
import { neighborCells } from '../terrain/CubeSphereCells.js'

const PRIORITY_ENTITY_BUDGET = 64
const PRIORITY_DECAY = 0.02
// Fraction of the per-tick time budget (1000/tickRate ms) that measured snapshot-build cost must exceed
// to count as "expensive" -- mirrors the SNAP_RTT_LOW/HIGH pattern but on the real compute-cost axis.
const BANDWIDTH_BUDGET_BYTES_PER_TICK = 900
const BANDWIDTH_TRIM_MIN_ENTITIES = 6
const BANDWIDTH_TRIM_MAX_ITERATIONS = 32

export { PRIORITY_ENTITY_BUDGET, PRIORITY_DECAY, BANDWIDTH_BUDGET_BYTES_PER_TICK }

// _cellCenterWorld: face-local plane coords (wx,wy, already tan-warped, i.e. ready to combine with
// FACE_FRAME the same way planet-orchestrator.js's localToDeformed does) -> a real world-space point
// on the ray through that face direction at the given radial distance. Mirrors CubeSphereCells.js's
// FACE_FRAME table exactly (col0=U, col1=V, col2=center) so the reprojected point matches the same
// face convention worldToCell used to resolve the cell in the first place.
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

// computeRingRelevantIds: cube-sphere-cell-grid AOI, the real "ring of cells" subscription this
// module implements. A single point radius-query (appRuntime.getRelevantDynamicIds/nearbyPlayerIds,
// called once per unique cellKey by the caller) already returns every entity within relevanceRadius
// of the CELL CENTER -- but relevanceRadius is also the cell's own edge length, so an entity sitting
// just across a neighbor cell's border (still within a real player's relevanceRadius of THEM, since
// players are not pinned to their cell center) can fall outside that single-cell query while still
// being genuinely relevant to a player standing near the shared edge. The fix mirrors exactly how a
// tile-based AOI system subscribes a viewer to its own cell PLUS its Moore neighborhood (a "ring"),
// not just the one cell it happens to sit in: union the relevant-id query result across the cell and
// its 8 neighbors (cross-face correct on the curved-space path via CubeSphereCells.neighborCells; a
// flat 3x3 XZ union on the non-planet path), each neighbor's query still centered on that neighbor's
// OWN cellViewerPos so every viewer sharing a given ring subscription computes the identical id set --
// the same "shared decision, not shared position" invariant the single-cell path already established
// for cellViewerPos-based distance tiering (see the tickMod comment below).
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
      // Starvation guard keyed by the cell's own packed key: every player homed to this cell shares
      // the same starvation clock (matching the ring-of-cells "shared decision, not shared position"
      // invariant documented above), so a distant entity gets force-included for the whole cell's
      // viewers together, once, rather than each player independently re-discovering it.
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
// Ring (cell + 8-neighborhood) relevant-id union cache, cleared once per tick alongside _spatialCache.
// Keyed by the SAME cellKey as _spatialCache -- one entry per unique home-cell any player sits in this
// tick, not per player. See computeRingRelevantIds above.
const _ringCache = new Map()
const _priorityAccumulators = new Map()
// module-scoped, cleared per-call to avoid GC churn (single-threaded tick, never re-entrant)
const _priorityBuckets = [[], [], [], []]

const _priorityBin = {}
export function clearPlayerPriorityAccumulator(playerId) { _priorityAccumulators.delete(playerId) }
export function getPlayerPriorityIds(playerId, relevantIds, dynCache, viewerPos, tick) {
  if (!_priorityAccumulators.has(playerId)) _priorityAccumulators.set(playerId, new Map())
  const acc = _priorityAccumulators.get(playerId)
  const vx = viewerPos[0], vy = viewerPos[1], vz = viewerPos[2]

  for (const id of relevantIds) {
    const entry = dynCache.get(id); if (!entry) continue
    // enc[2] is the packed 23-byte bin record (see SnapshotEncoder.js fillEntityEnc) -- unpack once
    // per scored entity per tick rather than reading stale flat numeric slots.
    unpackBinRecord(entry.enc[2], _priorityBin)
    const dx = _priorityBin.px-vx, dy = _priorityBin.py-vy, dz = _priorityBin.pz-vz
    const distSq = dx*dx+dy*dy+dz*dz
    const velSq = _priorityBin.vx*_priorityBin.vx+_priorityBin.vy*_priorityBin.vy+_priorityBin.vz*_priorityBin.vz
    const distScore = 1 / (1 + distSq * 0.001)
    const velScore = velSq >= 100 ? 1 : Math.sqrt(velSq) * 0.1
    const prev = acc.get(id) || 0
    acc.set(id, prev + distScore + velScore + PRIORITY_DECAY)
  }

  for (const id of acc.keys()) {
    if (!dynCache.has(id)) acc.delete(id)
  }

  if (acc.size <= PRIORITY_ENTITY_BUDGET) return relevantIds

  const buckets = _priorityBuckets
  buckets[0].length = 0; buckets[1].length = 0; buckets[2].length = 0; buckets[3].length = 0
  for (const [id, score] of acc) {
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
      acc.set(id, 0)
    }
    if (remaining <= 0) break
  }
  return topIds
}

const _budgetBin = {}
// Cheap per-record byte-size ESTIMATE (not a real msgpack measurement -- re-packing on every trim
// iteration to get an exact byte count would cost more than the bandwidth it saves). A full entity
// record is [id, model, 23-byte bin buffer, bodyType, custom, sleeping]; a delta record is
// [id, mask, ...present fields]. id/mask/bodyType/sleeping are small msgpack-encoded ints/strings
// (~1-3 bytes each); the bin buffer is a real, exact 23 bytes when present; custom is the one
// unbounded field, estimated via JSON.stringify length (msgpack is typically slightly smaller than
// JSON for the same object, so this errs conservative -- overestimating custom's cost trims a little
// more eagerly than strictly necessary, never less, which is the safe direction for a budget).
function estimateEntityBytes(enc) {
  let n = 8 // id + array/map framing overhead, flat estimate
  for (let i = 1; i < enc.length; i++) {
    const f = enc[i]
    if (f == null) continue
    if (f instanceof Uint8Array) n += f.byteLength
    else if (typeof f === 'string') n += f.length + 1
    else if (typeof f === 'number') n += 2
    else if (typeof f === 'object') { try { n += JSON.stringify(f).length } catch (_) { n += 16 } }
    else n += 1
  }
  return n
}

// Trims encoded.entities (in place, returns a new array) down toward BANDWIDTH_BUDGET_BYTES_PER_TICK,
// dropping the FARTHEST-from-viewer dynamic entity first each iteration -- graceful degradation
// (fewer/less-fresh far entities) rather than buffering or blocking the tick, avoiding the
// bufferbloat/latency-spiral a client-side send queue would risk. staticCount entities at the front of
// the array (see encodeDeltaFromCache: static entries are always pushed before any dynamic entry) are
// never trimmed -- dropping map/collision-relevant static geometry updates would desync client-side
// collision, a correctness cost far worse than a slightly stale distant prop. Returns { entities,
// trimmedCount } so a caller can log/telemetry the degradation instead of it being silent.
function trimEntitiesToBudget(entities, staticCount, viewerPos) {
  if (entities.length - staticCount < BANDWIDTH_TRIM_MIN_ENTITIES) return { entities, trimmedCount: 0 }
  let total = 0
  const sized = new Array(entities.length)
  for (let i = 0; i < entities.length; i++) { const b = estimateEntityBytes(entities[i]); sized[i] = b; total += b }
  if (total <= BANDWIDTH_BUDGET_BYTES_PER_TICK) return { entities, trimmedCount: 0 }
  const vx = viewerPos ? viewerPos[0] : 0, vy = viewerPos ? viewerPos[1] : 0, vz = viewerPos ? viewerPos[2] : 0
  // Candidate indices: dynamic entities only (index >= staticCount), each with its real squared
  // distance from the viewer where available (full records carry the 23-byte bin buffer at enc[2];
  // delta records only carry it when position/rot/vel/scale actually changed this tick -- a delta
  // missing it is scored as "far" (Infinity) so it trims before anything with a known-close position,
  // a deliberately conservative fallback since we can't cheaply know its real distance this tick).
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
  candidates.sort((a, b) => b.d2 - a.d2) // farthest first
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
