// Flat uniform grid hash spatial index (replaces the former d3-octree point-octree).
// Cells are cubes of side CELL_SIZE on the XZ plane (Y is ignored for bucketing, matching
// the AOI/relevance-query access pattern of this index -- queries are always a horizontal
// radius around a position). Each cell key maps to an array of entity ids; a side map
// tracks which cell each id currently lives in so remove/update are O(1) instead of an
// O(n) scan.

const CELL_SIZE = 32
// Integer cell key (same packing convention as CollisionSystem.js:6 / AppRuntimeTick.js:128 /
// TickHandlerAOI.js:93), replacing a `cx + ',' + cz` string. Every nearby()/nearbyHysteresis()/
// nearest() call probes (2*radius/CELL_SIZE+1)^2 cells -- 196 probes at the tps-game
// relevanceRadius of 200m -- so the string form allocated ~196 strings and did ~196 string-hash
// Map lookups PER QUERY, on a path called once per unique AOI cell per snapshot tick.
// CELL_KEY_SPAN is derived, not tuned: key(cx,cz)=cx*SPAN+cz is injective while |cz| < SPAN, i.e.
// while |z| < SPAN*CELL_SIZE/2 = 6.7e7 m, and stays an exact float64 integer while |cx| < 2^53/SPAN
// = 2^31 (|x| < 6.9e10 m). The largest world this engine addresses is tps-game's planet radius
// 63600 m (|cz| <= 1988), ~2000x inside the injectivity bound.
const CELL_KEY_SPAN = 4194304

function cellCoord(v) {
  return Math.floor(v / CELL_SIZE)
}

function cellKey(cx, cz) {
  return cx * CELL_KEY_SPAN + cz
}

export class SpatialIndex {
  constructor(config = {}) {
    this._cells = new Map() // cellKey -> array of ids
    this._idCell = new Map() // id -> cellKey
    this._entities = new Map() // id -> position [x,y,z]
    this._relevanceRadius = config.relevanceRadius || 200
  }

  insert(id, position) {
    this.remove(id)
    const px = position[0], py = position[1], pz = position[2]
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return
    const point = [px, py, pz]
    this._entities.set(id, point)
    const key = cellKey(cellCoord(px), cellCoord(pz))
    let bucket = this._cells.get(key)
    if (!bucket) { bucket = []; this._cells.set(key, bucket) }
    bucket.push(id)
    this._idCell.set(id, key)
    const n = this._entities.size
    if (n >= 256 && (n & (n - 1)) === 0) { try { console.warn('[SpatialIndex] size=' + n) } catch (_) {} }
  }

  remove(id) {
    const key = this._idCell.get(id)
    if (key === undefined) return
    const bucket = this._cells.get(key)
    if (bucket) {
      const idx = bucket.indexOf(id)
      if (idx !== -1) {
        const last = bucket.length - 1
        if (idx !== last) bucket[idx] = bucket[last]
        bucket.pop()
      }
      if (bucket.length === 0) this._cells.delete(key)
    }
    this._idCell.delete(id)
    this._entities.delete(id)
  }

  update(id, position) {
    const existing = this._entities.get(id)
    if (existing) {
      const dx = existing[0] - position[0], dy = existing[1] - position[1], dz = existing[2] - position[2]
      if (dx * dx + dy * dy + dz * dz < 1.0) return
      const px = position[0], pz = position[2]
      if (!Number.isFinite(px) || !Number.isFinite(position[1]) || !Number.isFinite(pz)) { this.remove(id); return }
      const newKey = cellKey(cellCoord(px), cellCoord(pz))
      const oldKey = this._idCell.get(id)
      if (newKey === oldKey) {
        // Same cell -- just refresh the stored position, no bucket churn.
        existing[0] = px; existing[1] = position[1]; existing[2] = pz
        return
      }
    }
    this.insert(id, position)
  }

  has(id) {
    return this._entities.has(id)
  }

  getPosition(id) {
    const p = this._entities.get(id)
    return p ? [p[0], p[1], p[2]] : null
  }

