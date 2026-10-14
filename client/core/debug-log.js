let _enabled = null

function _computeEnabled() {
  const set = new Set()
  if (typeof location === 'undefined' || !location.search) return set
  const m = /[?&]debug=([^&]*)/.exec(location.search)
  if (!m) return set
  let raw
  try {
    raw = decodeURIComponent(m[1] || '')
  } catch {
    return set
  }
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

export function dbg(namespace) {
  const prefix = `[${namespace}]`
  return function log(...args) {
    if (!_isEnabled(namespace)) return
    console.log(prefix, ...args)
  }
}

// --- hot swap -----------------------------------------------------------------------------
// An edit to this file used to be classified RELOAD: findBoundaries walked from here to the app
// root and found no acceptor, so a save cost a whole page load. No boundary ABOVE this file can
// fix that, because a re-import is a new module instance and every importer keeps reading the
// one it imported at boot. What can is this file itself: an ESM import is a LIVE binding to this
// instance's export bindings, so re-assigning them here is visible to every importer already
// holding them. Self-accepting therefore turns the cost of a save into one module fetch.
// This re-points code only. It does not rebuild state the page already built, and every export
// below is re-assigned, so nothing an importer holds is left pointing at the previous copy.
const _hotSwapDebuglog = (next) => {
  dbg = next.dbg
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapDebuglog)
