const STALE_MS = 15000
const DRAG_SEND_THROTTLE_MS = 250
const PRESENCE_NEVER_SENT = undefined

export function createEditorPresence({ client, MSG, camera, renderer, entityMeshes }) {
  const remote = new Map()
  let _lastDragSendAt = 0
  let _lastSentEntityId = PRESENCE_NEVER_SENT

  const root = document.createElement('div')
  root.className = 'ds-editor-presence-layer'
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:8500;display:none'
  document.body.appendChild(root)
  const badges = new Map()

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

  function onPresenceMessage(payload) {
    const { clientId: fromId, entityId, dragging } = payload || {}
    if (!fromId) return
    if (entityId == null) { remote.delete(fromId); _dropBadge(fromId); return }
    remote.set(fromId, { entityId, dragging: !!dragging, at: Date.now() })
  }

  function onPeerLeave(playerId) {
    if (remote.delete(playerId)) _dropBadge(playerId)
  }

  function _project(mesh) {
    const p = mesh.position.clone ? mesh.position.clone() : mesh.position
    const world = mesh.getWorldPosition ? mesh.getWorldPosition(p) : p
    const ndc = world.project(camera)
    const behindCameraOrPastFarPlane = ndc.z > 1 || ndc.z < -1
    if (behindCameraOrPastFarPlane) return null
    const r = renderer.domElement.getBoundingClientRect()
    return { x: r.left + (ndc.x * 0.5 + 0.5) * r.width, y: r.top + (1 - (ndc.y * 0.5 + 0.5)) * r.height }
  }

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

  function hide() { root.style.display = 'none' }

  return { sendPresence, sendDragThrottled, onPresenceMessage, onPeerLeave, tick, hide }
}
