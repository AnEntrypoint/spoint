import { SpatialIndex } from '../spatial/Octree.js'

export class Stage {
  constructor(name, config = {}) {
    this.name = name
    this.entityIds = new Set()
    this.spatial = new SpatialIndex({ relevanceRadius: config.relevanceRadius || 200 })
    // planetRadius (meters): opts this world into curved-space cube-sphere AOI cell addressing in
    // TickHandler.js (0/unset = flat Euclidean XZ grid, correct for a single non-reanchoring
    // tangent-plane world -- PlanetFrame.js's default). Set to the sphere radius (matching
    // mapspinner's quadtree `size` / PlanetFrame's sampler.radius) for a world whose relevanceRadius
    // cells may span cube-sphere face boundaries.
    this.spatial.planetRadius = config.planetRadius || 0
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
    return this.spatial.nearby(position, radius || this.spatial.relevanceRadius)
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
    for (const id of this._runtime._activeDynamicIds) {
      if (!this.entityIds.has(id)) continue
      const e = this._runtime.getEntity(id)
      if (e) this.spatial.update(id, e.position)
    }
    // Dynamic entities with NO physics body (app code drives entity.position directly every tick, e.g.
    // a scripted/kinematic ball with no ctx.physics.addXCollider call) never fire onBodyActivated and so
    // are absent from _activeDynamicIds -- without this, the spatial index's point for such an entity is
    // frozen forever at its spawn position, so relevance queries (getRelevantEntities, used by
    // TickHandler's per-player snapshot filter) silently use a stale location. Witnessed live: a
    // physics-body-less entity's true position drifted 50 units from spawn while the octree still
    // reported the spawn point, causing it to incorrectly drop out of / stay stuck in a viewer's
    // relevance radius depending on where the viewer stood relative to the STALE point, not the real one.
    if (typeof this._runtime.getUnmanagedDynamicIds === 'function') {
      for (const id of this._runtime.getUnmanagedDynamicIds()) {
        if (!this.entityIds.has(id)) continue
        const e = this._runtime.getEntity(id)
        if (e) this.spatial.update(id, e.position)
      }
    }
  }

  getAllEntityIds() {
    return Array.from(this.entityIds)
  }
}
