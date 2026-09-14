export class PrefabSpawner {
  constructor(appRuntime, prefabLibrary) {
    if (!appRuntime) throw new Error('PrefabSpawner requires appRuntime')
    this.appRuntime = appRuntime
    this.prefabLibrary = prefabLibrary || null
    this._spawnedRoots = new Map()
  }

  async spawnPrefab(prefabName, position, rotation, overrides = {}) {
    const startMs = Date.now()

    if (!prefabName || typeof prefabName !== 'string') {
      throw new Error('spawnPrefab: prefabName required (string)')
    }
    if (!Array.isArray(position) || position.length !== 3) {
      throw new Error('spawnPrefab: position must be [x,y,z]')
    }
    if (!Array.isArray(rotation) || rotation.length !== 4) {
      throw new Error('spawnPrefab: rotation must be [x,y,z,w]')
    }
    if (typeof overrides !== 'object') {
      throw new Error('spawnPrefab: overrides must be an object')
    }

    if (!this.prefabLibrary) {
      throw new Error('spawnPrefab: prefabLibrary not configured')
    }
    const prefab = await this.prefabLibrary.load(prefabName)
    if (!prefab || !Array.isArray(prefab.entities) || prefab.entities.length === 0) {
      throw new Error(`spawnPrefab: prefab "${prefabName}" invalid or empty`)
    }

    const idToParent = new Map()
    const prefabRootId = prefab.rootId || prefab.entities[0].id
    for (const entity of prefab.entities) {
      if (entity.parent) idToParent.set(entity.id, entity.parent)
    }

    const sortedEntities = this._topologicalSort(prefab.entities, prefabRootId, idToParent)

    const idMap = new Map()
    for (const entity of sortedEntities) {
      const newId = this._generateEntityId(entity.app, entity.model)
      idMap.set(entity.id, newId)
    }

    const spawnedIds = []
    for (const entity of sortedEntities) {
      const newId = idMap.get(entity.id)
      const newParentId = entity.parent ? idMap.get(entity.parent) : null

      const config = this._buildSpawnConfig(entity, newParentId, overrides)

      this.appRuntime.spawnEntity(newId, config)
      spawnedIds.push(newId)
    }

    const newRootId = idMap.get(prefabRootId)
    this._spawnedRoots.set(newRootId, new Set(spawnedIds))

    const rootEntity = this.appRuntime.entities.get(newRootId)
    if (rootEntity) {
      rootEntity.position = [...position]
      rootEntity.rotation = [...rotation]
    }

    const elapsedMs = Date.now() - startMs
    this.appRuntime._log('prefab_spawn', {
      prefabName,
      rootId: newRootId,
      count: spawnedIds.length,
      elapsedMs
    }, { sourceEntity: newRootId })

    return newRootId
  }

  async spawnMultiple(prefabName, positions, rotationOrCallback, overrides = {}) {
    const startMs = Date.now()

    if (!Array.isArray(positions) || positions.length === 0) {
      throw new Error('spawnMultiple: positions must be non-empty array of [x,y,z]')
    }

    const isRotationCallback = typeof rotationOrCallback === 'function'
    const defaultRotation = isRotationCallback ? null : rotationOrCallback || [0, 0, 0, 1]

    if (!isRotationCallback && (!Array.isArray(defaultRotation) || defaultRotation.length !== 4)) {
      throw new Error('spawnMultiple: rotation must be [x,y,z,w] or a function')
    }

    const rootIds = []
    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i]
      const rot = isRotationCallback ? rotationOrCallback(i, pos) : defaultRotation

      if (!Array.isArray(pos) || pos.length !== 3) {
        throw new Error(`spawnMultiple: position[${i}] must be [x,y,z]`)
      }
      if (!Array.isArray(rot) || rot.length !== 4) {
        throw new Error(`spawnMultiple: rotation[${i}] must be [x,y,z,w]`)
      }

      const rootId = await this.spawnPrefab(prefabName, pos, rot, overrides)
      rootIds.push(rootId)
    }

    const elapsedMs = Date.now() - startMs
    this.appRuntime._log('prefab_spawn_multiple', {
      prefabName,
      count: positions.length,
      elapsedMs
    })

    return rootIds
  }

  getSpawnedPrefabInstances(rootId) {
    return this._spawnedRoots.get(rootId) || new Set()
  }

  async updatePrefabInstance(rootId, overrides = {}, cascadeToVariants = false) {
    const spawnedIds = this._spawnedRoots.get(rootId)
    if (!spawnedIds) {
      throw new Error(`updatePrefabInstance: unknown root entity ID "${rootId}"`)
    }

    if (typeof overrides !== 'object') {
      throw new Error('updatePrefabInstance: overrides must be an object')
    }

    let updateCount = 0
    for (const entityId in overrides) {
      if (!spawnedIds.has(entityId)) continue

      const entity = this.appRuntime.entities.get(entityId)
      if (!entity) continue

      const props = overrides[entityId]
      if (!props || typeof props !== 'object') continue

      if (Array.isArray(props.position) && props.position.length === 3) {
        entity.position = [...props.position]
      }
      if (Array.isArray(props.rotation) && props.rotation.length === 4) {
        entity.rotation = [...props.rotation]
      }
      if (Array.isArray(props.scale) && props.scale.length === 3) {
        entity.scale = [...props.scale]
      }

      if (props.custom && typeof props.custom === 'object') {
        entity.custom = { ...(entity.custom || {}), ...props.custom }
      }

      updateCount++
    }

    this.appRuntime._log('prefab_update', {
      rootId,
      updateCount,
      cascadeToVariants
    }, { sourceEntity: rootId })

    return updateCount > 0
  }

  _buildSpawnConfig(entity, parentId, overrides) {
    const config = {
      position: entity.position ? [...entity.position] : [0, 0, 0],
      rotation: entity.rotation ? [...entity.rotation] : [0, 0, 0, 1],
      scale: entity.scale ? [...entity.scale] : [1, 1, 1],
      bodyType: entity.bodyType || 'static',
      custom: entity.custom ? { ...entity.custom } : {}
    }

    if (entity.app) config.app = entity.app
    if (entity.model) config.model = entity.model
    if (entity.collider) config.collider = entity.collider
    if (entity.mass !== undefined) config.mass = entity.mass
    if (entity.config) config.config = { ...entity.config }

    if (parentId) config.parent = parentId

    if (overrides[entity.id]) {
      const ov = overrides[entity.id]
      if (ov.position) config.position = [...ov.position]
      if (ov.rotation) config.rotation = [...ov.rotation]
      if (ov.scale) config.scale = [...ov.scale]
      if (ov.bodyType) config.bodyType = ov.bodyType
      if (ov.mass !== undefined) config.mass = ov.mass

      if (ov.custom && typeof ov.custom === 'object') {
        config.custom = { ...config.custom, ...ov.custom }
      }
    }

    return config
  }

  _topologicalSort(entities, rootId, idToParent) {
    const result = []
    const visited = new Set()

    const visit = (id) => {
      if (visited.has(id)) return
      visited.add(id)

      const entity = entities.find(e => e.id === id)
      if (entity) result.push(entity)

      for (const entity of entities) {
        if (entity.parent === id && !visited.has(entity.id)) {
          visit(entity.id)
        }
      }
    }

    visit(rootId)

    for (const entity of entities) {
      if (!visited.has(entity.id)) {
        visit(entity.id)
      }
    }

    return result
  }

  _generateEntityId(app, model) {
    if (app && app !== '') {
      return app + '-' + Math.random().toString(36).slice(2, 8)
    }
    if (model && model !== '') {
      return 'placed-' + Math.random().toString(36).slice(2, 10)
    }
    return 'entity-' + Math.random().toString(36).slice(2, 10)
  }
}

export function createPrefabSpawner(appRuntime, prefabLibrary) {
  return new PrefabSpawner(appRuntime, prefabLibrary)
}