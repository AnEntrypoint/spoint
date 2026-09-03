// Spectator mode: free-fly camera + player-follow/chase camera, for casting/moderation/debugging.
// Sibling to the editor/lobby modes in ClientMachine's `ready.mode` parallel region (see
// ClientMachine.js's 'spectator' state, submodes 'free'/'follow').
//
// Free-fly reuses cam.js's EXISTING editor fly-camera unbound-movement code wholesale
// (cam.setEditMode(true) + cam.update(..., latestInput) is byte-identical to what the editor uses --
// no new physics-free-movement code was written, this module only drives the same entry point from a
// different mode). Follow/chase reuses the app-programmatic `engineCtx.spectate(playerId)` orbit-cam
// mechanism already wired into app.js's camera-input-update render-graph node (the `_spectateTarget`
// path), adding the piece that mechanism never had: a real connected-player cycle list + a
// player-facing HUD affordance, driven by the local user rather than only by game-app code.
//
// This module owns NO per-frame camera math itself -- it only (a) toggles cam.setEditMode for the
// free submode and (b) writes the shared _spectateTarget-equivalent target id for the follow submode
// via the injected `setSpectateTarget` callback (app.js's existing camera-input-update node already
// reads that value every frame). Keeping the actual camera math in the one place it already lived
// (cam.js's editMode branch, app.js's specMesh orbit branch) avoids a second, divergent copy.

export function createSpectatorMode({ clientMachine, cam, pm, getLocalPlayerId, setSpectateTarget }) {
  let _targetId = null   // last-followed player id, kept across free<->follow toggles so re-entering follow resumes the same target
  let _hudEl = null

  function _ensureHud() {
    if (_hudEl) return _hudEl
    const el = document.createElement('div')
    el.id = 'spectator-hud'
    el.style.cssText = 'position:fixed;top:max(8px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);'
      + 'background:color-mix(in oklab, var(--panel-1, #050b12) 88%, transparent);color:var(--panel-text, #fff);'
      + 'border:1px solid var(--rule, rgba(0,210,255,0.3));border-radius:6px;padding:6px 14px;'
      + "font:12px var(--ff-mono, monospace);z-index:10600;pointer-events:none;display:none;text-align:center;white-space:pre;"
    document.body.appendChild(el)
    _hudEl = el
    return el
  }

  function _connectedPlayerIds() {
    const local = getLocalPlayerId()
    const ids = []
    for (const id of pm.playerStates.keys()) { if (id !== local) ids.push(id) }
    return ids
  }

  function _renderHud() {
    const el = _ensureHud()
    if (!clientMachine.isSpectator) { el.style.display = 'none'; return }
    el.style.display = 'block'
    const sub = clientMachine.spectatorSubmode
    if (sub === 'follow') {
      const ids = _connectedPlayerIds()
      const idx = _targetId != null ? ids.indexOf(_targetId) : -1
      el.textContent = ids.length
        ? `SPECTATING (follow): ${_targetId}  [${idx + 1}/${ids.length}]\n[/] cycle player   F free-cam   Esc exit`
        : `SPECTATING (follow): no connected players\nF free-cam   Esc exit`
    } else {
      el.textContent = 'SPECTATING (free-cam)\nF follow player   Esc exit'
    }
  }

  function _applyFollowTarget() {
    const ids = _connectedPlayerIds()
    if (_targetId == null || !ids.includes(_targetId)) _targetId = ids.length ? ids[0] : null
    setSpectateTarget(_targetId)
  }

  function enter() {
    clientMachine.send('ENTER_SPECTATOR')
  }
  function exit() {
    setSpectateTarget(null)
    clientMachine.send('EXIT_SPECTATOR')
    cam.setEditMode(false)
    _renderHud()
  }
  function toFree() {
    setSpectateTarget(null)
    cam.setEditMode(true)
    clientMachine.send('SPECTATE_FREE')
    _renderHud()
  }
  function toFollow() {
    cam.setEditMode(false)
    clientMachine.send('SPECTATE_FOLLOW')
    _applyFollowTarget()
    _renderHud()
  }
  // Real player-cycling affordance: advances/retreats through the live connected-players list
  // (pm.playerStates, excludes the local player) and retargets the follow camera immediately.
  function cycleNext() { _cycle(1) }
  function cyclePrev() { _cycle(-1) }
  function _cycle(dir) {
    const ids = _connectedPlayerIds()
    if (!ids.length) { _targetId = null; setSpectateTarget(null); _renderHud(); return }
    const idx = _targetId != null ? ids.indexOf(_targetId) : -1
    const next = ids[(idx + dir + ids.length) % ids.length]
    _targetId = next
    setSpectateTarget(next)
    _renderHud()
  }

  clientMachine.subscribe(() => { _renderHud() })

  return {
    enter, exit, toFree, toFollow, cycleNext, cyclePrev,
    get targetId() { return _targetId },
    get isFree() { return clientMachine.isSpectator && clientMachine.spectatorSubmode === 'free' },
    get isFollow() { return clientMachine.isSpectator && clientMachine.spectatorSubmode === 'follow' },
    renderHud: _renderHud,
    destroy() { if (_hudEl) _hudEl.remove() },
  }
}
