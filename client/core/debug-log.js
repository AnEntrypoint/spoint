let _enabled = null

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

export function dbg(namespace) {
  const prefix = `[${namespace}]`
  return function log(...args) {
    if (!_isEnabled(namespace)) return
    console.log(prefix, ...args)
  }
}

export function _resetDebugLogCache() {
  _enabled = null
}
