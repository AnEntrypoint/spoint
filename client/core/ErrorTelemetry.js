const STORAGE_KEY = 'spoint.errorTelemetry'
const MAX_REPORTS_PER_SESSION = 20
const MIN_INTERVAL_MS = 500

let _sentCount = 0
let _lastSentAt = 0
let _installed = false

function isEnabled() {
  if (typeof window === 'undefined') return false
  if (window.__errorTelemetry === true) return true
  if (window.__errorTelemetry === false) return false
  try {
    if (localStorage.getItem(STORAGE_KEY) === '1') return true
  } catch (_) { }
  try {
    const params = new URLSearchParams(location.search)
    if (params.get('telemetry') === '1') return true
  } catch (_) { }
  return false
}

function setEnabled(v) {
  try { localStorage.setItem(STORAGE_KEY, v ? '1' : '0') } catch (_) { }
  if (typeof window !== 'undefined') window.__errorTelemetry = !!v
}

function _renderControlsSnapshot() {
  try {
    const RC = typeof window !== 'undefined' && window.__renderControls
    if (!RC || typeof RC.keys !== 'function' || typeof RC.get !== 'function') return null
    const out = {}
    for (const k of RC.keys()) { try { out[k] = RC.get(k) } catch (_) { } }
    return out
  } catch (_) { return null }
}

function _deviceTierSnapshot() {
  try {
    if (typeof window !== 'undefined' && window.__deviceInfo) return window.__deviceInfo
    return null
  } catch (_) { return null }
}

function _buildPayload(kind, message, stack, extra) {
  return {
    kind,
    message: String(message || '').slice(0, 2000),
    stack: String(stack || '').slice(0, 8000),
    url: typeof location !== 'undefined' ? location.href.slice(0, 500) : '',
    ua: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 300) : '',
    ts: Date.now(),
    renderControls: _renderControlsSnapshot(),
    deviceTier: _deviceTierSnapshot(),
    extra: extra ? String(extra).slice(0, 500) : undefined,
  }
}

function _transmit(payload) {
  const body = JSON.stringify(payload)
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([body], { type: 'application/json' })
      if (navigator.sendBeacon('/client-error', blob)) return
    }
  } catch (_) { }
  try {
    if (typeof fetch === 'function') {
      fetch('/client-error', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {})
    }
  } catch (_) { }
}

function report(kind, message, stack, extra) {
  try {
    if (!isEnabled()) return false
    const now = Date.now()
    if (_sentCount >= MAX_REPORTS_PER_SESSION) return false
    if (now - _lastSentAt < MIN_INTERVAL_MS) return false
    _sentCount++
    _lastSentAt = now
    _transmit(_buildPayload(kind, message, stack, extra))
    return true
  } catch (_) { return false }
}

function install() {
  if (_installed || typeof window === 'undefined') return
  _installed = true
  window.addEventListener('error', ev => {
    const err = ev?.error
    report('error', (err && err.message) || ev?.message, err && err.stack)
  })
  window.addEventListener('unhandledrejection', ev => {
    const reason = ev?.reason
    report('unhandledrejection', (reason && reason.message) || String(reason), reason && reason.stack)
  })
}

export const ErrorTelemetry = { install, report, isEnabled, setEnabled }

if (typeof window !== 'undefined') window.__errorTelemetryModule = ErrorTelemetry
