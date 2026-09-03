import { renderWindow } from './renderWindow.js'

const MIN_W = 200, MIN_H = 120

export function createWindowController({ root, storageKeyPrefix = 'ds-wm-' } = {}) {
  const container = root || (() => {
    const r = document.createElement('div')
    r.className = 'wm-root'
    document.body.appendChild(r)
    return r
  })()

  const windows = new Map()
  let zCounter = 100
  let focusedId = null
  let _drag = null

  function _persist(id) {
    const w = windows.get(id); if (!w) return
    try { localStorage.setItem(storageKeyPrefix + id, JSON.stringify(w.handle.getBounds())) } catch (_) {}
  }
  function _restoreBounds(id, fallback) {
    try {
      const raw = localStorage.getItem(storageKeyPrefix + id)
      if (raw) { const b = JSON.parse(raw); if (Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.w) && Number.isFinite(b.h)) return b }
    } catch (_) {}
    return fallback
  }

  function focus(id) {
    if (!windows.has(id)) return
    if (focusedId && focusedId !== id) { const prev = windows.get(focusedId); if (prev) prev.handle.setFocused(false) }
    focusedId = id
    const w = windows.get(id)
    w.handle.setFocused(true)
    w.handle.setZIndex(++zCounter)
  }

  function open({ id, title = 'window', x = 60, y = 60, w = 480, h = 320, body = null, onClose, onMinimize, onMaximize }) {
    if (windows.has(id)) { focus(id); return windows.get(id).handle }
    const bounds = _restoreBounds(id, { x, y, w, h })
    let maximized = false, minimized = false
    const handle = renderWindow({
      title, body, bounds,
      callbacks: {
        onFocus: () => focus(id),
        onClose: () => { close(id); onClose?.() },
        onMinimize: () => { minimized = !minimized; handle.setMinimized(minimized); onMinimize?.(minimized) },
        onMaximize: () => { maximized = !maximized; handle.setMaximized(maximized); onMaximize?.(maximized) },
        onDragStart: (e, startBounds) => { _drag = { id, mode: 'move', startX: e.clientX, startY: e.clientY, startBounds }; handle.el.classList.add('wm-dragging') },
        onResizeStart: (e, startBounds) => { _drag = { id, mode: 'resize', dir: startBounds.dir, startX: e.clientX, startY: e.clientY, startBounds }; handle.el.classList.add('wm-resizing') },
      }
    })
    container.appendChild(handle.el)
    windows.set(id, { handle })
    focus(id)
    return handle
  }

  function close(id) {
    const w = windows.get(id); if (!w) return
    w.handle.dispose()
    windows.delete(id)
    if (focusedId === id) focusedId = null
    if (_drag && _drag.id === id) _drag = null
  }

  function getWindow(id) { return windows.get(id)?.handle || null }

  function _clampBounds(b) {
    const w = Math.max(MIN_W, b.w), h = Math.max(MIN_H, b.h)
    const maxX = Math.max(0, window.innerWidth - 40), maxY = Math.max(0, window.innerHeight - 40)
    return { x: Math.min(Math.max(-w + 40, b.x), maxX), y: Math.min(Math.max(0, b.y), maxY), w, h }
  }

  function _onPointerMove(e) {
    if (!_drag) return
    const w = windows.get(_drag.id); if (!w) { _drag = null; return }
    const dx = e.clientX - _drag.startX, dy = e.clientY - _drag.startY
    if (_drag.mode === 'move') {
      w.handle.setBounds(_clampBounds({ x: _drag.startBounds.x + dx, y: _drag.startBounds.y + dy, w: _drag.startBounds.w, h: _drag.startBounds.h }))
    } else {
      const sb = _drag.startBounds, dir = _drag.dir
      let { x, y, w: nw, h: nh } = sb
      if (dir.includes('e')) nw = sb.w + dx
      if (dir.includes('s')) nh = sb.h + dy
      if (dir.includes('w')) { nw = sb.w - dx; x = sb.x + dx }
      if (dir.includes('n')) { nh = sb.h - dy; y = sb.y + dy }
      w.handle.setBounds(_clampBounds({ x, y, w: nw, h: nh }))
    }
  }
  function _onPointerUp() {
    if (!_drag) return
    const id = _drag.id
    const w = windows.get(id)
    if (w) w.handle.el.classList.remove('wm-dragging', 'wm-resizing')
    _drag = null
    _persist(id)
  }
  document.addEventListener('pointermove', _onPointerMove)
  document.addEventListener('pointerup', _onPointerUp)
  document.addEventListener('pointercancel', _onPointerUp)

  function destroy() {
    document.removeEventListener('pointermove', _onPointerMove)
    document.removeEventListener('pointerup', _onPointerUp)
    document.removeEventListener('pointercancel', _onPointerUp)
    for (const id of [...windows.keys()]) close(id)
    _drag = null
  }

  return { open, close, focus, getWindow, destroy, get focusedId() { return focusedId }, container }
}
