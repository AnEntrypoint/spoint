const SIZE_PX = 168
const DOT_RADIUS_PX = 4

function ensureStyles() {
  if (document.getElementById('minimap-hud-style')) return
  const style = document.createElement('style')
  style.id = 'minimap-hud-style'
  style.textContent = `
#minimap-hud {
  position: fixed; top: 10px; right: 10px; z-index: 9400;
  width: ${SIZE_PX}px; height: ${SIZE_PX}px;
  border-radius: 8px; overflow: hidden;
  border: 1px solid var(--rule, rgba(0, 210, 255, 0.35));
  box-shadow: 0 2px 10px rgba(0,0,0,0.45);
  background: rgba(4,10,16,0.55);
  pointer-events: none;
  display: none;
}
#minimap-hud canvas { display: block; width: 100%; height: 100%; }
`
  document.head.appendChild(style)
}

export function createMinimapHUD(minimapMeta, getLocalXZ) {
  ensureStyles()
  const state = { armed: false, header: null, img: null }
  if (!minimapMeta || !minimapMeta.base || !Array.isArray(minimapMeta.center) || !Number.isFinite(minimapMeta.extent) || minimapMeta.extent <= 0) {
    return { update() {}, dispose() {} }
  }

  const root = document.createElement('div')
  root.id = 'minimap-hud'
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(SIZE_PX * dpr); canvas.height = Math.round(SIZE_PX * dpr)
  const ctx2d = canvas.getContext('2d')
  root.appendChild(canvas)
  document.body.appendChild(root)

  async function load() {
    try {
      const res = await fetch(minimapMeta.base + '.json')
      if (!res.ok) return
      const header = await res.json()
      if (!header || !Number.isFinite(header.N) || header.N < 2) return
      const img = new Image()
      const loaded = new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject })
      img.src = minimapMeta.base + '.png'
      await loaded
      state.header = header
      state.img = img
      state.armed = true
      root.style.display = 'block'
      _drawBase()
    } catch (e) {
      state.armed = false
    }
  }
  load()

  function _drawBase() {
    if (!state.img) return
    ctx2d.clearRect(0, 0, canvas.width, canvas.height)
    ctx2d.drawImage(state.img, 0, 0, canvas.width, canvas.height)
  }

  let _lastPx = NaN, _lastPy = NaN
  function update() {
    if (!state.armed) return
    const p = getLocalXZ && getLocalXZ()
    let px = NaN, py = NaN
    if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) {
      const [cx, cz] = minimapMeta.center
      const half = minimapMeta.extent / 2
      const u = (p.x - (cx - half)) / minimapMeta.extent
      const v = (p.z - (cz - half)) / minimapMeta.extent
      const insideBakedExtent = u >= 0 && u <= 1 && v >= 0 && v <= 1
      if (insideBakedExtent) { px = u * canvas.width; py = v * canvas.height }
    }
    const dotRasterPositionUnchanged = (Number.isNaN(px) && Number.isNaN(_lastPx)) || (Math.abs(px - _lastPx) < 0.5 && Math.abs(py - _lastPy) < 0.5)
    if (dotRasterPositionUnchanged) return
    _lastPx = px; _lastPy = py
    _drawBase()
    if (Number.isNaN(px)) return
    const r = DOT_RADIUS_PX * dpr
    ctx2d.beginPath()
    ctx2d.arc(px, py, r, 0, Math.PI * 2)
    ctx2d.fillStyle = '#ffdd33'
    ctx2d.strokeStyle = 'rgba(0,0,0,0.7)'
    ctx2d.lineWidth = 1.5 * dpr
    ctx2d.fill(); ctx2d.stroke()
  }

  function dispose() { root.remove() }

  return { update, dispose }
}
