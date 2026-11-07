
export function ancestorsOf(parents, node) {
  const out = {}, stack = [node]
  while (stack.length) { const n = stack.pop(); if (n in out) continue; out[n] = true; stack.push(...(parents[n] || [])) }
  return out
}

export function findBoundaries(acceptors, ev) {
  const boundaries = new Set(), seen = new Set(), stack = [ev.url]
  while (stack.length) {
    const node = stack.pop()
    if (seen.has(node)) continue
    seen.add(node)
    const handlers = acceptors.get(node) || []
    const usable = node === ev.url ? handlers : handlers.filter((h) => !h.self)
    if (usable.length) { boundaries.add(node); continue }
    const parents = ev.parents[node] || []
    if (!parents.length) return null
    stack.push(...parents)
  }
  return boundaries.size ? [...boundaries] : null
}

export function isClass(v) { return typeof v === 'function' && /^class[\s{]/.test(Function.prototype.toString.call(v)) }

export function loadedByPath(entries, url, base = 'http://localhost/') {
  let want
  try { want = new URL(url, base).pathname } catch (_) { return false }
  for (const name of entries) {
    try { if (new URL(name, base).pathname === want) return true } catch (_) { }
  }
  return false
}

export function createLoadedPaths(base = 'http://localhost/') {
  let paths = new Set()
  let count = 0
  const pathOf = (entry) => {
    const name = typeof entry === 'string' ? entry : entry && entry.name
    if (typeof name !== 'string') return null
    try { return new URL(name, base).pathname } catch (_) { return null }
  }
  return {
    absorb(entries) {
      if (!entries || entries.length < count) { paths = new Set(); count = 0 }
      for (let i = count; i < entries.length; i++) { const p = pathOf(entries[i]); if (p) paths.add(p) }
      count = entries.length
      return paths
    },
    has(url) { const p = pathOf(url); return p !== null && paths.has(p) },
    size: () => paths.size,
  }
}

export function sameValue(a, b) {
  if (a === b) return true
  if (typeof a === 'function' || typeof b === 'function') return false
  try { return JSON.stringify(a) === JSON.stringify(b) } catch (_) { return false }
}

export function nothingLive({ worker = false, eager = false, loaded = false, tracked = 0 } = {}) {
  if (worker) return false
  if (eager) return false
  if (loaded) return false
  if (tracked > 0) return false
  return true
}
