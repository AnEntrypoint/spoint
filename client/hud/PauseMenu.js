// Pause/system menu: Resume / Settings / Leave Match / Invite Friends. Shown when pointer-lock
// exits DURING ACTIVE GAMEPLAY (the player pressed Esc mid-match), never on the initial
// click-to-play prompt (that is app.js's existing #click-prompt element, a distinct first-boot
// affordance the caller must not confuse with a pause). Plain DOM overlay, same doctrine as
// SettingsMenu.js/ConnectionStatus.js -- renders reliably regardless of ui-root diff churn.
//
// Deps (all optional -- a missing dep degrades that one action, the rest of the menu still works):
//   requestPointerLock()  -> re-locks the pointer on Resume (typically renderer.domElement.requestPointerLock)
//   settingsMenu          -> the object returned by createSettingsMenu (Settings button opens it)
//   onLeaveMatch()        -> called on Leave Match; default navigates to the sibling landing page
//   getRoomInfo()         -> () => { code, joinLink } | null, for Invite Friends (only shown if a room is active)

function ensureStyles() {
  if (document.getElementById('pause-menu-style')) return
  const style = document.createElement('style')
  style.id = 'pause-menu-style'
  style.textContent = `
#pause-menu-overlay {
  position: fixed; inset: 0; z-index: 10700;
  display: none; align-items: center; justify-content: center;
  background: color-mix(in oklab, #000 60%, transparent);
  font: 13px var(--ff-mono, monospace);
}
#pause-menu-overlay.open { display: flex; }
#pause-menu-panel {
  width: min(300px, calc(100vw - 32px));
  background: color-mix(in oklab, var(--panel-1, #050b12) 92%, transparent);
  border: 1px solid var(--rule, rgba(0,210,255,0.3));
  border-radius: 8px;
  color: var(--panel-text, #fff);
  padding: 18px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  display: flex; flex-direction: column; gap: 8px;
}
#pause-menu-panel h2 { margin: 0 0 8px; font-size: 16px; letter-spacing: 0.5px; text-align: center; }
#pause-menu-panel button { background: var(--panel-0, #0a141c); color: var(--panel-text, #fff); border: 1px solid var(--rule, rgba(0,210,255,0.3)); border-radius: 5px; padding: 10px 14px; cursor: pointer; font: inherit; text-align: left; }
#pause-menu-panel button:hover { border-color: var(--accent, #00d2ff); }
#pause-menu-panel button.pm-primary { background: var(--accent, #00d2ff); color: #001318; border-color: var(--accent, #00d2ff); font-weight: 600; text-align: center; }
#pause-menu-panel button.pm-danger:hover { border-color: #ff5b5b; color: #ff8a8a; }
#pause-menu-toast {
  position: fixed; top: max(8px, env(safe-area-inset-top)); left: 50%; transform: translateX(-50%);
  background: var(--panel-1); border: 1px solid var(--rule); color: var(--panel-text);
  padding: 8px 14px; border-radius: 6px; font-size: 12px; z-index: 10900; pointer-events: none;
  opacity: 0; transition: opacity 0.2s;
}
#pause-menu-toast.show { opacity: 1; }
`
  document.head.appendChild(style)
}

function _defaultLeaveMatch() {
  // The game entry point (client/index.html, served e.g. as demo.html) and the landing page
  // (client/landing/index.html) are siblings -- see client/landing/content/hero.json's own
  // demo_href convention ('./demo.html' relative to the landing dir). Navigating to the sibling
  // 'landing/' directory is the generic "back to lobby" cross-link with no world-specific coupling.
  location.href = new URL('landing/', location.href).href
}

function _showToast(msg) {
  let t = document.getElementById('pause-menu-toast')
  if (!t) { t = document.createElement('div'); t.id = 'pause-menu-toast'; document.body.appendChild(t) }
  t.textContent = msg
  t.classList.remove('show')
  requestAnimationFrame(() => t.classList.add('show'))
  clearTimeout(t._hideTimer)
  t._hideTimer = setTimeout(() => t.classList.remove('show'), 2200)
}

export function createPauseMenu({ requestPointerLock = null, settingsMenu = null, onLeaveMatch = null, getRoomInfo = null } = {}) {
  ensureStyles()

  let onResumeCb = null

  const overlay = document.createElement('div')
  overlay.id = 'pause-menu-overlay'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', 'Paused')
  const panel = document.createElement('div')
  panel.id = 'pause-menu-panel'
  overlay.appendChild(panel)
  document.body.appendChild(overlay)

  overlay.addEventListener('mousedown', e => { if (e.target === overlay) resume() })

  function _btn(label, cls, onClick) {
    const b = document.createElement('button')
    if (cls) b.className = cls
    b.textContent = label
    b.addEventListener('click', onClick)
    return b
  }

  function render() {
    panel.innerHTML = ''
    const h2 = document.createElement('h2')
    h2.textContent = 'Paused'
    panel.appendChild(h2)

    panel.appendChild(_btn('Resume', 'pm-primary', resume))
    panel.appendChild(_btn('Settings', null, () => { if (settingsMenu) settingsMenu.open() }))

    const room = getRoomInfo ? getRoomInfo() : null
    if (room && room.joinLink) {
      panel.appendChild(_btn('Invite Friends', null, async () => {
        try { await navigator.clipboard.writeText(room.joinLink); _showToast('Join link copied') }
        catch (_) { _showToast(room.joinLink) }
      }))
    }

    panel.appendChild(_btn('Leave Match', 'pm-danger', leaveMatch))
  }

  function open() {
    render()
    overlay.classList.add('open')
  }
  function resume() {
    overlay.classList.remove('open')
    if (requestPointerLock) {
      try {
        const p = requestPointerLock()
        if (p && typeof p.catch === 'function') p.catch(e => console.warn('[pause-menu] requestPointerLock rejected:', e?.message || e))
      } catch (e) { console.warn('[pause-menu] requestPointerLock failed:', e?.message || e) }
    }
    if (onResumeCb) onResumeCb()
  }
  function leaveMatch() {
    overlay.classList.remove('open')
    if (onLeaveMatch) onLeaveMatch()
    else _defaultLeaveMatch()
  }

  return {
    open, resume,
    get isOpen() { return overlay.classList.contains('open') },
    onResume: cb => { onResumeCb = cb },
    destroy() { overlay.remove() },
  }
}
