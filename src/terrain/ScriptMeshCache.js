export const SCRIPT_MESH_CACHE_LIMIT = 256

export class ScriptMeshKeyError extends Error {
  constructor(reason, path) {
    super(`[script-mesh-key] ${reason} at ${path}`)
    this.name = 'ScriptMeshKeyError'
    this.reasonCode = reason
  }
}

function canonicalize(value, path) {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'number':
      if (!Number.isFinite(value)) throw new ScriptMeshKeyError('non-finite-number', path)
      return Object.is(value, -0) ? '0' : String(value)
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'object': {
      if (Array.isArray(value)) {
        return '[' + value.map((v, i) => canonicalize(v, `${path}[${i}]`)).join(',') + ']'
      }
      const keys = Object.keys(value).sort()
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k], `${path}.${k}`)).join(',') + '}'
    }
    default:
      throw new ScriptMeshKeyError('unsupported-type', path)
  }
}

export function scriptMeshKey(script, params, seed) {
  if (typeof script !== 'string' || script.length === 0) throw new ScriptMeshKeyError('script-not-string', 'script')
  if (!Number.isSafeInteger(seed)) throw new ScriptMeshKeyError('seed-not-integer', 'seed')
  return canonicalize({ script, params: params ?? {}, seed }, 'key')
}

export function createScriptMeshCache({ limit = SCRIPT_MESH_CACHE_LIMIT } = {}) {
  const entries = new Map()
  let hits = 0
  let misses = 0

  function getOrBuild(script, params, seed, build) {
    const key = scriptMeshKey(script, params, seed)
    const cached = entries.get(key)
    if (cached !== undefined) {
      hits++
      entries.delete(key)
      entries.set(key, cached)
      return cached
    }
    misses++
    const mesh = build({ script, params: params ?? {}, seed })
    entries.set(key, mesh)
    while (entries.size > limit) entries.delete(entries.keys().next().value)
    return mesh
  }

  return {
    getOrBuild,
    has(script, params, seed) {
      return entries.has(scriptMeshKey(script, params, seed))
    },
    clear() {
      entries.clear()
      hits = 0
      misses = 0
    },
    stats() {
      return { size: entries.size, hits, misses, limit }
    },
  }
}