  nearby(position, radius, out) {
    const results = out || []
    if (out) results.length = 0
    const cx = position[0], cy = position[1], cz = position[2]
    const r2 = radius * radius
    const minCx = cellCoord(cx - radius), maxCx = cellCoord(cx + radius)
    const minCz = cellCoord(cz - radius), maxCz = cellCoord(cz + radius)
    for (let gx = minCx; gx <= maxCx; gx++) {
      for (let gz = minCz; gz <= maxCz; gz++) {
        const bucket = this._cells.get(cellKey(gx, gz))
        if (!bucket) continue
        for (let i = 0; i < bucket.length; i++) {
          const id = bucket[i]
          const p = this._entities.get(id)
          if (!p) continue
          const dx = p[0] - cx, dy = p[1] - cy, dz = p[2] - cz
          if (dx * dx + dy * dy + dz * dz <= r2) results.push(id)
        }
      }
    }
    return results
  }

  // Hysteresis-ring query: an entity that was included in THIS SAME queryKey's previous call stays
  // included until it exceeds radius*hysteresisFactor (default 1.15, i.e. a 15% "sticky" outer ring),
  // not the instant it crosses the base radius. Without this, an entity hovering exactly at the AOI
  // boundary (a player walking back and forth across a cell-relevance edge, or float jitter on a
  // stationary one) pops in/out of every viewer's snapshot every tick -- visible as flicker/pop on the
  // client and wasted bandwidth re-sending spawn/despawn each time. queryKey scopes the "was included
  // last call" memory so independent callers (different cells, different relevance radii) don't share
  // state and one query's hysteresis doesn't leak into another's.
  nearbyHysteresis(position, radius, queryKey, hysteresisFactor = 1.15, out) {
    if (!this._hystSets) this._hystSets = new Map()
    let prevSet = this._hystSets.get(queryKey)
    const results = out || []
    if (out) results.length = 0
    const cx = position[0], cy = position[1], cz = position[2]
    const r2 = radius * radius
    const outerRadius = radius * hysteresisFactor
    const outerR2 = outerRadius * outerRadius
    const minCx = cellCoord(cx - outerRadius), maxCx = cellCoord(cx + outerRadius)
    const minCz = cellCoord(cz - outerRadius), maxCz = cellCoord(cz + outerRadius)
    const nextSet = new Set()
    for (let gx = minCx; gx <= maxCx; gx++) {
      for (let gz = minCz; gz <= maxCz; gz++) {
        const bucket = this._cells.get(cellKey(gx, gz))
        if (!bucket) continue
        for (let i = 0; i < bucket.length; i++) {
          const id = bucket[i]
          const p = this._entities.get(id)
          if (!p) continue
          const dx = p[0] - cx, dy = p[1] - cy, dz = p[2] - cz
          const d2 = dx * dx + dy * dy + dz * dz
          // Include if inside the base radius (always), OR inside the outer sticky ring AND was
          // already included last call for this queryKey (stays until it clears the outer ring).
          if (d2 <= r2 || (d2 <= outerR2 && prevSet && prevSet.has(id))) {
            results.push(id)
            nextSet.add(id)
          }
        }
      }
    }
    this._hystSets.set(queryKey, nextSet)
    return results
  }

  // Drop a queryKey's hysteresis memory (a cell that's no longer subscribed by any viewer, or a
  // world/stage reset) so it doesn't silently accumulate unbounded Map entries over a long session.
  clearHysteresisKey(queryKey) {
    if (this._hystSets) this._hystSets.delete(queryKey)
  }

  // Priority-accumulate starvation guard (Halo/Overwatch-style): a radius-bounded AOI query can
  // starve an entity indefinitely if it never enters any viewer's relevance radius (a distant but
  // slowly-approaching player, a far-off large structure a viewer never gets close enough to). Call
  // markSeen(id, viewerKey) for every id a query actually includes; call collectStarved(viewerKey,
  // maxTicksStarved) once per viewer per tick to get back any entity that's gone unseen by THAT
  // viewer for too many ticks and force-include it once (resets its counter on inclusion, so a
  // starved id doesn't get force-sent every tick forever -- one guaranteed appearance per starvation
  // window is enough to keep state eventually-consistent without spamming bandwidth).
  markSeen(id, viewerKey) {
    if (!this._starveTicks) this._starveTicks = new Map() // viewerKey -> Map<id, ticksSinceSeen>
    let m = this._starveTicks.get(viewerKey)
    if (!m) { m = new Map(); this._starveTicks.set(viewerKey, m) }
    m.set(id, 0)
  }

