const CELL_SIZE = 32

function cellCoord(v) {
  return Math.floor(v / CELL_SIZE)
}

const KEY_HALF = 33554432
const KEY_SHIFT = 67108864
function cellKey(cx, cz) {
  if (cx >= -KEY_HALF && cx < KEY_HALF && cz >= -KEY_HALF && cz < KEY_HALF) return cx * KEY_SHIFT + (cz + KEY_HALF)
  return cx + ',' + cz
}

export class SpatialIndex {
  constructor(config = {}) {
    this._cells = new Map()
    this._idCell = new Map()
    this._entities = new Map()
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

  nearbyHysteresis(position, radius, queryKey, hysteresisFactor = 1.15, out) {
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

  clearHysteresisKey(queryKey) {
    if (this._hystSets) this._hystSets.delete(queryKey)
  }

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

  collectStarved(viewerKey, maxTicksStarved = 300) {
    const v = this._starveViewer(viewerKey)
    const zero = v.zero, c = v.c
    const starved = []
    for (const id of this._entities.keys()) {
      const z = zero.get(id)
      if (z === undefined) { zero.set(id, c + 1); continue }
      if (c - z >= maxTicksStarved) { starved.push(id); zero.set(id, c + 1) }
    }
    v.c = c + 1
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
