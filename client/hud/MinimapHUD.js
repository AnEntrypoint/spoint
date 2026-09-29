import { sampleMinimapCell } from '../../src/shared/MinimapBiome.js'

const SIZE_PX = 168
const VIEW_SPAN_M = 512
const BUFFER_SPAN_M = 768
const BUFFER_CELLS = 128
const REFRESH_DRIFT_M = 64
const SLICE_MS = 1.5
const ARROW_LENGTH_PX = 9
const ARROW_HALF_WIDTH_PX = 6

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

export function createMinimapHUD(minimapMeta, getPose, getTerrain) {
  ensureStyles()
  const state = { baked: null, terrain: null, current: null, work: null, version: 0 }
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

  const bufferCanvas = document.createElement('canvas')
  bufferCanvas.width = BUFFER_CELLS; bufferCanvas.height = BUFFER_CELLS
  const bufferCtx = bufferCanvas.getContext('2d')
  const pxPerMeter = canvas.width / VIEW_SPAN_M
  const cellMeters = BUFFER_SPAN_M / BUFFER_CELLS
  const cellRgb = [0, 0, 0]

  async function loadBaked() {
    try {
      const img = new Image()
      const loaded = new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject })
      img.src = minimapMeta.base + '.png'
      await loaded
      state.baked = img
      state.version++
    } catch (e) {
      state.baked = null
    }
  }
  loadBaked()

  function beginRefresh(pose, frame, anchorField) {
    state.work = { cx: pose.x, cz: pose.z, row: 0, frame, anchorField, image: bufferCtx.createImageData(BUFFER_CELLS, BUFFER_CELLS) }
  }

  function advanceRefresh() {
    const w = state.work
    const deadline = performance.now() + SLICE_MS
    const left = w.cx - BUFFER_SPAN_M / 2, top = w.cz - BUFFER_SPAN_M / 2
    while (w.row < BUFFER_CELLS && performance.now() < deadline) {
      const z = top + (w.row + 0.5) * cellMeters
      for (let i = 0; i < BUFFER_CELLS; i++) {
        sampleMinimapCell(w.frame, w.anchorField, left + (i + 0.5) * cellMeters, z, cellRgb)
        const o = (w.row * BUFFER_CELLS + i) * 4
        w.image.data[o] = cellRgb[0]; w.image.data[o + 1] = cellRgb[1]; w.image.data[o + 2] = cellRgb[2]; w.image.data[o + 3] = 255
      }
      w.row++
    }
    if (w.row < BUFFER_CELLS) return
    bufferCtx.putImageData(w.image, 0, 0)
    state.current = { cx: w.cx, cz: w.cz }
    state.work = null
    state.version++
  }

  function driftFrom(anchor, pose) {
    return Math.max(Math.abs(pose.x - anchor.cx), Math.abs(pose.z - anchor.cz))
  }

  function drawWorldImage(img, leftM, topM, spanM, pose) {
    const dx = (leftM - (pose.x - VIEW_SPAN_M / 2)) * pxPerMeter
    const dy = (topM - (pose.z - VIEW_SPAN_M / 2)) * pxPerMeter
    ctx2d.drawImage(img, dx, dy, spanM * pxPerMeter, spanM * pxPerMeter)
  }

  function drawMarker(yaw) {
    ctx2d.save()
    ctx2d.translate(canvas.width / 2, canvas.height / 2)
    ctx2d.rotate(yaw)
    const len = ARROW_LENGTH_PX * dpr, half = ARROW_HALF_WIDTH_PX * dpr
    ctx2d.beginPath()
    ctx2d.moveTo(0, -len); ctx2d.lineTo(half, len * 0.7); ctx2d.lineTo(0, len * 0.35); ctx2d.lineTo(-half, len * 0.7); ctx2d.closePath()
    ctx2d.fillStyle = '#ffdd33'
    ctx2d.strokeStyle = 'rgba(0,0,0,0.75)'
    ctx2d.lineWidth = 1.5 * dpr
    ctx2d.fill(); ctx2d.stroke()
    ctx2d.restore()
  }

  let drawnX = NaN, drawnZ = NaN, drawnYaw = NaN, drawnVersion = -1
  function update() {
    const pose = getPose && getPose()
    if (!pose || !Number.isFinite(pose.x) || !Number.isFinite(pose.z)) return
    const terrain = getTerrain && getTerrain()
    const frame = terrain && terrain.frame
    if (terrain !== state.terrain) { state.terrain = terrain; state.current = null; state.work = null }
    if (frame && !state.work && (!state.current || driftFrom(state.current, pose) > REFRESH_DRIFT_M)) {
      beginRefresh(pose, frame, terrain.sampler && terrain.sampler.anchorField)
    }
    if (state.work) advanceRefresh()
    const liveCovers = state.current && driftFrom(state.current, pose) <= (BUFFER_SPAN_M - VIEW_SPAN_M) / 2
    if (!liveCovers && !state.baked) return
    const yaw = Number.isFinite(pose.yaw) ? pose.yaw : 0
    if (pose.x === drawnX && pose.z === drawnZ && yaw === drawnYaw && state.version === drawnVersion) return
    drawnX = pose.x; drawnZ = pose.z; drawnYaw = yaw; drawnVersion = state.version
    ctx2d.fillStyle = '#0a1620'
    ctx2d.fillRect(0, 0, canvas.width, canvas.height)
    if (liveCovers) drawWorldImage(bufferCanvas, state.current.cx - BUFFER_SPAN_M / 2, state.current.cz - BUFFER_SPAN_M / 2, BUFFER_SPAN_M, pose)
    else drawWorldImage(state.baked, minimapMeta.center[0] - minimapMeta.extent / 2, minimapMeta.center[1] - minimapMeta.extent / 2, minimapMeta.extent, pose)
    drawMarker(yaw)
    root.style.display = 'block'
  }

  function dispose() { root.remove() }

  return { update, dispose }
}
