// Pure hot-reload decision helpers, kept free of browser globals so a node
// witness can run them against the real module graph. HmrRuntime.js owns the
// DOM/network/EventSource side and calls these.

// Every node that imports `node`, transitively, plus `node` itself.
export function ancestorsOf(parents, node) {
  const out = {}, stack = [node]
  while (stack.length) { const n = stack.pop(); if (n in out) continue; out[n] = true; stack.push(...(parents[n] || [])) }
  return out
}

// Walk up from the changed module to the nearest module that registered an
// acceptor. Returns null when the walk reaches a root nobody accepts, which
// means the change cannot be applied in place.
// An empty result means no accept boundary was found, which the caller has to
// treat exactly like null: `[]` is truthy, so returning it would report the
// change as accepted while applying nothing.
// A self-acceptor only counts AT the changed module. It re-binds the export bindings of the copy
// this page already imported, which is the only thing that makes an edit to THAT module visible to
// its static importers; letting it stop the walk for one of that module's dependencies would
// report the dependency's edit as accepted while the dependency is never re-read, which is the
// silent no-op the reload path is honest about.
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

// A resource timing entry is keyed by the exact URL that was fetched, so a
// module this page re-imported through HMR is filed under `...js?hmr=<v>&p=<n>`
// and an exact-name lookup misses it -- that copy IS live, and reporting it as
// not loaded would skip the reload that swaps it out. Match on pathname: the
// page can only hold a resource entry for a file it actually fetched.
export function loadedByPath(entries, url, base = 'http://localhost/') {
  let want
  try { want = new URL(url, base).pathname } catch (_) { return false }
  for (const name of entries) {
    try { if (new URL(name, base).pathname === want) return true } catch (_) { /* not a url */ }
  }
  return false
}

// The resource timing buffer only grows, so the pathname set is built once and appended to: an
// entry is never removed and a new one is only ever added at the end. `absorb` takes resource
// entries or plain url strings and costs one URL parse per entry it has not already seen, so a
// page that has held 20000 of them pays that once and every later lookup is a set hit.
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

// True when this page cannot be holding the pre-edit copy of `url`, so a change
// to it needs no reload and no patch: the next import reads the file from disk
// and gets the new code anyway.
//
// A worker-reachable module is never "not live": the worker loads its own copy
// and this page's resource timings cannot see it.
export function nothingLive({ worker = false, eager = false, loaded = false, tracked = 0 } = {}) {
  if (worker) return false
  if (eager) return false
  if (loaded) return false
  if (tracked > 0) return false
  return true
}
