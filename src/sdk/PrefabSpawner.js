// Server-side prefab spawning with hierarchical entity tree support.
// Handles prefab loading, recursive spawning, parent-child linking, and property overrides.
// Integrates with AppRuntime for entity spawning and physics.

export class PrefabSpawner {
  constructor(appRuntime, prefabLibrary) {
    if (!appRuntime) throw new Error('PrefabSpawner requires appRuntime')
    this.appRuntime = appRuntime
    this.prefabLibrary = prefabLibrary || null
    this._spawnedRoots = new Map() // rootId -> Set of all child entity IDs
  }

  /**
   * Spawn a prefab instance into the world with optional property overrides.
   * Loads prefab definition, recursively spawns entity tree, applies overrides.
   *
   * @param {string} prefabName - Name of prefab to load from library
   * @param {number[]} position - World position [x,y,z] for root entity
   * @param {number[]} rotation - World rotation [x,y,z,w] quat for root entity
   * @param {object} overrides - Per-entity property overrides: { entityId: { position, rotation, scale, custom.*, etc } }
   * @returns {Promise<string>} Root entity ID
   * @throws If prefab not found, invalid, or spawn fails
   */
  async spawnPrefab(prefabName, position, rotation, overrides = {}) {
    const startMs = Date.now()

    // Validate inputs
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

    // Load prefab definition
    if (!this.prefabLibrary) {
      throw new Error('spawnPrefab: prefabLibrary not configured')
    }
    const prefab = await this.prefabLibrary.load(prefabName)
    if (!prefab || !Array.isArray(prefab.entities) || prefab.entities.length === 0) {
      throw new Error(`spawnPrefab: prefab "${prefabName}" invalid or empty`)
    }

    // Build id->parentId map and determine root
    const idToParent = new Map()
    const prefabRootId = prefab.rootId || prefab.entities[0].id
    for (const entity of prefab.entities) {
      if (entity.parent) idToParent.set(entity.id, entity.parent)
    }

    // Topologically sort entities: root first, then children in order
    const sortedEntities = this._topologicalSort(prefab.entities, prefabRootId, idToParent)

    // Pass 1: Create ID mapping (old prefab ID -> new runtime ID)
    const idMap = new Map()
    for (const entity of sortedEntities) {
      const newId = this._generateEntityId(entity.app, entity.model)
      idMap.set(entity.id, newId)
    }

    // Pass 2: Spawn all entities in topological order
    const spawnedIds = []
    for (const entity of sortedEntities) {
      const newId = idMap.get(entity.id)
      const newParentId = entity.parent ? idMap.get(entity.parent) : null

      // Build spawn config from prefab entity + overrides
      const config = this._buildSpawnConfig(entity, newParentId, overrides)

      // Spawn the entity
      this.appRuntime.spawnEntity(newId, config)
      spawnedIds.push(newId)
    }

    // Pass 3: Set up root-tracking for later queries
    const newRootId = idMap.get(prefabRootId)
    this._spawnedRoots.set(newRootId, new Set(spawnedIds))

    // Apply world transform to root entity
    const rootEntity = this.appRuntime.entities.get(newRootId)
    if (rootEntity) {
      rootEntity.position = [...position]
      rootEntity.rotation = [...rotation]
    }

    // Performance log
    const elapsedMs = Date.now() - startMs
    this.appRuntime._log('prefab_spawn', {
      prefabName,
      rootId: newRootId,
      count: spawnedIds.length,
      elapsedMs
    }, { sourceEntity: newRootId })

    return newRootId
  }

  /**
   * Spawn multiple prefab instances efficiently.
   * Positions is array of [x,y,z]. Returns array of root entity IDs.
   *
   * @param {string} prefabName - Name of prefab to spawn multiple times
   * @param {number[][]} positions - Array of [x,y,z] positions
   * @param {number[]|function} rotationOrCallback - Rotation [x,y,z,w] or callback(index,position)->rotation
   * @param {object} overrides - Per-entity property overrides (applied to all instances)
   * @returns {Promise<string[]>} Array of root entity IDs
   */
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

