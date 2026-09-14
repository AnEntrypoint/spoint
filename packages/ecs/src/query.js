export function createQuery(world, spec = {}) {
  const _has = spec.has || []
  const _hasAny = spec.hasAny || []
  const _not = spec.not || []
  let _cached = null
  let _cachedVersion = -1

  function _match(id) {
    for (const name of _has) {
      if (!world.hasComponent(id, name)) return false
    }
    for (const name of _not) {
      if (world.hasComponent(id, name)) return false
    }
    if (_hasAny.length > 0) {
      let found = false
      for (const name of _hasAny) {
        if (world.hasComponent(id, name)) { found = true; break }
      }
      if (!found) return false
    }
    return true
  }

  function refresh() {
    _cachedVersion = world.version
    const result = []
    for (const id of world.entities()) {
      if (_match(id)) result.push(id)
    }
    _cached = result
    return result
  }

  function changed() {
    return _cached === null || world.version !== _cachedVersion
  }

  function count() {
    if (_cached === null) refresh()
    return _cached.length
  }

  function get() {
    return _cached
  }

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

    forEach(fn) {
      for (const id of refresh()) fn(id, world)
    },
  }

  return query
}