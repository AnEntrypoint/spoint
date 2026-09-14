let _existsSync = null, _resolve = null, _realpathSync = null, _sep = '/'
try { if (typeof process !== 'undefined' && process.versions?.node) { const fs = await import('node:fs'); const path = await import('node:path'); _existsSync = fs.existsSync; _resolve = path.resolve; _realpathSync = fs.realpathSync; _sep = path.sep } } catch {}

function containedAssetPath(filePath, rootDir) {
  if (!_realpathSync || !rootDir) return null
  let rootReal
  try { rootReal = _realpathSync(rootDir) } catch { return null }
  const prefix = rootReal.endsWith(_sep) ? rootReal : rootReal + _sep
  let real
  try { real = _realpathSync(filePath) } catch { return null }
  return (real === rootReal || real.startsWith(prefix)) ? real : null
}

function tagAppState(state) {
  if (!state) return null
  const replacer = (key, value) => {
    if (value instanceof Map) return { __type: 'Map', entries: [...value.entries()] }
    if (value instanceof Set) return { __type: 'Set', values: [...value.values()] }
    return value
  }
  return JSON.parse(JSON.stringify(state, replacer))
}
function untagAppState(state) {
  if (!state) return null
  const reviver = (key, value) => {
    if (value && typeof value === 'object' && value.__type === 'Map' && Array.isArray(value.entries)) return new Map(value.entries)
    if (value && typeof value === 'object' && value.__type === 'Set' && Array.isArray(value.values)) return new Set(value.values)
    return value
  }
  return JSON.parse(JSON.stringify(state), reviver)
}

export { containedAssetPath, tagAppState, untagAppState, _existsSync, _resolve, _realpathSync, _sep }
