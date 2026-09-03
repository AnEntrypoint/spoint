// Multi-user editor presence: broadcasts this client's own selection (and drag) to every OTHER
// connected editor via MSG.EDITOR_PRESENCE (relayed server-side, never echoed back to the sender --
// see src/sdk/EditorHandlers.js), and renders a screen-space badge over any entity a REMOTE editor
// currently has selected. Deliberately DOM-overlay, not a scene-graph decoration: entityMeshes may be
// a ModelPool-managed/instanced root (see AGENTS.md modelpool-* caveats) where attaching arbitrary
// child objects or material overrides is unsafe; projecting camera-space onto a fixed DOM layer (same
// technique as app.js's _dragHud) touches nothing pool-owned.
//
// Presence entries expire on their own (STALE_MS) as a fallback even without a clean PLAYER_LEAVE --
// e.g. a client that hard-crashes mid-drag before the server's disconnect handler broadcasts PLAYER_LEAVE.
const STALE_MS = 15000
const DRAG_SEND_THROTTLE_MS = 250

export function createEditorPresence({ client, MSG, camera, renderer, entityMeshes }) {
  // remoteClientId -> { entityId, dragging, at }
  const remote = new Map()
  let _lastDragSendAt = 0
  let _lastSentEntityId = undefined // undefined = "never sent", distinct from null = "sent a clear"

  const root = document.createElement('div')
  root.className = 'ds-editor-presence-layer'
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:8500;display:none'
  document.body.appendChild(root)
  const badges = new Map() // remoteClientId -> DOM node

  // Stable-ish colour per remote client id, so the same peer keeps the same badge colour across a session.
  function _colorFor(id) {
    let h = 0
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
    return `hsl(${Math.abs(h) % 360}, 75%, 60%)`
  }

  function _ensureBadge(id) {
    let b = badges.get(id)
    if (b) return b
    b = document.createElement('div')
    b.style.cssText = 'position:absolute;transform:translate(-50%,-130%);white-space:nowrap;font:11px var(--ff-mono,monospace);padding:2px 6px;border-radius:4px;color:#0b0d12;font-weight:600;box-shadow:0 1px 4px rgba(0,0,0,0.4)'
    root.appendChild(b)
    badges.set(id, b)
    return b
  }

  function _dropBadge(id) {
    const b = badges.get(id)
    if (b) b.remove()
    badges.delete(id)
  }

  // Sends this client's current selection/drag state to every other editor. Called on selection change
  // and (throttled) on drag-update; entityId===null means "cleared" and is always sent immediately
  // (never throttled) so peers don't see a stale selection linger after a real deselect.
  function sendPresence(entityId, dragging) {
    if (entityId === _lastSentEntityId && !dragging) return
    _lastSentEntityId = entityId
    client.send(MSG.EDITOR_PRESENCE, { entityId: entityId || null, dragging: !!dragging })
  }

  function sendDragThrottled(entityId) {
    const now = performance.now()
    if (now - _lastDragSendAt < DRAG_SEND_THROTTLE_MS) return
    _lastDragSendAt = now
    client.send(MSG.EDITOR_PRESENCE, { entityId, dragging: true })
  }

  // MSG.EDITOR_PRESENCE inbound handler -- call from app.js's onMessage switch.
  function onPresenceMessage(payload) {
    const { clientId: fromId, entityId, dragging } = payload || {}
    if (!fromId) return
    if (entityId == null) { remote.delete(fromId); _dropBadge(fromId); return }
    remote.set(fromId, { entityId, dragging: !!dragging, at: Date.now() })
  }

  // PLAYER_LEAVE handler -- call from app.js's onMessage switch so a departed editor's badge doesn't linger.
  function onPeerLeave(playerId) {
    if (remote.delete(playerId)) _dropBadge(playerId)
  }

  function _project(mesh) {
    // Works for any Object3D (group/mesh/placeholder); position is enough for a badge anchor, no need
    // for a full bounding-box (which ModelPool-swapped LOD nodes may not have stably sized anyway).
    const p = mesh.position.clone ? mesh.position.clone() : mesh.position
    const world = mesh.getWorldPosition ? mesh.getWorldPosition(p) : p
    const ndc = world.project(camera)
    if (ndc.z > 1 || ndc.z < -1) return null // behind camera or past far plane
    const r = renderer.domElement.getBoundingClientRect()
    return { x: r.left + (ndc.x * 0.5 + 0.5) * r.width, y: r.top + (1 - (ndc.y * 0.5 + 0.5)) * r.height }
  }

  // Called once per animate() frame while the editor is open. Cheap: only iterates the (typically tiny)
  // remote presence map, not the whole scene.
  function tick() {
    const now = Date.now()
    let any = false
    for (const [id, entry] of remote) {
      if (now - entry.at > STALE_MS) { remote.delete(id); _dropBadge(id); continue }
      const mesh = entityMeshes.get(entry.entityId)
      if (!mesh) { _dropBadge(id); continue }
      const pt = _project(mesh)
      if (!pt) { const b = badges.get(id); if (b) b.style.display = 'none'; continue }
      any = true
      const b = _ensureBadge(id)
      b.style.display = 'block'
      b.style.left = pt.x + 'px'
      b.style.top = pt.y + 'px'
      b.style.background = _colorFor(id)
      b.textContent = (entry.dragging ? '✋ ' : '◉ ') + id.slice(0, 6)
    }
    root.style.display = any ? 'block' : 'none'
  }

  // Called on editor close (onEditModeChange(false) in app.js) so stale badges don't linger visible
  // behind the closed editor overlay -- tick() simply stops being called once the editor is hidden,
  // which would otherwise leave root.style.display at whatever it was on the last visible frame.
  function hide() { root.style.display = 'none' }

  return { sendPresence, sendDragThrottled, onPresenceMessage, onPeerLeave, tick, hide }
}
