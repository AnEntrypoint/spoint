import { sampleMinimapCell, shadeHeightGrid } from '../../src/shared/MinimapBiome.js'
import { createPlacementScanner } from './MinimapPlacements.js'
import { createModelFootprints } from './MinimapModels.js'
import { paintChunkGlyphs, paintFootprints } from './MinimapGlyphs.js'

const SIZE_PX = 168
const DEFAULT_VIEW_SPAN_M = 512
const MIN_VIEW_SPAN_M = 128
const MAX_VIEW_SPAN_M = 1024
const BUFFER_OVER_VIEW = 1.5
const BUFFER_CELLS = 128
const REFRESH_DRIFT_OVER_VIEW = 1 / 8
const SLICE_MS = 1.5
const TERRAIN_CELLS_PER_CHECK = 16
const ARROW_LENGTH_PX = 9
const ARROW_HALF_WIDTH_PX = 6
const NO_SHIFT = Object.freeze({ x: 0, y: 0, z: 0 })
const UNSAMPLED_RGB = [10, 22, 32]
let sampleFailureReported = false

function reportSampleFailure(e) {
  if (sampleFailureReported) return
  sampleFailureReported = true
  console.error('[minimap] terrain cell sample failed; unsampled cells draw as background:', e && e.message || e)
}

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

function makeLayer(overlayPx) {
  const terrain = document.createElement('canvas')
  terrain.width = BUFFER_CELLS; terrain.height = BUFFER_CELLS
  const overlay = document.createElement('canvas')
  overlay.width = overlayPx; overlay.height = overlayPx
  const terrainCtx = terrain.getContext('2d')
  return { terrain, terrainCtx, image: terrainCtx.createImageData(BUFFER_CELLS, BUFFER_CELLS), overlay, overlayCtx: overlay.getContext('2d'), cx: 0, cz: 0 }
}

function readWorldSources(out) {
  const app = typeof window !== 'undefined' ? window.__app : null
  out.vegetation = (app && app.vegetation) || null
  out.rocks = (app && app.rocks) || null
  out.entityMeshes = (app && app.el && app.el.entityMeshes) || null
  return out
}

const strokesOf = source => (source && source.biomeOverride ? source.biomeOverride.strokeCount : 0)

function placementInputsChanged(sources, seen) {
  const v = sources.vegetation, r = sources.rocks
  const changed = v !== seen.vegetation || r !== seen.rocks || strokesOf(v) !== seen.vegStrokes || strokesOf(r) !== seen.rockStrokes
  seen.vegetation = v; seen.rocks = r; seen.vegStrokes = strokesOf(v); seen.rockStrokes = strokesOf(r)
  return changed
}

function worldSeedOf(sources, terrain) {
  const cfg = (sources.vegetation && sources.vegetation.cfg) || (sources.rocks && sources.rocks.cfg) || null
  if (cfg && cfg.seed != null) return cfg.seed | 0
  const published = typeof window !== 'undefined' ? window.__terrain : null
  return (published && published.frame === terrain.frame && published.seed != null ? published.seed : 0) | 0
}

