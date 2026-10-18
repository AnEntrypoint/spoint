import { sampleMinimapCell, shadeHeightGrid } from '../../src/shared/MinimapBiome.js'
import { createPlacementScanner } from './MinimapPlacements.js'
import { createModelFootprints } from './MinimapModels.js'
import { paintChunkGlyphs, paintFootprints } from './MinimapGlyphs.js'
import { ensureStyle } from './ensureStyle.js'

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

// A refresh re-solves the whole BUFFER_CELLS^2 grid. The grid origin used to be the pose, so a
// refresh triggered by drift re-solved every cell at a slightly different (x,z) and the ground
// sampler's memo could not recognise any of it as work it had already done. Snapping the origin to
// a world-aligned multiple of the cell size makes a cell's (x,z) a pure function of its lattice
// index, which is what lets the next refresh reuse the overlap instead of re-solving it.
// Rounding (not flooring) keeps the snapped origin within half a cell of the pose; flooring would
// push it a whole cell away on one side.
export function minimapGridOrigin(centreM, spanM, cells) {
  const cellMeters = spanM / cells
  if (!(cellMeters > 0) || !Number.isFinite(centreM)) return { cellMeters, origin: NaN }
  return { cellMeters, origin: Math.round((centreM - spanM / 2) / cellMeters) * cellMeters }
}

// Whole-cell shift of the next grid relative to the previous one, or null when the two do not sit
// on the same lattice. Destination cell (r, c) reads source cell (r + dRow, c + dCol), so a
// positive shift means the new grid lies further along the axis than the old one and its first
// rows/columns are territory the previous refresh never covered. A fractional shift means the
// lattices disagree and nothing may be reused.
export function minimapCarryShift(prevLeft, prevTop, nextLeft, nextTop, cellMeters, cells) {
  if (!(cellMeters > 0) || !Number.isFinite(prevLeft) || !Number.isFinite(prevTop) || !Number.isFinite(nextLeft) || !Number.isFinite(nextTop)) return null
  const dCol = Math.round((nextLeft - prevLeft) / cellMeters)
  const dRow = Math.round((nextTop - prevTop) / cellMeters)
  if (!Number.isFinite(dCol) || !Number.isFinite(dRow)) return null
  if (Math.abs(dCol) >= cells || Math.abs(dRow) >= cells) return null
  if (Math.abs((nextLeft - prevLeft) - dCol * cellMeters) > cellMeters * 1e-6) return null
  if (Math.abs((nextTop - prevTop) - dRow * cellMeters) > cellMeters * 1e-6) return null
  return { dRow, dCol }
}

// Scroll-blit the overlapping window of the previous grid onto the next one and mark those cells
// solved. Iteration runs against the shift on both axes so a destination never overwrites a source
// it has still to read. This moves bytes, not heights: a carried cell keeps the value the previous
// refresh solved for that exact (x,z).
export function minimapCarryGrid(dRow, dCol, cells, heights, land, biome, filled) {
  let carried = 0
  if (filled) filled.fill(0)
  const rowStep = dRow > 0 ? 1 : -1
  const colStep = dCol > 0 ? 1 : -1
  const rowFrom = dRow > 0 ? 0 : cells - 1
  const colFrom = dCol > 0 ? 0 : cells - 1
  for (let r = rowFrom, rEnd = dRow > 0 ? cells : -1; r !== rEnd; r += rowStep) {
    const sr = r + dRow
    if (sr < 0 || sr >= cells) continue
    for (let c = colFrom, cEnd = dCol > 0 ? cells : -1; c !== cEnd; c += colStep) {
      const sc = c + dCol
      if (sc < 0 || sc >= cells) continue
      const si = sr * cells + sc
      const di = r * cells + c
      heights[di] = heights[si]
      land[di] = land[si]
      const so = si * 3, dofs = di * 3
      biome[dofs] = biome[so]; biome[dofs + 1] = biome[so + 1]; biome[dofs + 2] = biome[so + 2]
      if (filled) filled[di] = 1
      carried++
    }
  }
  return carried
}

