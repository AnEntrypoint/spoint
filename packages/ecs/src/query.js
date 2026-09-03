/**
 * query.js -- Archetype-based entity queries over an ECS World.
 *
 * Shared between spoint and thebird. A query selects entities that have
 * (or don't have) specific components, and provides efficient iteration
 * over the result set.
 *
 * Queries are lazy: they re-evaluate against the world on each iteration.
 * For hot-path usage, use query.refresh() to get a cached result and
 * query.changed() to check if the world has changed since last refresh.
 *
 * Usage:
 *   import { createQuery } from './query.js'
 *   const movers = createQuery(world, { has: ['position', 'velocity'] })
 *   for (const id of movers) {
 *     const pos = world.getComponent(id, 'position')
 *     const vel = world.getComponent(id, 'velocity')
 *     pos.x += vel.x * dt
 *   }
 */

/**
 * Create a query over a world.
 *
 * @param {object} world - ECS world (from world.js)
 * @param {object} spec
 * @param {string[]} [spec.has] - entity must have ALL of these components
 * @param {string[]} [spec.hasAny] - entity must have AT LEAST ONE of these
 * @param {string[]} [spec.not] - entity must have NONE of these
 * @returns {object} query - iterable, with refresh()/changed()/count()
 */
export function createQuery(world, spec = {}) {
  const _has = spec.has || []
  const _hasAny = spec.hasAny || []
  const _not = spec.not || []
  let _cached = null
  let _cachedVersion = -1

  function _match(id) {
    // Check 'has' (all required)
    for (const name of _has) {
      if (!world.hasComponent(id, name)) return false
    }
    // Check 'not' (none allowed)
    for (const name of _not) {
      if (world.hasComponent(id, name)) return false
    }
    // Check 'hasAny' (at least one)
    if (_hasAny.length > 0) {
      let found = false
      for (const name of _hasAny) {
        if (world.hasComponent(id, name)) { found = true; break }
      }
      if (!found) return false
    }
    return true
  }

  /**
   * Refresh the cached result set. Returns the matching entity ids.
   * Call this once per tick (or when the result is needed) and then
   * iterate over the returned array.
   */
  function refresh() {
    _cachedVersion = world.version
    const result = []
    for (const id of world.entities()) {
      if (_match(id)) result.push(id)
    }
    _cached = result
    return result
  }

  /**
   * Check if the world has changed since the last refresh().
   * Returns true when no refresh() has been called yet, or when
   * the world's change-version has advanced (entity/component mutations).
   */
  function changed() {
    return _cached === null || world.version !== _cachedVersion
  }

  /**
   * Get the number of matching entities (from cache or fresh).
   */
  function count() {
    if (_cached === null) refresh()
    return _cached.length
  }

  /**
   * Get the cached result (without refreshing). Returns null if never refreshed.
   */
  function get() {
    return _cached
  }

  /**
   * Iterate over matching entities. Refreshes on each iteration.
   * Supports for...of and spread.
   */
  const query = {
    refresh, changed, count, get,

    [Symbol.iterator]() {
      const ids = refresh()
      let i = 0
      return {
        next() {
          if (i < ids.length) return { value: ids[i++], done: false }
          return { done: true }
        },
      }
    },

    /**
     * Iterate with component data pre-fetched for each matching entity.
     * Returns { id, components: { name: data } } objects.
     */
    *entries() {
      for (const id of refresh()) {
        const comps = {}
        for (const name of _has) comps[name] = world.getComponent(id, name)
        for (const name of _hasAny) {
          if (world.hasComponent(id, name)) comps[name] = world.getComponent(id, name)
        }
        yield { id, components: comps }
      }
    },

    /**
     * Execute a callback for each matching entity.
     * Passes (id, world) to the callback.
     */
    forEach(fn) {
      for (const id of refresh()) fn(id, world)
    },
  }

  return query
}