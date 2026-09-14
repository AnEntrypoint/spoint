let _nextEntityId = 1

export function createWorld() {
  const _entities = new Set()
  const _components = new Map()
  const _systems = []
  let _destroyed = false
  let _changeVersion = 0

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

  function destroyEntity(id) {
    _entities.delete(id)
    for (const [, store] of _components) {
      store.delete(id)
    }
    _changeVersion++
  }

  function exists(id) {
    return _entities.has(id)
  }

  function entities() {
    return [..._entities]
  }

  function addComponent(id, name, data) {
    if (!_entities.has(id)) throw new Error(`Entity ${id} does not exist`)
    if (!_components.has(name)) _components.set(name, new Map())
    _components.get(name).set(id, data)
    _changeVersion++
    return data
  }

  function removeComponent(id, name) {
    const store = _components.get(name)
    if (store) {
      store.delete(id)
      _changeVersion++
    }
  }

  function hasComponent(id, name) {
    const store = _components.get(name)
    return store ? store.has(id) : false
  }

  function getComponent(id, name) {
    const store = _components.get(name)
    return store ? store.get(id) : undefined
  }

  function componentNames() {
    return [..._components.keys()]
  }

  function entitiesWith(name) {
    const store = _components.get(name)
    return store ? [...store.keys()] : []
  }

  function addTag(id, name) {
    return addComponent(id, name, true)
  }

  function removeTag(id, name) {
    removeComponent(id, name)
  }

  function hasTag(id, name) {
    return hasComponent(id, name)
  }

  function entitiesWithTag(name) {
    return entitiesWith(name)
  }

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

  function registerSystem(name, update, priority = 0) {
    const sys = { name, update, priority }
    _systems.push(sys)
    _systems.sort((a, b) => a.priority - b.priority)
    return function unregister() {
      const idx = _systems.indexOf(sys)
      if (idx >= 0) _systems.splice(idx, 1)
    }
  }

  function update(dt) {
    if (_destroyed) return
    for (const sys of _systems) {
      sys.update(this, dt)
    }
  }

  function destroy() {
    _destroyed = true
    _entities.clear()
    _components.clear()
    _systems.length = 0
    _changeVersion++
  }

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