const CSS = `
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

function seedOf(sources, terrain) {
  const cfg = (sources.vegetation && sources.vegetation.cfg) || (sources.rocks && sources.rocks.cfg) || null
  if (cfg && Number.isInteger(cfg.seed)) return cfg.seed
  const published = typeof window !== 'undefined' ? window.__terrain : null
  if (!published || published.frame !== terrain.frame || !Number.isInteger(published.seed)) return null
  return published.seed
}

// The grid geometry a minimap-refresh witness has to mirror; exported so the witness measures the
// numbers the HUD actually uses instead of a copy that can drift.
export const MINIMAP_GRID = Object.freeze({
  cells: BUFFER_CELLS,
  overView: BUFFER_OVER_VIEW,
  defaultViewSpanM: DEFAULT_VIEW_SPAN_M,
  driftOverView: REFRESH_DRIFT_OVER_VIEW,
  cellsPerCheck: TERRAIN_CELLS_PER_CHECK,
})

export function createMinimapHUD(minimapMeta, getPose, getTerrain) {
  ensureStyle('minimap-hud-style', CSS)
  if (!minimapMeta || !minimapMeta.base || !Array.isArray(minimapMeta.center) || !Number.isFinite(minimapMeta.extent) || minimapMeta.extent <= 0) {
    return { update() {}, dispose() {}, setViewSpan() {} }
  }
  const state = { baked: null, terrain: null, current: null, work: null, sampled: null, version: 0, viewSpan: DEFAULT_VIEW_SPAN_M, stalePlacements: false }
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
  const filled = new Uint8Array(BUFFER_CELLS * BUFFER_CELLS)
  const relief = { shade: new Float32Array(BUFFER_CELLS * BUFFER_CELLS), cells: BUFFER_CELLS, cellMeters: 1 }
  const cellRgb = [0, 0, 0, 0]
  const scanner = createPlacementScanner()
  const footprints = createModelFootprints()
  const stats = { lastUpdateMs: 0, refreshes: 0, glyphChunks: 0, cellsSampled: 0, cellsCarried: 0, refreshesWithCarry: 0 }
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
    paintChunkGlyphs(layer.overlayCtx, packed, w.left, w.top, pxPerMeter, dpr, relief)
    stats.glyphChunks++
  }

  function carryPreviousGrid(w) {
    // __minimapNoCarry is a witness hook: set it before boot and every refresh re-solves the whole
    // grid, which is the pre-dedup behaviour the minimap-refresh witness measures against.
    if (typeof window !== 'undefined' && window.__minimapNoCarry === true) { filled.fill(0); return 0 }
    const prev = state.sampled
    if (!prev || prev.frame !== w.frame || prev.epoch !== w.epoch || prev.cellMeters !== w.cellMeters) { filled.fill(0); return 0 }
    const shift = minimapCarryShift(prev.left, prev.top, w.left, w.top, w.cellMeters, BUFFER_CELLS)
    if (!shift) { filled.fill(0); return 0 }
    return minimapCarryGrid(shift.dRow, shift.dCol, BUFFER_CELLS, heights, land, biome, filled)
  }

  function beginRefresh(pose, terrain, sources) {
    const span = bufferSpan()
    const frame = terrain.frame
    const cellMeters = span / BUFFER_CELLS
    const snapX = minimapGridOrigin(pose.x, span, BUFFER_CELLS)
    const snapZ = minimapGridOrigin(pose.z, span, BUFFER_CELLS)
    const w = {
      cx: pose.x, cz: pose.z, span, row: 0, col: 0, phase: 0, rowGuess: NaN,
      left: snapX.origin, top: snapZ.origin, cellMeters,
      frame, epoch: frame ? frame.chartEpoch : 0,
      anchorField: terrain.sampler && terrain.sampler.anchorField,
      progressive: !state.current || state.current.span !== span,
      seed: seedOf(sources, terrain),
    }
    // begin's verdict is recorded on the work item: a refused window (null handle) is terminal, so
    // it touches no cache and reaches no layer swap or refresh count in advanceRefresh.
    w.placement = scanner.begin(w.frame, w.anchorField, sources, w.seed, w.cx, w.cz, span / 2)
    w.refused = w.placement === null
    state.work = w
    if (w.refused) return
    w.carried = carryPreviousGrid(w)
    if (w.carried > 0) { stats.cellsCarried += w.carried; stats.refreshesWithCarry++ }
  }

  function swapLayers(w) {
    const t = front; front = back; back = t
    front.cx = w.left + w.span / 2; front.cz = w.top + w.span / 2
    state.current = { cx: front.cx, cz: front.cz, span: w.span }
  }

  function advanceTerrain(w, deadline) {
    const cellMeters = w.cellMeters
    const left = w.left, top = w.top
    while (w.row < BUFFER_CELLS && performance.now() < deadline) {
      const z = top + (w.row + 0.5) * cellMeters
      const end = Math.min(BUFFER_CELLS, w.col + TERRAIN_CELLS_PER_CHECK)
      for (let i = w.col; i < end; i++) {
        const idx = w.row * BUFFER_CELLS + i
        // A carried cell the previous refresh could not sample stays unsampled: it is re-asked here
        // rather than inheriting a NaN it might not deserve a second time.
        if (filled[idx] && Number.isFinite(heights[idx])) { w.rowGuess = heights[idx]; continue }
        try {
          heights[idx] = sampleMinimapCell(w.frame, w.anchorField, left + (i + 0.5) * cellMeters, z, cellRgb, w.rowGuess) ?? NaN
        } catch (e) {
          reportSampleFailure(e)
          heights[idx] = NaN
          cellRgb[0] = UNSAMPLED_RGB[0]; cellRgb[1] = UNSAMPLED_RGB[1]; cellRgb[2] = UNSAMPLED_RGB[2]; cellRgb[3] = 0
          cellRgb[4] = NaN
        }
        stats.cellsSampled++
        w.rowGuess = Number.isFinite(heights[idx]) && Number.isFinite(cellRgb[4]) ? cellRgb[4] : NaN
        land[idx] = cellRgb[3]
        biome[idx * 3] = cellRgb[0]; biome[idx * 3 + 1] = cellRgb[1]; biome[idx * 3 + 2] = cellRgb[2]
      }
      if (end < BUFFER_CELLS) w.col = end
      else { w.col = 0; w.row++; w.rowGuess = NaN }
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
    if (w.refused) { state.work = null; return }
    if (w.phase === 0) {
      if (!advanceTerrain(w, deadline)) return
      w.phase = 1
      state.sampled = { left: w.left, top: w.top, cellMeters: w.cellMeters, epoch: w.epoch, frame: w.frame }
      return
    }
    if (w.phase === 1) { finishTerrain(w); w.phase = 2; return }
    if (!w.placement) { state.work = null; return }
    const done = w.placement.step(deadline, paintGlyphChunk)
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
    if (terrain !== state.terrain) { state.terrain = terrain; state.current = null; state.work = null; state.sampled = null }
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
