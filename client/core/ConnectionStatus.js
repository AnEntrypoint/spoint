// Connection status UI: a fixed-position reconnect banner (shown while the socket is
// waiting/reconnecting, or on a terminal destroyed state) plus a small always-visible
// RTT/stability HUD chip. Plain DOM (not webjsx/ui-root) so it renders even before a
// world/snapshot exists and survives ui-root diff churn -- same doctrine as EditPanelDOM's
// toast host (client/editor/EditPanelDOM.js's _ensureToastHost).
//
// Reads client.isReconnecting()/_reconnect state indirectly via the onConnect/onDisconnect
// callbacks the caller already wires (BaseClient.callbacks), plus a light poll of
// client.getRTT()/getBufferHealth() for the HUD chip -- no new wire messages.

import { STRINGS } from './strings.js'

const BANNER_SHOW_DELAY_MS = 300 // degenerate-state guard: a fast reconnect (<300ms) never flashes the banner
const RTT_WARN_MS = 150 // netcode-feel doctrine's "high latency" threshold

function ensureStyles() {
  if (document.getElementById('connstatus-style')) return
  const style = document.createElement('style')
  style.id = 'connstatus-style'
  style.textContent = `
#reconnect-banner {
  position: fixed; top: 0; left: 0; right: 0; z-index: 10000;
  display: flex; align-items: center; justify-content: center; gap: 10px;
  padding: 8px 14px; font: 13px var(--ff-mono, monospace);
  color: var(--panel-text, #fff);
  background: color-mix(in oklab, #3a2400 85%, transparent);
  border-bottom: 1px solid color-mix(in oklab, #ffb020 60%, transparent);
  text-shadow: 0 0 2px #000;
  pointer-events: none;
  transform: translateY(-100%);
  transition: transform 180ms ease-out;
}
#reconnect-banner.visible { transform: translateY(0); }
#reconnect-banner.kind-destroyed {
  background: color-mix(in oklab, #3a0000 85%, transparent);
  border-bottom-color: color-mix(in oklab, #ff4040 65%, transparent);
}
#reconnect-banner .rb-spinner {
  width: 10px; height: 10px; border-radius: 50%;
  border: 2px solid color-mix(in oklab, #ffb020 70%, transparent);
  border-top-color: transparent;
  animation: rb-spin 0.8s linear infinite;
}
#reconnect-banner.kind-destroyed .rb-spinner { display: none; }
@keyframes rb-spin { to { transform: rotate(360deg); } }
#connquality-hud {
  position: fixed; bottom: 8px; right: 10px; z-index: 9500;
  font: 11px var(--ff-mono, monospace);
  color: var(--panel-text, rgba(255,255,255,0.75));
  background: color-mix(in oklab, var(--panel-1, #030a10) 78%, transparent);
  border: 1px solid var(--rule, rgba(0, 210, 255, 0.3));
  border-radius: 4px;
  padding: 3px 7px;
  display: flex; align-items: center; gap: 6px;
  pointer-events: none;
  text-shadow: 0 0 2px #000;
}
#connquality-hud.warn { color: #ffb020; border-color: color-mix(in oklab, #ffb020 55%, transparent); }
#connquality-hud .cq-dot { width: 6px; height: 6px; border-radius: 50%; background: #3fdc6a; flex: none; }
#connquality-hud.warn .cq-dot { background: #ffb020; }
#connquality-hud.offline .cq-dot { background: #ff4444; }
`
  document.head.appendChild(style)
}

export function createConnectionStatus() {
  ensureStyles()

  let bannerEl = null
  let hudEl = null
  let showTimer = null
  let pendingState = null // state queued during the 300ms debounce

  function ensureBanner() {
    if (bannerEl) return bannerEl
    bannerEl = document.createElement('div')
    bannerEl.id = 'reconnect-banner'
    bannerEl.setAttribute('role', 'status')
    const spinner = document.createElement('div')
    spinner.className = 'rb-spinner'
    const text = document.createElement('span')
    text.className = 'rb-text'
    bannerEl.appendChild(spinner)
    bannerEl.appendChild(text)
    document.body.appendChild(bannerEl)
    return bannerEl
  }

  function ensureHud() {
    if (hudEl) return hudEl
    hudEl = document.createElement('div')
    hudEl.id = 'connquality-hud'
    const dot = document.createElement('div')
    dot.className = 'cq-dot'
    const text = document.createElement('span')
    text.className = 'cq-text'
    hudEl.appendChild(dot)
    hudEl.appendChild(text)
    document.body.appendChild(hudEl)
    return hudEl
  }

  function _renderBanner(kind, message) {
    const el = ensureBanner()
    el.classList.toggle('kind-destroyed', kind === 'destroyed')
    el.querySelector('.rb-text').textContent = message
    el.classList.add('visible')
  }

  function _hideBanner() {
    if (showTimer) { clearTimeout(showTimer); showTimer = null }
    pendingState = null
    if (bannerEl) bannerEl.classList.remove('visible')
  }

  // state: 'connected' | 'waiting' | 'reconnecting' | 'destroyed'
  function setState(state, attempts = 0) {
    if (state === 'connected') { _hideBanner(); return }
    if (state === 'destroyed') {
      // Terminal state: show immediately, no debounce -- there is nothing further to wait for.
      if (showTimer) { clearTimeout(showTimer); showTimer = null }
      _renderBanner('destroyed', STRINGS.connectionLostPermanent)
      return
    }
    // waiting/reconnecting: debounce so a sub-300ms blip never flashes the banner (degenerate-state guard).
    pendingState = state
    if (showTimer) return
    showTimer = setTimeout(() => {
      showTimer = null
      if (!pendingState || pendingState === 'connected') return
      const msg = pendingState === 'reconnecting'
        ? STRINGS.connectionReconnecting(attempts)
        : STRINGS.connectionWaitingReconnect
      _renderBanner(pendingState, msg)
    }, BANNER_SHOW_DELAY_MS)
  }

  function updateQuality({ rtt, bufferHealth, connected }) {
    const el = ensureHud()
    const dot = el.querySelector('.cq-dot')
    const text = el.querySelector('.cq-text')
    if (connected === false) {
      el.classList.add('offline'); el.classList.remove('warn')
      text.textContent = STRINGS.connectionOffline
      return
    }
    el.classList.remove('offline')
    const rttOk = Number.isFinite(rtt)
    const unstable = rttOk && rtt > RTT_WARN_MS
    el.classList.toggle('warn', unstable)
    text.textContent = (rttOk ? Math.round(rtt) + 'ms' : '--ms') + (unstable ? ' unstable' : '')
  }

  function dispose() {
    if (showTimer) clearTimeout(showTimer)
    bannerEl?.remove()
    hudEl?.remove()
  }

  return { setState, updateQuality, dispose }
}