export function createMinimapHUD(minimapMeta, getPose, getTerrain) {
  ensureStyles()
  if (!minimapMeta || !minimapMeta.base || !Array.isArray(minimapMeta.center) || !Number.isFinite(minimapMeta.extent) || minimapMeta.extent <= 0) {
    return { update() {}, dispose() {}, setViewSpan() {} }
  }
  const state = { baked: null, terrain: null, current: null, work: null, version: 0, viewSpan: DEFAULT_VIEW_SPAN_M, stalePlacements: false }
  const seenInputs = { vegetation: undefined, rocks: undefined, vegStrokes: -1, rockStrokes: -1 }

  const root = document.createElement('div')
  root.id = 'minimap-hud'
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(SIZE_PX * dpr); canvas.height = Math.round(SIZE_PX * dpr)
  const ctx2d = canvas.getContext('2d')
  root.appendChild(canvas)
  document.body.appendChild(root)

  const overlayPx = Math.round(canvas.width * BUFFER_OVER_VIEW)
  let front = makeLayer(overlayPx), back = makeLayer(overlayPx)
  const heights = new Float32Array(BUFFER_CELLS * BUFFER_CELLS)
  const land = new Uint8Array(BUFFER_CELLS * BUFFER_CELLS)
  const biome = new Uint8Array(BUFFER_CELLS * BUFFER_CELLS * 3)
  const relief = { shade: new Float32Array(BUFFER_CELLS * BUFFER_CELLS), cells: BUFFER_CELLS, cellMeters: 1 }
  const cellRgb = [0, 0, 0, 0]
  const scanner = createPlacementScanner()
  const footprints = createModelFootprints()
  const stats = { lastUpdateMs: 0, refreshes: 0, glyphChunks: 0 }
  const liveSources = { vegetation: null, rocks: null, entityMeshes: null }
  let pxPerMeter = canvas.width / state.viewSpan

  const bufferSpan = () => state.viewSpan * BUFFER_OVER_VIEW

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

  function paintGlyphChunk(packed) {
    const w = state.work
    const layer = w.progressive ? front : back
    paintChunkGlyphs(layer.overlayCtx, packed, w.cx - w.span / 2, w.cz - w.span / 2, pxPerMeter, dpr, relief)
    stats.glyphChunks++
  }

  function beginRefresh(pose, terrain, sources) {
    const span = bufferSpan()
    state.work = { cx: pose.x, cz: pose.z, span, row: 0, col: 0, phase: 0, frame: terrain.frame, anchorField: terrain.sampler && terrain.sampler.anchorField, progressive: !state.current || state.current.span !== span }
    scanner.begin(terrain.frame, state.work.anchorField, sources, worldSeedOf(sources, terrain), pose.x, pose.z, span / 2)
  }

  function swapLayers(w) {
    const t = front; front = back; back = t
    front.cx = w.cx; front.cz = w.cz
    state.current = { cx: w.cx, cz: w.cz, span: w.span }
  }

  function advanceTerrain(w, deadline) {
    const cellMeters = w.span / BUFFER_CELLS
    const left = w.cx - w.span / 2, top = w.cz - w.span / 2
    while (w.row < BUFFER_CELLS && performance.now() < deadline) {
      const z = top + (w.row + 0.5) * cellMeters
      const end = Math.min(BUFFER_CELLS, w.col + TERRAIN_CELLS_PER_CHECK)
      for (let i = w.col; i < end; i++) {
        const idx = w.row * BUFFER_CELLS + i
        try {
          heights[idx] = sampleMinimapCell(w.frame, w.anchorField, left + (i + 0.5) * cellMeters, z, cellRgb)
        } catch (e) {
          reportSampleFailure(e)
          heights[idx] = NaN
          cellRgb[0] = UNSAMPLED_RGB[0]; cellRgb[1] = UNSAMPLED_RGB[1]; cellRgb[2] = UNSAMPLED_RGB[2]; cellRgb[3] = 0
        }
        land[idx] = cellRgb[3]
        biome[idx * 3] = cellRgb[0]; biome[idx * 3 + 1] = cellRgb[1]; biome[idx * 3 + 2] = cellRgb[2]
      }
      if (end < BUFFER_CELLS) w.col = end
      else { w.col = 0; w.row++ }
    }
    return w.row >= BUFFER_CELLS
  }

  function finishTerrain(w) {
    const data = back.image.data
    relief.cellMeters = w.span / BUFFER_CELLS
    shadeHeightGrid(heights, BUFFER_CELLS, BUFFER_CELLS, relief.cellMeters, land, biome, data, 3, 4, relief.shade)
    for (let o = 3; o < data.length; o += 4) data[o] = 255
    back.terrainCtx.putImageData(back.image, 0, 0)
    back.overlayCtx.clearRect(0, 0, overlayPx, overlayPx)
    if (w.progressive) { swapLayers(w); state.version++ }
  }

  function advanceRefresh() {
    const w = state.work
    const deadline = performance.now() + SLICE_MS
    if (w.phase === 0) { if (advanceTerrain(w, deadline)) w.phase = 1; return }
    if (w.phase === 1) { finishTerrain(w); w.phase = 2; return }
    const done = scanner.step(deadline, paintGlyphChunk)
    if (w.progressive) state.version++
    if (!done) return
    if (!w.progressive) swapLayers(w)
    stats.refreshes++
    state.work = null
    state.version++
  }

  function driftFrom(anchor, pose) {
    return Math.max(Math.abs(pose.x - anchor.cx), Math.abs(pose.z - anchor.cz))
  }

  function drawWorldImage(img, leftM, topM, spanM, pose) {
    const dx = (leftM - (pose.x - state.viewSpan / 2)) * pxPerMeter
    const dy = (topM - (pose.z - state.viewSpan / 2)) * pxPerMeter
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
    const t0 = performance.now()
    const pose = getPose && getPose()
    if (!pose || !Number.isFinite(pose.x) || !Number.isFinite(pose.z)) return
    const terrain = getTerrain && getTerrain()
    const frame = terrain && terrain.frame
    if (terrain !== state.terrain) { state.terrain = terrain; state.current = null; state.work = null }
    const sources = readWorldSources(liveSources)
    if (placementInputsChanged(sources, seenInputs)) { state.stalePlacements = true; state.work = null }
    const refreshDrift = state.viewSpan * REFRESH_DRIFT_OVER_VIEW
    if (frame && !state.work && (!state.current || state.current.span !== bufferSpan() || state.stalePlacements || driftFrom(state.current, pose) > refreshDrift)) {
      state.stalePlacements = false
      beginRefresh(pose, terrain, sources)
    }
    if (state.work) advanceRefresh()
    const fo = typeof window !== 'undefined' && window.__floatingOrigin
    if (footprints.collect(sources.entityMeshes, fo ? fo.getShift() : NO_SHIFT, t0)) state.version++
    const liveCovers = state.current && state.current.span === bufferSpan() && driftFrom(state.current, pose) <= (state.current.span - state.viewSpan) / 2
    const yaw = Number.isFinite(pose.yaw) ? pose.yaw : 0
    if (pose.x === drawnX && pose.z === drawnZ && yaw === drawnYaw && state.version === drawnVersion) { stats.lastUpdateMs = performance.now() - t0; return }
    drawnX = pose.x; drawnZ = pose.z; drawnYaw = yaw; drawnVersion = state.version
    ctx2d.fillStyle = '#0a1620'
    ctx2d.fillRect(0, 0, canvas.width, canvas.height)
    if (liveCovers) {
      const left = front.cx - state.current.span / 2, top = front.cz - state.current.span / 2
      drawWorldImage(front.terrain, left, top, state.current.span, pose)
      drawWorldImage(front.overlay, left, top, state.current.span, pose)
    } else if (state.baked) drawWorldImage(state.baked, minimapMeta.center[0] - minimapMeta.extent / 2, minimapMeta.center[1] - minimapMeta.extent / 2, minimapMeta.extent, pose)
    paintFootprints(ctx2d, footprints.corners, footprints.count, pose.x - state.viewSpan / 2, pose.z - state.viewSpan / 2, pxPerMeter, dpr)
    drawMarker(yaw)
    if (liveCovers || state.baked) root.style.display = 'block'
    stats.lastUpdateMs = performance.now() - t0
  }

  function setViewSpan(spanM) {
    const next = Math.max(MIN_VIEW_SPAN_M, Math.min(MAX_VIEW_SPAN_M, Number(spanM) || DEFAULT_VIEW_SPAN_M))
    if (next === state.viewSpan) return state.viewSpan
    state.viewSpan = next
    pxPerMeter = canvas.width / next
    state.work = null
    state.version++
    return next
  }

  function dispose() {
    root.remove()
    if (typeof window !== 'undefined' && window.__minimapHUD === api) window.__minimapHUD = null
  }

  const api = { update, dispose, setViewSpan, get viewSpan() { return state.viewSpan }, stats, footprints, glyphSnapshot: scanner.glyphSnapshot, get cachedChunks() { return scanner.cachedChunks } }
  if (typeof window !== 'undefined') window.__minimapHUD = api
  return api
}
