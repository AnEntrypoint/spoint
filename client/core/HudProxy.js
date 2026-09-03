// HudProxy.js -- postMessage contract for main-thread-only HUD/DOM panels (ConnectionStatus.js,
// SpectatorMode.js, tweak-panel.js) to receive state from a future worker-hosted render loop.
//
// WHY THIS EXISTS: ConnectionStatus, SpectatorMode, and the mapspinner tweak-panel all own real DOM
// elements (banners, HUD chips, overlay text) that CANNOT be rendered in a Worker -- they need the
// main thread's document. When the render loop migrates to a worker-hosted OffscreenCanvas (the
// offscreencanvas-worker-migration-full-game-loop epic), these panels lose their direct access to
// the game state (players, rtt, client state) that today they read from window.__app / __client /
// pm.playerStates via direct JS references -- a Worker has no `window`, and these panels have no
// Worker. The contract below defines the postMessage shape that bridges this gap: the worker side
// sends a lightweight HUD_STATE update each frame (or on change), and a main-thread manager
// applies it to the real DOM elements.
//
// SCOPE (deliberately bounded): this module is the CONTRACT only -- it defines the message shape,
// the enum of panel types, and the createHudProxy() helper that wires the postMessage listener.
// It does NOT touch ConnectionStatus.js, SpectatorMode.js, or tweak-panel.js -- those modules
// continue to work exactly as they do today on the main thread; a future slice imports this module
// into the worker render loop to emit HUD_STATE messages, and into the main-thread app.js boot to
// receive them. The contract is designed so both sides can be implemented independently.
//
// Message shape on the wire:
//   { type: 'hud-state', panels: { [panelId]: PanelState } }
// Each PanelState is a plain, structured-clone-safe object with the minimum fields the panel needs
// to render its current state -- no live class instances, no DOM nodes, no functions, no circular refs.
//
// Panel IDs and their state shapes:
//   'connection': { visible: boolean, kind: 'reconnecting'|'destroyed'|'hidden', rtt: number|null,
//                   bufferHealth: number|null, connected: boolean }
//   'spectator':  { visible: boolean, submode: 'free'|'follow', targetId: string|null,
//                   playerCount: number, localPlayerId: string|null }
//   'tweak':      { visible: boolean, keys: { [key: string]: number|string|boolean } }
//                   -- the mapspinner tweak-panel is a set of labeled slider/checkbox/readout rows;
//                   each key is the window.__<key> name, the value is its current live value.
//   'pause':      { visible: boolean, message: string|null }
//                   -- the pause-menu overlay (client/hud/PauseMenu.js), shown on Escape.
//   'settings':   { visible: boolean }
//                   -- the settings menu (client/hud/SettingsMenu.js), shown on Escape from the
//                   pause menu. Both 'pause' and 'settings' are simple visibility toggles;
//                   the actual DOM is owned by the existing main-thread modules.
//   'editor':     { visible: boolean, selectedEntityId: string|null, multiSelectCount: number,
//                   editMode: 'select'|'translate'|'rotate'|'scale'|null }
//                   -- the editor HUD overlay (mode indicator, selection count, app status).
//                   The editor's full DOM (Inspector/Scene/Apps panels) is main-thread-only and
//                   too large to serialize every frame; this contract carries only the compact
//                   HUD-overlay text the user actually sees in the top-left viewport corner,
//                   matching what EditorShell.js's _updateHud() already computes today.
//
// A panel NOT listed in a given message retains its last-known state (delta, not full snapshot).
// The FIRST message after channel open must carry ALL panels the worker side knows about.

export const HUD_PANEL_IDS = ['connection', 'spectator', 'tweak', 'pause', 'settings', 'editor']

// Build a HUD_STATE message payload from a map of panelId -> state. Only includes panels with
// non-null state. Returns a plain structured-clone-safe object.
export function buildHudState(panels) {
  const out = {}
  for (const id of HUD_PANEL_IDS) {
    const state = panels[id]
    if (state != null) out[id] = state
  }
  return out
}

// Main-thread HUD proxy: receives HUD_STATE messages from a worker and applies them to registered
// panel handlers. Each handler is a function (state) => void that updates the real DOM.
// createHudProxy(target) returns { onPanel(panelId, handler), destroy() }.
// `target` is a Worker or MessagePort (anything with addEventListener('message', ...) and postMessage).
// Compose-clean with the existing RenderConfigChannel and OffscreenRenderWorker protocols -- the
// listener only handles {type:'hud-state'} messages, ignoring everything else.
export function createHudProxy(target) {
  if (!target || typeof target.addEventListener !== 'function') {
    throw new Error('createHudProxy: target must expose addEventListener')
  }

  const _handlers = new Map() // panelId -> Set<function>

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

  // Register a handler for a HUD panel. Returns a function to unregister.
  // Multiple handlers per panel are supported (e.g. the connection panel might be consumed by both
  // ConnectionStatus.js's banner AND its RTT chip, separately).
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

// Worker-side HUD state emitter: wraps a MessagePort-like target (self in a Worker, or a
// MessagePort) and exposes send(panels) to push a HUD_STATE message.
// Usage in a worker: const hud = createHudEmitter(self); hud.send({connection: {...}, spectator: {...}})
export function createHudEmitter(target) {
  if (!target || typeof target.postMessage !== 'function') {
    throw new Error('createHudEmitter: target must expose postMessage')
  }
  function send(panels) {
    target.postMessage({ type: 'hud-state', panels: buildHudState(panels) })
  }
  return { send }
}