  // A call to collectStarved represents ONE tick's check, not an increment-then-check -- an id whose
  // counter is already at maxTicksStarved-or-beyond (accumulated over PRIOR ticks) force-includes now;
  // this tick's own elapsed time is credited AFTER the check, for the NEXT call to see. Checking
  // pre-increment (not post-increment) matters at the boundary: a markSeen this same tick sets the
  // counter to 0, and 0 must never immediately satisfy maxTicksStarved=1 (verified live: the previous
  // post-increment version starved an id on the very tick it was freshly seen, whenever the caller
  // used a low threshold -- an off-by-one that would have force-included/duplicated an already-visible
  // entity on the next snapshot for any threshold small enough to matter in a real short test).
  collectStarved(viewerKey, maxTicksStarved = 300) {
    if (!this._starveTicks) this._starveTicks = new Map()
    // A viewer that has never called markSeen (never had any relevant-ids query overlap yet) still
    // needs its own clock map created here -- returning early on a missing map silently disabled
    // starvation tracking FOREVER for that viewer, since nothing else ever creates one for a viewer
    // with zero markSeen calls (a real, live-witnessed bug: a viewer whose every query happened to
    // miss an entity from tick 1 never started that entity's clock, so it could never starve-include).
    let m = this._starveTicks.get(viewerKey)
    if (!m) { m = new Map(); this._starveTicks.set(viewerKey, m) }
    const starved = []
    for (const id of this._entities.keys()) {
      if (!m.has(id)) { m.set(id, 0); continue } // never queried for this viewer yet -- start the clock, don't force-send tick 1
      const ticks = m.get(id)
      if (ticks >= maxTicksStarved) { starved.push(id); m.set(id, 0) }
      else m.set(id, ticks + 1)
    }
    // Prune entries for ids no longer in the index (removed entities) so the per-viewer map doesn't
    // grow unbounded across a long session with high entity churn.
    for (const id of m.keys()) if (!this._entities.has(id)) m.delete(id)
    return starved
  }

  clearStarvationKey(viewerKey) {
    if (this._starveTicks) this._starveTicks.delete(viewerKey)
  }

  nearest(position, radius) {
    const cx = position[0], cy = position[1], cz = position[2]
    let bestId = null
    let bestD2 = radius * radius
    const minCx = cellCoord(cx - radius), maxCx = cellCoord(cx + radius)
    const minCz = cellCoord(cz - radius), maxCz = cellCoord(cz + radius)
    for (let gx = minCx; gx <= maxCx; gx++) {
      for (let gz = minCz; gz <= maxCz; gz++) {
        const bucket = this._cells.get(cellKey(gx, gz))
        if (!bucket) continue
        for (let i = 0; i < bucket.length; i++) {
          const id = bucket[i]
          const p = this._entities.get(id)
          if (!p) continue
          const dx = p[0] - cx, dy = p[1] - cy, dz = p[2] - cz
          const d2 = dx * dx + dy * dy + dz * dz
          if (d2 <= bestD2) { bestD2 = d2; bestId = id }
        }
      }
    }
    return bestId
  }

  get size() {
    return this._entities.size
  }

  clear() {
    this._cells.clear()
    this._idCell.clear()
    this._entities.clear()
  }

  rebuild() {
    const entries = Array.from(this._entities.entries())
    this._cells.clear()
    this._idCell.clear()
    this._entities.clear()
    for (const [id, point] of entries) {
      this.insert(id, point)
    }
  }

  get relevanceRadius() {
    return this._relevanceRadius
  }

  set relevanceRadius(v) {
    this._relevanceRadius = v
  }
}
