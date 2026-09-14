const _isNode = typeof process !== 'undefined' && process.versions?.node
const _ecsSpec = _isNode ? '@spoint/ecs' : (() => '/node_modules/' + '@spoint/ecs/src/index.js')()
const { createWorld } = await import(_ecsSpec)

const _ENTITY_COMPONENT = '_entity'

export function createEcsEntityMap() {
  const _world = createWorld()

  const map = {
    set(key, value) {
      if (!_world.exists(key)) {
        _world.createEntity(key)
      }
      _world.addComponent(key, _ENTITY_COMPONENT, value)
      return map
    },

    get(key) {
      return _world.getComponent(key, _ENTITY_COMPONENT)
    },

    has(key) {
      return _world.hasComponent(key, _ENTITY_COMPONENT)
    },

    delete(key) {
      if (_world.exists(key)) {
        _world.destroyEntity(key)
        return true
      }
      return false
    },

    clear() {
      for (const id of _world.entities()) {
        _world.destroyEntity(id)
      }
    },

    get size() {
      return _world.entityCount
    },

    [Symbol.iterator]() {
      return map.entries()
    },

    keys() {
      return _world.entities()[Symbol.iterator]()
    },

    values() {
      const ids = _world.entities()
      let i = 0
      return {
        next() {
          if (i >= ids.length) return { done: true }
          const value = _world.getComponent(ids[i++], _ENTITY_COMPONENT)
          return { value, done: false }
        },
        [Symbol.iterator]() { return this },
      }
    },

    entries() {
      const ids = _world.entities()
      let i = 0
      return {
        next() {
          if (i >= ids.length) return { done: true }
          const key = ids[i]
          const value = _world.getComponent(ids[i++], _ENTITY_COMPONENT)
          return { value: [key, value], done: false }
        },
        [Symbol.iterator]() { return this },
      }
    },

    forEach(callback, thisArg) {
      for (const [key, value] of map) {
        callback.call(thisArg, value, key, map)
      }
    },

    get _ecs() {
      return _world
    },
  }

  return map
}