import { SpatialIndex } from '../spatial/Octree.js'

export class Stage {
  constructor(name, config = {}) {
    this.name = name
    this.entityIds = new Set()
    this.spatial = new SpatialIndex({ relevanceRadius: config.relevanceRadius || 200 })
    this.gravity = config.gravity || null
    this.spawnPoint = config.spawnPoint || null
    this.playerModel = config.playerModel || null
    this._runtime = null
    this._staticIds = new Set()
  }

  bind(runtime) {
    this._runtime = runtime
  }

  addEntity(id, config = {}) {
    if (!this._runtime) return null
    const entity = this._runtime.spawnEntity(id, config)
    this.entityIds.add(entity.id)
    const pos = entity.position || [0, 0, 0]
    this.spatial.insert(entity.id, pos)
    if (entity.bodyType === 'static' || config.autoTrimesh) {
      this._staticIds.add(entity.id)
    }
    return entity
  }

  removeEntity(id) {
    if (!this._runtime) return
    this.spatial.remove(id)
    this._staticIds.delete(id)
    this.entityIds.delete(id)
    this._runtime.destroyEntity(id)
  }

  updateEntityPosition(id, position) {
    if (!this.entityIds.has(id)) return
    this.spatial.update(id, position)
  }

  getNearbyEntities(position, radius) {
    return this.spatial.nearby(position, radius || this.spatial.relevanceRadius)
  }

  getRelevantEntities(position, radius) {
    const nearby = this.spatial.nearby(position, radius || this.spatial.relevanceRadius)
    const set = new Set(nearby)
    for (const sid of this._staticIds) set.add(sid)
    return Array.from(set)
  }

  getStaticIds() {
    return Array.from(this._staticIds)
  }

  hasEntity(id) {
    return this.entityIds.has(id)
  }

  get entityCount() {
    return this.entityIds.size
  }

  clear() {
    if (!this._runtime) return
    for (const id of [...this.entityIds]) {
      this._runtime.destroyEntity(id)
    }
    this.entityIds.clear()
    this._staticIds.clear()
    this.spatial.clear()
  }

  syncPositions() {
    if (!this._runtime) return
    for (const id of this.entityIds) {
      const e = this._runtime.getEntity(id)
      if (e && e.bodyType !== 'static') {
        this.spatial.update(id, e.position)
      }
    }
  }

  getAllEntityIds() {
    return Array.from(this.entityIds)
  }
}
