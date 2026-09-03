// debug-log -- a tiny namespaced debug logger gated on a `?debug=ns1,ns2` query param.
//
// WHY THIS EXISTS: the client has 160+ scattered console.log/console.warn call sites with no way to
// silence or scope them per-subsystem. This module is the facility (not a full migration -- see
// AGENTS.md route-empty-catches-through-debug-logger for the sampled-migration follow-up): a single
// `dbg(namespace)` factory returning a log function that only prints when its namespace is enabled via
// `?debug=terrain,net` in the page URL. Zero dependencies, parses location.search once and caches the
// enabled-namespace Set.
//
// USAGE:
//   import { dbg } from './core/debug-log.js'
//   const log = dbg('terrain')
//   log('planet build finished', someValue)
//   // prints only when the page URL has ?debug=terrain or ?debug=*  (or terrain is in a comma list)
//
// A namespace of '*' in the query enables every namespace. Calling dbg(ns) is cheap and side-effect
// free even when disabled -- callers can hold onto the returned function and call it every frame; the
// gate check happens once per call, not per dbg() invocation.

let _enabled = null // Set<string> | null, lazily computed from location.search

function _computeEnabled() {
  const set = new Set()
  if (typeof location === 'undefined' || !location.search) return set
  const m = /[?&]debug=([^&]*)/.exec(location.search)
  if (!m) return set
  const raw = decodeURIComponent(m[1] || '')
  for (const part of raw.split(',')) {
    const ns = part.trim()
    if (ns) set.add(ns)
  }
  return set
}

function _isEnabled(namespace) {
  if (_enabled === null) _enabled = _computeEnabled()
  return _enabled.has('*') || _enabled.has(namespace)
}

// dbg(namespace) -> (...args) => void. The returned function is a no-op unless the namespace (or '*')
// is present in ?debug=... . Uses console.log so output is visually distinct from console.warn/error.
export function dbg(namespace) {
  const prefix = `[${namespace}]`
  return function log(...args) {
    if (!_isEnabled(namespace)) return
    console.log(prefix, ...args)
  }
}

// Test/diagnostic helper: force-clear the cached Set so a changed location.search (e.g. in a long-lived
// SPA context) is re-read on next call. Not needed in normal page-load usage.
export function _resetDebugLogCache() {
  _enabled = null
}
