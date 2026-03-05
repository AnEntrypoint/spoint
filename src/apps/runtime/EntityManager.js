export class EntityManager {
  constructor(runtime) {
    this._runtime = runtime
    this.entities = new Map()
    this._nextEntityId = 1
    this._staticVersion = 0
    this._dynamicEntityIds = new Set()
    this._staticEntityIds = new Set()
    this._intIdMap = new Map()
    this._nextInternalId = 1
    this._needsEntityListRebuild = true
    this._allEntities = []
    this._dynamicEntities = []
  }

  spawnEntity(id, config = {}) {
    const entityId = id || `entity_${this._nextEntityId++}`
    const spawnPos = config.position ? [...config.position] : [0, 0, 0]
    const entity = {
      id: entityId, model: config.model || null,
      position: [...spawnPos],
      rotation: config.rotation || [0, 0, 0, 1],
      scale: config.scale ? [...config.scale] : [1, 1, 1],
      velocity: [0, 0, 0], mass: 1, bodyType: 'static', collider: null,
      parent: null, children: new Set(),
      _appState: null, _appName: config.app || null, _config: config.config || null, custom: null,
      _spawnPosition: spawnPos
    }
    this.entities.set(entityId, entity)
    this._needsEntityListRebuild = true
    entity._intId = this._nextInternalId++
    this._intIdMap.set(entityId, entity._intId)
    this._staticVersion++
    if (entity.bodyType !== 'static') this._dynamicEntityIds.add(entityId)
    else this._staticEntityIds.add(entityId)
    this._runtime._log('entity_spawn', { id: entityId, config }, { sourceEntity: entityId })
    if (config.parent) {
      const p = this.entities.get(config.parent)
      if (p) { entity.parent = config.parent; p.children.add(entityId) }
    }
    if (config.autoTrimesh && entity.model && this._runtime._physics) {
      entity.collider = { type: 'trimesh', model: entity.model }
      this._runtime._physics.addStaticTrimeshAsync(this._runtime.resolveAssetPath(entity.model), 0, entity.position || [0,0,0])
        .then(id => { entity._physicsBodyId = id })
        .catch(e => console.error(`[AppRuntime] Failed to create trimesh for ${entity.model}:`, e.message))
    }
    if (config.app) this._runtime._appManager.attachApp(entityId, config.app).catch(e => console.error(`[AppRuntime] Failed to attach app ${config.app}:`, e.message))
    this._runtime._spatialInsert(entity)
    return entity
  }

  destroyEntity(entityId) {
    const entity = this.entities.get(entityId); if (!entity) return
    this._staticVersion++
    this._dynamicEntityIds.delete(entityId)
    this._staticEntityIds.delete(entityId)
    this._intIdMap.delete(entityId)
    this._runtime._activeDynamicIds.delete(entityId)
    this._runtime._suspendedEntityIds.delete(entityId)
    this._runtime._interactableIds.delete(entityId)
    if (entity._physicsBodyId !== undefined) this._runtime._physicsBodyToEntityId.delete(entity._physicsBodyId)
    this._runtime._log('entity_destroy', { id: entityId }, { sourceEntity: entityId })
    for (const childId of [...entity.children]) this.destroyEntity(childId)
    if (entity.parent) { const p = this.entities.get(entity.parent); if (p) p.children.delete(entityId) }
    this._runtime._eventBus.destroyScope(entityId)
    this._runtime._appManager.detachApp(entityId); this._runtime._spatialRemove(entityId); this.entities.delete(entityId)
    this._needsEntityListRebuild = true
  }

  _rebuildEntityLists() {
    if (!this._needsEntityListRebuild) return
    this._allEntities = Array.from(this.entities.values())
    this._dynamicEntities = this._allEntities.filter(e => e.bodyType !== 'static')
    this._needsEntityListRebuild = false
  }
}
