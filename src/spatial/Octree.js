import { octree } from 'd3-octree'

export class SpatialIndex {
  constructor(config = {}) {
    this._tree = octree()
    this._entities = new Map()
    this._relevanceRadius = config.relevanceRadius || 200
  }

  insert(id, position) {
    this.remove(id)
    const point = [position[0], position[1], position[2]]
    point._entityId = id
    this._entities.set(id, point)
    this._tree.add(point)
  }

  remove(id) {
    const existing = this._entities.get(id)
    if (!existing) return
    this._tree.remove(existing)
    this._entities.delete(id)
  }

  update(id, position) {
    this.insert(id, position)
  }

  has(id) {
    return this._entities.has(id)
  }

  getPosition(id) {
    const p = this._entities.get(id)
    return p ? [p[0], p[1], p[2]] : null
  }

  nearby(position, radius) {
    const cx = position[0], cy = position[1], cz = position[2]
    const r2 = radius * radius
    const results = []
    this._tree.visit((node, x0, y0, z0, x1, y1, z1) => {
      if (!node.length) {
        let d = node
        do {
          const p = d.data
          const dx = p[0] - cx, dy = p[1] - cy, dz = p[2] - cz
          if (dx * dx + dy * dy + dz * dz <= r2) {
            results.push(p._entityId)
          }
        } while (d = d.next)
      }
      const nx = Math.max(x0, Math.min(cx, x1))
      const ny = Math.max(y0, Math.min(cy, y1))
      const nz = Math.max(z0, Math.min(cz, z1))
      const ddx = nx - cx, ddy = ny - cy, ddz = nz - cz
      return ddx * ddx + ddy * ddy + ddz * ddz > r2
    })
    return results
  }

  nearest(position, radius) {
    const p = this._tree.find(position[0], position[1], position[2], radius)
    return p ? p._entityId : null
  }

  get size() {
    return this._entities.size
  }

  clear() {
    this._tree = octree()
    this._entities.clear()
  }

  rebuild() {
    const entries = Array.from(this._entities.entries())
    this._tree = octree()
    for (const [, point] of entries) {
      this._tree.add(point)
    }
  }

  get relevanceRadius() {
    return this._relevanceRadius
  }

  set relevanceRadius(v) {
    this._relevanceRadius = v
  }
}
