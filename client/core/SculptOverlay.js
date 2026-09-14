import { createHeightDelta } from '/src/terrain/HeightDelta.js'

const WINDOW_MARGIN = 1.5
const BACKFILL_EXTENT_DEFAULT = 48

export function createSculptOverlay(terrainBackdrop) {
  const heightDelta = createHeightDelta()
  let _lastExtent = 0

  function _render() { return terrainBackdrop?.planet?.render }
  function _frame() { return terrainBackdrop?.frame }

  function _upload(centerX, centerZ, extent) {
    const render = _render(), frame = _frame()
    if (!render || typeof render.setSculptOverride !== 'function' || !frame) return false
    const res = render.SCULPT_RES || 256
    const heights = new Float32Array(res * res)
    const step = (2 * extent) / (res - 1)
    for (let row = 0; row < res; row++) {
      const z = centerZ - extent + row * step
      const base = row * res
      for (let col = 0; col < res; col++) {
        const x = centerX - extent + col * step
        heights[base + col] = heightDelta.deltaAt(x, z)
      }
    }
    render.setSculptOverride([centerX, centerZ], extent, { up: frame.up, east: frame.east, north: frame.north }, heights)
    _lastExtent = extent
    return true
  }

  function applyStroke(payload) {
    if (!payload || payload.ok === false) return false
    const { brush, x, z, radius, strength, targetHeight } = payload
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius <= 0) return false
    if (brush === 'smooth') {
      heightDelta.applySmoothBrush(x, z, radius, Math.min(1, Math.abs(strength)))
    } else if (brush === 'flatten') {
      const frame = _frame()
      if (!frame || typeof frame.groundHeightLocal !== 'function' || !Number.isFinite(targetHeight)) return false
      heightDelta.applyFlattenBrush((cx, cz) => frame.groundHeightLocal(cx, cz), x, z, radius, targetHeight, Math.min(1, Math.abs(strength)))
    } else {
      heightDelta.applyRaiseBrush(x, z, radius, brush === 'lower' ? -Math.abs(strength) : Math.abs(strength))
    }
    const extent = Math.max(radius * WINDOW_MARGIN, 4)
    return _upload(x, z, extent)
  }

  function clear() {
    heightDelta.clear()
    const render = _render()
    if (render && typeof render.clearSculptOverride === 'function') render.clearSculptOverride()
  }

  function applyBackfill(json, centerX, centerZ, extent) {
    if (!json || !Array.isArray(json.strokes) || json.strokes.length === 0) return { replayed: 0, uploaded: false }
    let replayed = 0
    for (const s of json.strokes) {
      if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.z) || !Number.isFinite(s.radius) || !Number.isFinite(s.strength)) continue
      if (s.brush === 'flatten') continue
      if (s.brush === 'smooth') heightDelta.applySmoothBrush(s.x, s.z, s.radius, Math.min(1, Math.abs(s.strength)))
      else heightDelta.applyRaiseBrush(s.x, s.z, s.radius, s.brush === 'lower' ? -Math.abs(s.strength) : Math.abs(s.strength))
      replayed++
    }
    if (replayed === 0) return { replayed: 0, uploaded: false }
    const cx = Number.isFinite(centerX) ? centerX : 0
    const cz = Number.isFinite(centerZ) ? centerZ : 0
    const ext = Number.isFinite(extent) && extent > 0 ? extent : BACKFILL_EXTENT_DEFAULT
    const uploaded = _upload(cx, cz, ext)
    return { replayed, uploaded }
  }

  return { applyStroke, applyBackfill, clear, get cellCount() { return heightDelta.cellCount }, get strokeCount() { return heightDelta.strokeCount }, get lastExtent() { return _lastExtent } }
}
