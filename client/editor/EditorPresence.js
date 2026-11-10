import * as THREE from 'three'

const STALE_MS = 15000
const DRAG_SEND_THROTTLE_MS = 250
const PRESENCE_NEVER_SENT = undefined
const _worldScratch = new THREE.Vector3()
const _pointBuf = new Float64Array(2)
const _rectBuf = new Float64Array(4)
const _clock = new Float64Array(1)

export function createEditorPresence({ client, MSG, camera, renderer, entityMeshes }) {
  const remote = new Map()
  let _lastDragSendAt = 0
  let _lastSentEntityId = PRESENCE_NEVER_SENT

  const root = document.createElement('div')
  root.className = 'ds-editor-presence-layer'
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:8500;display:none'
  document.body.appendChild(root)
  const badges = new Map()
  const placed = new Map()

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
    b.style.background = _colorFor(id)
    root.appendChild(b)
    badges.set(id, b)
    return b
  }

  function _dropBadge(id) {
    const b = badges.get(id)
    if (b) b.remove()
    badges.delete(id)
    placed.delete(id)
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

  function _readRect() {
    const r = renderer.domElement.getBoundingClientRect()
    _rectBuf[0] = r.left; _rectBuf[1] = r.top; _rectBuf[2] = r.width; _rectBuf[3] = r.height
  }

  function _projectInto(mesh) {
    const world = mesh.getWorldPosition ? mesh.getWorldPosition(_worldScratch) : _worldScratch.copy(mesh.position)
    world.project(camera)
    if (world.z > 1 || world.z < -1) return false
    _pointBuf[0] = _rectBuf[0] + (world.x * 0.5 + 0.5) * _rectBuf[2]
    _pointBuf[1] = _rectBuf[1] + (1 - (world.y * 0.5 + 0.5)) * _rectBuf[3]
    return true
  }

  function _paint(id, entry) {
    const b = _ensureBadge(id)
    let p = placed.get(id)
    if (!p) { p = { x: NaN, y: NaN, dragging: null, shown: false }; placed.set(id, p) }
    if (!p.shown) { b.style.display = 'block'; p.shown = true }
    const x = _pointBuf[0], y = _pointBuf[1]
    if (x !== p.x) { p.x = x; b.style.left = x + 'px' }
    if (y !== p.y) { p.y = y; b.style.top = y + 'px' }
    const dragging = !!entry.dragging
    if (dragging !== p.dragging) { p.dragging = dragging; b.textContent = (dragging ? '✋ ' : '◉ ') + id.slice(0, 6) }
  }

  function _hide(id) {
    const b = badges.get(id)
    if (b) b.style.display = 'none'
    const p = placed.get(id)
    if (p) p.shown = false
  }

  let _tickAny = false, _tickHasRect = false
  function _visitRemote(entry, id) {
    if (_clock[0] - entry.at > STALE_MS) { remote.delete(id); _dropBadge(id); return }
    const mesh = entityMeshes.get(entry.entityId)
    if (!mesh) { _dropBadge(id); return }
    if (!_tickHasRect) { _readRect(); _tickHasRect = true }
    if (!_projectInto(mesh)) { _hide(id); return }
    _tickAny = true
    _paint(id, entry)
  }
  function tick() {
    _clock[0] = Date.now()
    _tickAny = false
    _tickHasRect = false
    remote.forEach(_visitRemote)
    root.style.display = _tickAny ? 'block' : 'none'
  }

  function hide() { root.style.display = 'none' }

  return { sendPresence, sendDragThrottled, onPresenceMessage, onPeerLeave, tick, hide }
}
