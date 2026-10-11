import { SpatialIndex } from '../spatial/Octree.js'
import { resolveRelevanceRadius } from '../shared/relevanceRadius.js'

export const FLAT_RING_HALF_HEIGHT_M = Infinity

function resolvedPlanetRadius(stageName, declared) {
  if (declared == null || declared === 0) return 0
  if (!(Number.isFinite(declared) && declared > 0)) {
    throw new TypeError(`[stage] stage "${stageName}" got planetRadius ${JSON.stringify(declared)}: a stage is flat with no radius or planet-centred with a positive finite radius resolved from enabled clusters, and every other value silently picks the cube-sphere cell lattice it cannot serve`)
  }
  return declared
}

export class Stage {
  constructor(name, config = {}) {
    this.name = name
    this.entityIds = new Set()
    this.spatial = new SpatialIndex({ relevanceRadius: resolveRelevanceRadius(config.relevanceRadius) })
    this.spatial.planetRadius = resolvedPlanetRadius(name, config.planetRadius)
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
    return this.getRelevantEntities(position, radius)
  }

  relevanceRing(radius) {
    const r = radius || this.spatial.relevanceRadius
    if (this.spatial.planetRadius > 0) return { spherical: true, radius: r, halfHeight: r }
    return { spherical: false, radius: r, halfHeight: FLAT_RING_HALF_HEIGHT_M }
  }

  getRelevantEntities(position, radius) {
    return this.spatial.nearby(position, radius || this.spatial.relevanceRadius)
  }

  getRelevantEntitiesHorizontal(position, radius) {
    const ring = this.relevanceRing(radius)
    if (ring.spherical) {
      throw new TypeError(`[stage] stage "${this.name}" got a horizontal relevance query at planetRadius ${ring.radius}: a horizontal query is the flat ring's own shape, so a planet-centred stage answers getRelevantEntitiesForCell and never this one`)
    }
    return this.spatial.nearbyCylinder(position, ring.radius, ring.halfHeight)
  }

  getRelevantEntitiesForCell(position, radius) {
    const ring = this.relevanceRing(radius)
    return ring.spherical
      ? this.getRelevantEntities(position, ring.radius)
      : this.getRelevantEntitiesHorizontal(position, ring.radius)
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
