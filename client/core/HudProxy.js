export const HUD_PANEL_IDS = ['connection', 'spectator', 'tweak', 'pause', 'settings', 'editor']

export function buildHudState(panels) {
  const out = {}
  for (const id of HUD_PANEL_IDS) {
    const state = panels[id]
    if (state != null) out[id] = state
  }
  return out
}

export function createHudProxy(target) {
  if (!target || typeof target.addEventListener !== 'function') {
    throw new Error('createHudProxy: target must expose addEventListener')
  }

  const _handlers = new Map()

  function _onMessage(e) {
    const msg = (e && e.data) || e
    if (!msg || msg.type !== 'hud-state') return
    const panels = msg.panels
    if (!panels || typeof panels !== 'object') return
    for (const id of Object.keys(panels)) {
      const fns = _handlers.get(id)
      if (!fns || !fns.size) continue
      const state = panels[id]
      if (state == null) continue
      for (const fn of fns) {
        try { fn(state) } catch (err) { console.error('[hud-proxy] handler threw for', id, err) }
      }
    }
  }

  target.addEventListener('message', _onMessage)

  function onPanel(panelId, handler) {
    if (!HUD_PANEL_IDS.includes(panelId)) {
      throw new Error('onPanel: unknown panel id "' + panelId + '" -- must be one of: ' + HUD_PANEL_IDS.join(', '))
    }
    let fns = _handlers.get(panelId)
    if (!fns) { fns = new Set(); _handlers.set(panelId, fns) }
    fns.add(handler)
    return () => fns.delete(handler)
  }

  function destroy() {
    target.removeEventListener('message', _onMessage)
    _handlers.clear()
  }

  return { onPanel, destroy }
}

export function createHudEmitter(target) {
  if (!target || typeof target.postMessage !== 'function') {
    throw new Error('createHudEmitter: target must expose postMessage')
  }
  function send(panels) {
    target.postMessage({ type: 'hud-state', panels: buildHudState(panels) })
  }
  return { send }
}