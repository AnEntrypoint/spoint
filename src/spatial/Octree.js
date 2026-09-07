// Flat uniform grid hash spatial index (replaces the former d3-octree point-octree).
// Cells are cubes of side CELL_SIZE on the XZ plane (Y is ignored for bucketing, matching
// the AOI/relevance-query access pattern of this index -- queries are always a horizontal
// radius around a position). Each cell key maps to an array of entity ids; a side map
// tracks which cell each id currently lives in so remove/update are O(1) instead of an
// O(n) scan.

const CELL_SIZE = 32

function cellCoord(v) {
  return Math.floor(v / CELL_SIZE)
}

// Integer cell key (was the string `cx + ',' + cz`, a fresh string allocation + hash on every bucket
// lookup, i.e. per cell per query). cz is offset into [0, 2^26) and cx scaled by 2^26, so for
// |cx|,|cz| < 2^25 (|world coord| < 2^25*CELL_SIZE ~ 1.07e9 m) the key is an exact, collision-free
// integer below 2^52; anything outside that range (a finite but absurd coordinate) falls back to the
// old string key, which can never collide with a number as a Map key. Keys are internal to
// _cells/_idCell only -- no external reader interprets them.
const KEY_HALF = 33554432   // 2^25
const KEY_SHIFT = 67108864  // 2^26
function cellKey(cx, cz) {
  if (cx >= -KEY_HALF && cx < KEY_HALF && cz >= -KEY_HALF && cz < KEY_HALF) return cx * KEY_SHIFT + (cz + KEY_HALF)
  return cx + ',' + cz
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
    // Per-queryKey two-buffer pair {a: last call's included set, b: scratch}: this call reads `a` and
    // fills a cleared `b`, then the two swap -- no fresh Set allocation per call (was one per cell per
    // tick), and the read set is never the one being written, so results are identical.
    if (!this._hystSets) this._hystSets = new Map()
    let pair = this._hystSets.get(queryKey)
    if (!pair) { pair = { a: null, b: new Set() }; this._hystSets.set(queryKey, pair) }
    const prevSet = pair.a
    const results = out || []
    if (out) results.length = 0
    const cx = position[0], cy = position[1], cz = position[2]
    const r2 = radius * radius
    const outerRadius = radius * hysteresisFactor
    const outerR2 = outerRadius * outerRadius
    const minCx = cellCoord(cx - outerRadius), maxCx = cellCoord(cx + outerRadius)
    const minCz = cellCoord(cz - outerRadius), maxCz = cellCoord(cz + outerRadius)
    const nextSet = pair.b; nextSet.clear()
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
    pair.b = prevSet || new Set(); pair.a = nextSet
    return results
  }

  // Drop a queryKey's hysteresis memory (a cell that's no longer subscribed by any viewer, or a
  // world/stage reset) so it doesn't silently accumulate unbounded Map entries over a long session.
  clearHysteresisKey(queryKey) {
    if (this._hystSets) this._hystSets.delete(queryKey)
  }

  // Output-identical bounded cleanup for the two per-queryKey memories (hysteresis pairs above,
  // starvation clocks below), called by TickHandler on an amortized cadence with the set of keys
  // queried this tick. A key is dropped ONLY when its memory is already EMPTY (an empty hysteresis
  // prev-set / an empty starvation clock map) -- for such a key the next query behaves exactly as if
  // the memory had been retained, so this never changes a query result. A non-empty memory is
  // deliberately kept even when the key is idle: dropping it would reset the sticky ring / starvation
  // clocks the next time the cell is re-entered, a real (if subtle) output change. Bounds growth to
  // "cells that currently hold a non-empty memory", not "every cell ever queried".
  pruneIdleKeys(liveKeys) {
    if (this._hystSets) {
      for (const [key, pair] of this._hystSets) {
        if (!liveKeys.has(key) && (!pair.a || pair.a.size === 0)) this._hystSets.delete(key)
      }
    }
    if (this._starveTicks) {
      for (const [key, v] of this._starveTicks) {
        if (!liveKeys.has(key) && v.zero.size === 0) this._starveTicks.delete(key)
      }
    }
  }

  // Priority-accumulate starvation guard (Halo/Overwatch-style): a radius-bounded AOI query can
  // starve an entity indefinitely if it never enters any viewer's relevance radius (a distant but
  // slowly-approaching player, a far-off large structure a viewer never gets close enough to). Call
  // markSeen(id, viewerKey) for every id a query actually includes; call collectStarved(viewerKey,
  // maxTicksStarved) once per viewer per tick to get back any entity that's gone unseen by THAT
  // viewer for too many ticks and force-include it once (resets its counter on inclusion, so a
  // starved id doesn't get force-sent every tick forever -- one guaranteed appearance per starvation
  // window is enough to keep state eventually-consistent without spamming bandwidth).
  // Storage is `viewerKey -> { c, zero }`: `c` counts this viewer's completed collectStarved calls and
  // `zero` maps id -> the value of `c` at which that id's clock last read 0 (a markSeen, a force-include,
  // or its first observation). An id's ticks-since-seen at the check inside call number c+1 is then
  // simply `c - zero[id]` -- so the per-call scan is a READ per entity (one Map.get + compare), not a
  // write per entity (the old per-viewer `ticks -> ticks+1` Map.set for every entity every call).
  // Derivation against the old increment-then-store form: markSeen set ticks=0 and the same tick's call
  // left it at 1 -> zero = c (completed BEFORE that call); a force-include / first observation set 0 and
  // did NOT increment that call -> zero = c + 1 (completed INCLUDING that call). Both then read k after
  // k further calls. Verified identical on a real 2-client run (see the netcode perf session's witness).
  _starveViewer(viewerKey) {
    if (!this._starveTicks) this._starveTicks = new Map()
    let v = this._starveTicks.get(viewerKey)
    if (!v) { v = { c: 0, zero: new Map() }; this._starveTicks.set(viewerKey, v) }
    return v
  }

  markSeen(id, viewerKey) {
    const v = this._starveViewer(viewerKey)
    v.zero.set(id, v.c)
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
    // A viewer that has never called markSeen (never had any relevant-ids query overlap yet) still
    // needs its own clock map created here -- returning early on a missing map silently disabled
    // starvation tracking FOREVER for that viewer, since nothing else ever creates one for a viewer
    // with zero markSeen calls (a real, live-witnessed bug: a viewer whose every query happened to
    // miss an entity from tick 1 never started that entity's clock, so it could never starve-include).
    const v = this._starveViewer(viewerKey)
    const zero = v.zero, c = v.c
    const starved = []
    for (const id of this._entities.keys()) {
      const z = zero.get(id)
      if (z === undefined) { zero.set(id, c + 1); continue } // never queried for this viewer yet -- start the clock, don't force-send tick 1
      if (c - z >= maxTicksStarved) { starved.push(id); zero.set(id, c + 1) }
    }
    v.c = c + 1
    // Prune entries for ids no longer in the index (removed entities) so the per-viewer map doesn't
    // grow unbounded across a long session with high entity churn. The scan above guarantees every
    // live id has an entry, so `zero.size === _entities.size` means there is nothing stale to drop --
    // the O(entries) walk runs only when a removal actually left a stale entry behind (same drop
    // timing as before: at the first call after the removal).
    if (zero.size !== this._entities.size) { for (const id of zero.keys()) if (!this._entities.has(id)) zero.delete(id) }
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
