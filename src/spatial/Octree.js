import { resolveRelevanceRadius } from '../shared/relevanceRadius.js'

const CELL_SIZE = 32

const MOVE_TOLERANCE_SQ = 1.0

function cellCoord(v) {
  return Math.floor(v / CELL_SIZE)
}

const KEY_HALF = 33554432
const KEY_SHIFT = 67108864
function cellKey(cx, cz) {
  if (cx >= -KEY_HALF && cx < KEY_HALF && cz >= -KEY_HALF && cz < KEY_HALF) return cx * KEY_SHIFT + (cz + KEY_HALF)
  return cx + ',' + cz
}

function placeInto(cells, idCell, id, point) {
  const key = cellKey(cellCoord(point[0]), cellCoord(point[2]))
  let bucket = cells.get(key)
  if (!bucket) { bucket = []; cells.set(key, bucket) }
  bucket.push(id)
  idCell.set(id, key)
}

export class SpatialIndex {
  constructor(config = {}) {
    this._cells = new Map()
    this._idCell = new Map()
    this._entities = new Map()
    this._relevanceRadius = resolveRelevanceRadius(config.relevanceRadius)
    this._mutations = 0
    this._geometryEpoch = 0
  }

  get mutations() {
    return this._mutations
  }

  get geometryEpoch() {
    return this._geometryEpoch
  }

  insert(id, position) {
    this.remove(id)
    const px = position[0], py = position[1], pz = position[2]
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return
    const point = [px, py, pz]
    this._entities.set(id, point)
    placeInto(this._cells, this._idCell, id, point)
    this._mutations++
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
    this._mutations++
  }

  update(id, position) {
    const px = position[0], py = position[1], pz = position[2]
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) { this.remove(id); return }
    const existing = this._entities.get(id)
    if (!existing) { this.insert(id, position); return }
    if (cellKey(cellCoord(px), cellCoord(pz)) !== this._idCell.get(id)) { this.insert(id, position); return }
    const dx = existing[0] - px, dy = existing[1] - py, dz = existing[2] - pz
    if (dx * dx + dy * dy + dz * dz < MOVE_TOLERANCE_SQ) return
    existing[0] = px; existing[1] = py; existing[2] = pz
    this._mutations++
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

  nearbyCylinder(position, radius, halfHeight, out) {
    if (typeof halfHeight !== 'number' || !(halfHeight >= 0)) {
      const shown = typeof halfHeight === 'number' ? String(halfHeight) : JSON.stringify(halfHeight)
      throw new TypeError(`[SpatialIndex] nearbyCylinder got halfHeight ${shown}: a relevance cylinder carries its vertical extent as an argument, so an absent, non-numeric, NaN or negative one is not a query`)
    }
    const results = out || []
    if (out) results.length = 0
    const cx = position[0], cy = position[1], cz = position[2]
    const r2 = radius * radius
    const h2 = halfHeight * halfHeight
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
          if (dx * dx + dz * dz <= r2 && dy * dy <= h2) results.push(id)
        }
      }
    }
    return results
  }

  pruneIdleKeys(liveKeys) {
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
    this._mutations++
  }

  rebuild() {
    const entries = Array.from(this._entities.entries())
    this._cells.clear()
    this._idCell.clear()
    this._entities.clear()
    for (const [id, point] of entries) {
      this.insert(id, point)
    }
    this._mutations++
  }

  reseat(positionOf) {
    const cells = new Map()
    const idCell = new Map()
    const entities = new Map()
    for (const [id] of this._entities) {
      const p = positionOf(id)
      if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) continue
      const point = [p[0], p[1], p[2]]
      entities.set(id, point)
      placeInto(cells, idCell, id, point)
    }
    this._cells = cells
    this._idCell = idCell
    this._entities = entities
    this._mutations++
  }

  get relevanceRadius() {
    return this._relevanceRadius
  }

  set relevanceRadius(v) {
    const previous = this._relevanceRadius
    this._relevanceRadius = resolveRelevanceRadius(v)
    if (this._relevanceRadius === previous) return
    this._geometryEpoch++
    this._mutations++
  }
}
