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
export function findBoundaries(acceptors, ev) {
  const boundaries = new Set(), seen = new Set(), stack = [ev.url]
  while (stack.length) {
    const node = stack.pop()
    if (seen.has(node)) continue
    seen.add(node)
    if (acceptors.get(node)?.length) { boundaries.add(node); continue }
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