  /**
   * Get all child entity IDs spawned as part of a prefab root instance.
   * Returns a Set of all entities in the prefab tree (including root).
   *
   * @param {string} rootId - Root entity ID returned from spawnPrefab
   * @returns {Set<string>} Set of all entity IDs in this prefab instance
   */
  getSpawnedPrefabInstances(rootId) {
    return this._spawnedRoots.get(rootId) || new Set()
  }

  /**
   * Update properties on a spawned prefab instance.
   * Optionally cascade updates to variant prefabs that inherit from this one.
   *
   * @param {string} rootId - Root entity ID
   * @param {object} overrides - Property overrides: { entityId: { property: value }, ... }
   * @param {boolean} cascadeToVariants - If true, push update to variant prefabs (future: not yet implemented)
   * @returns {boolean} True if update succeeded
   */
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

      // Apply each property override
      if (Array.isArray(props.position) && props.position.length === 3) {
        entity.position = [...props.position]
      }
      if (Array.isArray(props.rotation) && props.rotation.length === 4) {
        entity.rotation = [...props.rotation]
      }
      if (Array.isArray(props.scale) && props.scale.length === 3) {
        entity.scale = [...props.scale]
      }

      // Custom property merge (nested)
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

  /**
   * Build spawn config for an entity from prefab definition + overrides.
   * Handles position, rotation, scale, custom properties, app, model, collider, bodyType, parent.
   *
   * @private
   */
  _buildSpawnConfig(entity, parentId, overrides) {
    const config = {
      position: entity.position ? [...entity.position] : [0, 0, 0],
      rotation: entity.rotation ? [...entity.rotation] : [0, 0, 0, 1],
      scale: entity.scale ? [...entity.scale] : [1, 1, 1],
      bodyType: entity.bodyType || 'static',
      custom: entity.custom ? { ...entity.custom } : {}
    }

    // Add optional properties
    if (entity.app) config.app = entity.app
    if (entity.model) config.model = entity.model
    if (entity.collider) config.collider = entity.collider
    if (entity.mass !== undefined) config.mass = entity.mass
    if (entity.config) config.config = { ...entity.config }

    // Parent link
    if (parentId) config.parent = parentId

    // Apply per-entity overrides
    if (overrides[entity.id]) {
      const ov = overrides[entity.id]
      if (ov.position) config.position = [...ov.position]
      if (ov.rotation) config.rotation = [...ov.rotation]
      if (ov.scale) config.scale = [...ov.scale]
      if (ov.bodyType) config.bodyType = ov.bodyType
      if (ov.mass !== undefined) config.mass = ov.mass

      // Nested custom merge
      if (ov.custom && typeof ov.custom === 'object') {
        config.custom = { ...config.custom, ...ov.custom }
      }
    }

    return config
  }

  /**
   * Topologically sort entities so parents spawn before children.
   * Root first, then depth-first traversal of children.
   *
   * @private
   */
  _topologicalSort(entities, rootId, idToParent) {
    const result = []
    const visited = new Set()

    const visit = (id) => {
      if (visited.has(id)) return
      visited.add(id)

      const entity = entities.find(e => e.id === id)
      if (entity) result.push(entity)

      // Find and visit all direct children
      for (const entity of entities) {
        if (entity.parent === id && !visited.has(entity.id)) {
          visit(entity.id)
        }
      }
    }

    // Start from root and traverse depth-first
    visit(rootId)

    // Append any remaining unvisited entities (disconnected)
    for (const entity of entities) {
      if (!visited.has(entity.id)) {
        visit(entity.id)
      }
    }

    return result
  }

  /**
   * Generate a unique runtime entity ID based on app name or model.
   * Mirrors EditorHandlers.js pattern for consistency.
   *
   * @private
   */
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