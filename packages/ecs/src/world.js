/**
 * world.js -- ECS World: entity lifecycle, component storage, system scheduling.
 *
 * Shared between spoint and thebird. An ECS World is a container that owns
 * entities, their components, and the systems that operate on them.
 *
 * Design (matching thebird lib/ecs.js conventions):
 *  - Entity = numeric id (monotonic counter)
 *  - Component = plain object stored in a Map<entityId, componentData>
 *  - System = { update(world, dt) } called every tick
 *  - World manages entity creation/destruction, component add/remove/has/get,
 *    and system registration/execution
 *
 * This is the FIRST SLICE of the shared package. Thebird's lib/ecs.js has
 * additional features (archetype queries, tag components, prefab instantiation)
 * that will be ported in subsequent slices once the base contract is stable.
 */

let _nextEntityId = 1

export function createWorld() {
  const _entities = new Set()
  const _components = new Map() // componentName -> Map<entityId, data>
  const _systems = []           // { name, update, priority }
  let _destroyed = false
  let _changeVersion = 0        // incremented on every structural mutation

  /**
   * Create a new entity. Returns the entity id.
   * If an optional `id` argument is passed, it is used directly (string or number);
   * otherwise an auto-incremented numeric id is generated.
   */
  function createEntity(id) {
    if (_destroyed) throw new Error('World is destroyed')
    if (id === undefined) {
      id = _nextEntityId++
    } else if (typeof id === 'number' && id >= _nextEntityId) {
      _nextEntityId = id + 1
    }
    _entities.add(id)
    _changeVersion++
    return id
  }

  /**
   * Destroy an entity and all its components. Idempotent.
   */
  function destroyEntity(id) {
    _entities.delete(id)
    for (const [, store] of _components) {
      store.delete(id)
    }
    _changeVersion++
  }

  /**
   * Check if an entity exists (has not been destroyed).
   */
  function exists(id) {
    return _entities.has(id)
  }

  /**
   * Get all alive entity ids. Returns an array (snapshot).
   */
  function entities() {
    return [..._entities]
  }

  /**
   * Add a component to an entity. Overwrites if already present.
   * Returns the component data.
   */
  function addComponent(id, name, data) {
    if (!_entities.has(id)) throw new Error(`Entity ${id} does not exist`)
    if (!_components.has(name)) _components.set(name, new Map())
    _components.get(name).set(id, data)
    _changeVersion++
    return data
  }

  /**
   * Remove a component from an entity. Idempotent.
   */
  function removeComponent(id, name) {
    const store = _components.get(name)
    if (store) {
      store.delete(id)
      _changeVersion++
    }
  }

  /**
   * Check if an entity has a component.
   */
  function hasComponent(id, name) {
    const store = _components.get(name)
    return store ? store.has(id) : false
  }

  /**
   * Get a component value for an entity. Returns undefined if not present.
   */
  function getComponent(id, name) {
    const store = _components.get(name)
    return store ? store.get(id) : undefined
  }

  /**
   * Get all component names registered in this world.
   */
  function componentNames() {
    return [..._components.keys()]
  }

  /**
   * Get all entities that have a given component.
   */
  function entitiesWith(name) {
    const store = _components.get(name)
    return store ? [...store.keys()] : []
  }

  // --- Tag components (boolean flags) ---
  // Tags are stored as components with `true` data. They are lightweight
  // boolean flags that can be queried efficiently — the bird's original
  // ecs.js uses the same convention (Map<type, data> where data is any value,
  // including `true` for tags). These are convenience wrappers around the
  // existing component API.

  /**
   * Add a tag to an entity. Tags are boolean flags (component data = true).
   * Idempotent — adding the same tag twice is a no-op.
   */
  function addTag(id, name) {
    return addComponent(id, name, true)
  }

  /**
   * Remove a tag from an entity. Idempotent.
   */
  function removeTag(id, name) {
    removeComponent(id, name)
  }

  /**
   * Check if an entity has a tag.
   */
  function hasTag(id, name) {
    return hasComponent(id, name)
  }

  /**
   * Get all entities that have a given tag.
   */
  function entitiesWithTag(name) {
    return entitiesWith(name)
  }

  // --- Prefab instantiation (entity templates with nested children) ---
  // A prefab spec is { components: { name: data, ... }, tags: [name, ...], children: [spec, ...] }.
  // createPrefab instantiates one entity from the spec (with optional overrides
  // merged into the component data), then recursively instantiates any child specs.
  // Returns { id, children } where children is an array of child result objects
  // (each also { id, children }).

  /**
   * Instantiate an entity from a prefab spec, recursively creating children.
   *
   * @param {object} spec
   * @param {object} [spec.components] - component name -> data map
   * @param {string[]} [spec.tags] - tag names to add
   * @param {object[]} [spec.children] - nested prefab specs to instantiate as children
   * @param {object} [overrides] - optional component data overrides (shallow-merged)
   * @returns {{ id: number, children: Array<{ id: number, children: Array }> }}
   */
  function createPrefab(spec, overrides) {
    if (_destroyed) throw new Error('World is destroyed')
    const id = createEntity()
    if (spec.components) {
      for (const [name, data] of Object.entries(spec.components)) {
        const merged = (overrides && overrides[name] !== undefined)
          ? { ...data, ...overrides[name] }
          : data
        addComponent(id, name, merged)
      }
    }
    if (spec.tags) {
      for (const name of spec.tags) {
        addTag(id, name)
      }
    }
    const children = []
    if (spec.children) {
      for (const childSpec of spec.children) {
        children.push(createPrefab(childSpec))
      }
    }
    return { id, children }
  }

  /**
   * Register a system. Systems are called in priority order (lower = earlier).
   * Returns an unregister function.
   */
  function registerSystem(name, update, priority = 0) {
    const sys = { name, update, priority }
    _systems.push(sys)
    _systems.sort((a, b) => a.priority - b.priority)
    return function unregister() {
      const idx = _systems.indexOf(sys)
      if (idx >= 0) _systems.splice(idx, 1)
    }
  }

  /**
   * Run all registered systems with the given dt.
   */
  function update(dt) {
    if (_destroyed) return
    for (const sys of _systems) {
      sys.update(this, dt)
    }
  }

  /**
   * Destroy the world: remove all entities, components, and systems.
   */
  function destroy() {
    _destroyed = true
    _entities.clear()
    _components.clear()
    _systems.length = 0
    _changeVersion++
  }

  /**
   * Snapshot the world state (for serialization/debugging).
   * Returns { entities: [...], components: { name: { entityId: data } } }
   */
  function snapshot() {
    const comps = {}
    for (const [name, store] of _components) {
      comps[name] = Object.fromEntries(store)
    }
    return {
      entities: [..._entities],
      components: comps,
    }
  }

  /**
   * Restore world state from a snapshot. Clears existing state first.
   */
  function restore(snap) {
    _entities.clear()
    _components.clear()
    _systems.length = 0
    _destroyed = false
    for (const id of snap.entities) {
      _entities.add(id)
      if (typeof id === 'number' && id >= _nextEntityId) _nextEntityId = id + 1
    }
    for (const [name, store] of Object.entries(snap.components || {})) {
      const map = new Map(Object.entries(store).map(([k, v]) => [Number(k), v]))
      _components.set(name, map)
    }
    _changeVersion++
  }

  return {
    createEntity, destroyEntity, exists, entities,
    addComponent, removeComponent, hasComponent, getComponent,
    componentNames, entitiesWith,
    addTag, removeTag, hasTag, entitiesWithTag,
    createPrefab,
    registerSystem, update,
    destroy, snapshot, restore,
    get destroyed() { return _destroyed },
    get entityCount() { return _entities.size },
    get version() { return _changeVersion },
  }
}