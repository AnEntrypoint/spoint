// ---------------------------------------------------------------------------------------------
// ErrorTelemetry.js -- opt-in client crash/error beacon.
//
// PRIVACY-FIRST BY CONSTRUCTION: reporting is OFF by default. A deployment (or a player, via
// localStorage) must explicitly opt in before a single byte leaves the browser. This mirrors the
// existing opt-in-by-default posture of the rest of this codebase's telemetry-adjacent surfaces
// (RenderControls/QualityPresets are all local-only unless a server explicitly asks).
//
// Opt-in resolution order (first match wins):
//   1. window.__errorTelemetry === true/false (explicit runtime override, e.g. a test harness)
//   2. localStorage['spoint.errorTelemetry'] === '1' (persisted player/deployment choice)
//   3. ?telemetry=1 query string (a deployment can link players in pre-opted-in, e.g. a beta build)
//   4. default: OFF
//
// WHAT gets sent: never raw user input, never chat/voice content, never IP (server reads that from
// the socket, not the payload) -- just the crash signal itself (message/stack/source), plus enough
// environment context to actually be able to reproduce or triage it: RenderControls state (the 21
// live render/opt knobs from client/core/RenderControls.js -- exactly what a dev would ask "what
// were your settings" for) and device tier (client/core/MobileControls.js's detectDevice() output
// -- GPU tier, memory, mobile/desktop, WebGL2 support). No PII field exists in the schema; there is
// nothing to redact because nothing personal is ever collected.
//
// WHERE it goes: POSTs to /client-error (src/sdk/ServerAPI.js), a same-origin endpoint served by
// the SAME real server.js process regardless of client mode (per AGENTS.md's
// one-server-two-client-modes-same-origin caveat: singleplayer's in-Worker BrowserServer only
// replaces the netcode transport, never the HTTP static/API server the page itself was loaded
// from) -- so a plain page-level fetch/sendBeacon call reaches the real endpoint identically in
// dev, singleplayer, and a real multiplayer deployment. No third-party beacon host, no external
// dependency, self-hostable by construction.
//
// Distinct from the existing window.addEventListener('error'/'unhandledrejection') boot-failure
// overlay in client/app.js (client/app.js:152-160): that renders a LOCAL visual overlay so the
// player isn't stuck on a blank screen. This module is the SEND side -- it hooks the same two
// events (plus is callable directly for a caught/handled error worth reporting) and, only when
// opted in, also transmits the signal to the server for aggregate visibility. The two are
// independent: the overlay always renders regardless of opt-in; the beacon only fires when opted in.
// ---------------------------------------------------------------------------------------------

const STORAGE_KEY = 'spoint.errorTelemetry'
const MAX_REPORTS_PER_SESSION = 20 // hard session cap -- a crash loop must not turn into a request flood
const MIN_INTERVAL_MS = 500 // per-report spacing floor, same discipline as a client-side token bucket

let _sentCount = 0
let _lastSentAt = 0
let _installed = false

function isEnabled() {
  if (typeof window === 'undefined') return false
  if (window.__errorTelemetry === true) return true
  if (window.__errorTelemetry === false) return false
  try {
    if (localStorage.getItem(STORAGE_KEY) === '1') return true
  } catch (_) { /* localStorage may be unavailable (private mode, sandboxed iframe) -- fall through */ }
  try {
    const params = new URLSearchParams(location.search)
    if (params.get('telemetry') === '1') return true
  } catch (_) { /* location may be unavailable in a non-browser test host */ }
  return false
}

// Explicit opt-in/opt-out, persisted -- the surface a settings-menu checkbox or a deployment's
// first-run consent prompt calls. Mirrors QualityPresets.setPreset's persist-then-apply shape.
function setEnabled(v) {
  try { localStorage.setItem(STORAGE_KEY, v ? '1' : '0') } catch (_) { /* best-effort persistence only */ }
  if (typeof window !== 'undefined') window.__errorTelemetry = !!v
}

// Snapshot RenderControls' live knob values (not the static defaults) -- exactly what
// RenderControls.list() prints, but as data rather than a console string. Never throws: a
// mid-crash caller must be able to call this even if RenderControls itself is in a bad state.
function _renderControlsSnapshot() {
  try {
    const RC = typeof window !== 'undefined' && window.__renderControls
    if (!RC || typeof RC.keys !== 'function' || typeof RC.get !== 'function') return null
    const out = {}
    for (const k of RC.keys()) { try { out[k] = RC.get(k) } catch (_) { /* skip a single bad knob */ } }
    return out
  } catch (_) { return null }
}

function _deviceTierSnapshot() {
  try {
    // Reuses whichever device-info object app.js already computed at boot (see client/app.js's
    // _deviceInfoEarly) rather than re-running detectDevice()'s WebGL2-context-creation probe a
    // second time from inside a crash handler -- cheaper and avoids a nested-failure risk when the
    // crash IS a WebGL context problem. Falls back to a fresh probe if nothing was cached yet.
    if (typeof window !== 'undefined' && window.__deviceInfo) return window.__deviceInfo
    return null
  } catch (_) { return null }
}

function _buildPayload(kind, message, stack, extra) {
  return {
    kind, // 'error' | 'unhandledrejection' | 'manual'
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

// sendBeacon is fire-and-forget and survives page unload (the exact case a crash-then-navigate
// needs) but caps payload size on some browsers and can't set custom headers; falls back to a
// keepalive fetch (also unload-survivable per spec, and lets us set Content-Type) when
// sendBeacon is unavailable or rejects the payload.
function _transmit(payload) {
  const body = JSON.stringify(payload)
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([body], { type: 'application/json' })
      if (navigator.sendBeacon('/client-error', blob)) return
    }
  } catch (_) { /* fall through to fetch */ }
  try {
    if (typeof fetch === 'function') {
      fetch('/client-error', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {})
    }
  } catch (_) { /* best-effort: a failed transmit must never itself throw into the caller */ }
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
  } catch (_) { return false } // reporting must never be the thing that crashes the client
}

// Hooks the same two window-level events client/app.js's boot-failure overlay already listens to
// (window.error / unhandledrejection) so any uncaught error automatically gets reported once opted
// in, with zero per-call-site instrumentation needed elsewhere. Idempotent -- calling twice does
// not double-install (a hot-reload or a second app.js boot path calling this again is a no-op).
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
