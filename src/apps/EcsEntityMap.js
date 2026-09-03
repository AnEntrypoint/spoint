/**
 * EcsEntityMap.js -- Map-compatible adapter wrapping an @spoint/ecs world.
 *
 * First slice of cross-project-ecs-replace-appruntime-entity-store:
 * replaces AppRuntime.entities (Map) with an ECS world behind the same
 * Map API surface, so no call site changes.
 *
 * Entity objects are stored as a component named '_entity' in the ECS world.
 * Entity IDs are the same string keys used by AppRuntime (e.g. 'entity_1', 'box1').
 */
// @spoint/ecs is a workspace package (packages/ecs, junctioned into node_modules/@spoint/ecs -- see
// AGENTS.md's workspaces-merged-packages note) -- resolvable Node-side via a plain bare specifier
// through node_modules resolution, but NOT resolvable at all in a browser module Worker context: this
// file is reachable from a browser module Worker via src/sdk/WorkerEntry.js -> AppRuntime.js ->
// EcsEntityMap.js (singleplayer/host boot), and while client/index.html DOES declare an <script
// type="importmap"> remapping bare specifiers like 'three' for the main page's own module graph, a
// dedicated Worker's module graph is a SEPARATE global scope that does not inherit the document's
// import map at all (no mechanism exists to pass one into `new Worker(url, {type:'module'})`) -- so a
// static `import ... from '@spoint/ecs'` here throws "Failed to resolve module specifier" the instant
// the Worker's module graph is constructed, before any code runs, taking down the WHOLE Worker (same
// class of singleplayer/host-boot-breaking bug as this file's node:perf_hooks/node:fs siblings fixed
// the same session -- see src/sdk/Metrics.js and src/fluid/SPHSolver.js/SPHSolver3D.js -- though the
// underlying cause here is resolver-scope, not Node-vs-browser API availability). Fixed the same way
// World.js's getJolt() forks jolt-physics for its own browser branch: a Node-vs-Worker runtime check
// picks the bare specifier (Node's own node_modules resolution) or the equivalent server-served static
// URL (the same path a browser <script type="importmap"> entry would have remapped to, had one been
// reachable here) -- built via a function call, not a literal, so a bundler's static import-graph walk
// can't eagerly resolve the browser-only absolute path on a Node/edge build target either.
const _isNode = typeof process !== 'undefined' && process.versions?.node
const _ecsSpec = _isNode ? '@spoint/ecs' : (() => '/node_modules/' + '@spoint/ecs/src/index.js')()
const { createWorld } = await import(_ecsSpec)

const _ENTITY_COMPONENT = '_entity'

export function createEcsEntityMap() {
  const _world = createWorld()

  const map = {
    /** Map-like: set a key-value pair (entity id -> entity object). */
    set(key, value) {
      if (!_world.exists(key)) {
        _world.createEntity(key)
      }
      _world.addComponent(key, _ENTITY_COMPONENT, value)
      return map
    },

    /** Map-like: get the entity object for a key. */
    get(key) {
      return _world.getComponent(key, _ENTITY_COMPONENT)
    },

    /** Map-like: check if a key exists. */
    has(key) {
      return _world.hasComponent(key, _ENTITY_COMPONENT)
    },

    /** Map-like: delete a key and its entity data. */
    delete(key) {
      if (_world.exists(key)) {
        _world.destroyEntity(key)
        return true
      }
      return false
    },

    /** Map-like: clear all entities. */
    clear() {
      for (const id of _world.entities()) {
        _world.destroyEntity(id)
      }
    },

    /** Map-like: number of entries. */
    get size() {
      return _world.entityCount
    },

    /** Map-like: iterate over [key, value] pairs. */
    [Symbol.iterator]() {
      return map.entries()
    },

    /** Map-like: return an iterator of keys. */
    keys() {
      return _world.entities()[Symbol.iterator]()
    },

    /** Map-like: return an iterator of values. */
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

    /** Map-like: return an iterator of [key, value] pairs. */
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

    /** Map-like: execute a callback for each entry. */
    forEach(callback, thisArg) {
      for (const [key, value] of map) {
        callback.call(thisArg, value, key, map)
      }
    },

    // --- ECS-specific extensions (not part of Map API) ---

    /** Access the underlying ECS world for queries, tags, etc. */
    get _ecs() {
      return _world
    },
  }

  return map
}