import { brushPrecondition, brushApplied, STRENGTH_REQUIRES } from './brushResult.js'
import { heightStrokeReplay, replayStrokes } from './brushStroke.js'

export let CELL_M = 1

export let RAISE_REQUIRES = Object.freeze(['x is finite', 'z is finite', 'radius is finite and positive', 'strength is finite and non-zero'])
export let FLATTEN_REQUIRES = Object.freeze(['baseHeightFn is a function', 'x is finite', 'z is finite', 'radius is finite and positive', 'targetHeight is finite'])
export let CARVE_REQUIRES = Object.freeze(['baseHeightFn is a function', 'x is finite', 'z is finite', 'halfWidth is finite and positive', 'halfDepth is finite and positive', 'targetDepth is finite'])
export let SMOOTH_REQUIRES = Object.freeze(['x is finite', 'z is finite', 'radius is finite and positive', 'strength is finite and positive'])

function cellKey(cx, cz) {
  const BIG = 1 << 23, OFF = BIG >> 1
  return (cx + OFF) * BIG + (cz + OFF)
}

export function createHeightDelta(strokes, baseHeightFn) {
  const cells = new Map()
  const appliedStrokes = []

  function cellCenter(cx, cz) { return [cx * CELL_M + CELL_M * 0.5, cz * CELL_M + CELL_M * 0.5] }

  function applyRaiseBrush(x, z, radius, strength) {
    const bad = brushPrecondition(RAISE_REQUIRES, [Number.isFinite(x), Number.isFinite(z), Number.isFinite(radius) && radius > 0, Number.isFinite(strength) && strength !== 0])
    if (bad) return bad
    const cx0 = Math.floor((x - radius) / CELL_M), cx1 = Math.ceil((x + radius) / CELL_M)
    const cz0 = Math.floor((z - radius) / CELL_M), cz1 = Math.ceil((z + radius) / CELL_M)
    let touched = 0
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const [ccx, ccz] = cellCenter(cx, cz)
        const dx = ccx - x, dz = ccz - z
        const d = Math.hypot(dx, dz)
        if (d > radius) continue
        const falloff = 0.5 * (1 + Math.cos((d / radius) * Math.PI))
        const key = cellKey(cx, cz)
        const prev = cells.get(key) || 0
        cells.set(key, prev + strength * falloff)
        touched++
      }
    }
    return brushApplied(appliedStrokes, touched, { x, z, radius, strength, brush: strength >= 0 ? 'raise' : 'lower' })
  }

  function cellRaw(cx, cz) { return cells.get(cellKey(cx, cz)) || 0 }

  const FLATTEN_FEATHER_FRACTION = 0.3
  function applyFlattenBrush(baseHeightFn, x, z, radius, targetHeight, strength) {
    const bad = brushPrecondition(FLATTEN_REQUIRES, [typeof baseHeightFn === 'function', Number.isFinite(x), Number.isFinite(z), Number.isFinite(radius) && radius > 0, Number.isFinite(targetHeight)])
    if (bad) return bad
    const clampedStrength = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 1
    const weak = brushPrecondition(STRENGTH_REQUIRES, [clampedStrength > 0])
    if (weak) return weak
    const plateauRadius = radius * (1 - FLATTEN_FEATHER_FRACTION)
    const featherSpan = radius - plateauRadius
    const cx0 = Math.floor((x - radius) / CELL_M), cx1 = Math.ceil((x + radius) / CELL_M)
    const cz0 = Math.floor((z - radius) / CELL_M), cz1 = Math.ceil((z + radius) / CELL_M)
    let touched = 0
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const [ccx, ccz] = cellCenter(cx, cz)
        const dx = ccx - x, dz = ccz - z
        const d = Math.hypot(dx, dz)
        if (d > radius) continue
        const base = baseHeightFn(ccx, ccz)
        if (!Number.isFinite(base)) continue
        const targetDelta = targetHeight - base
        const current = cellRaw(cx, cz)
        const falloff = d <= plateauRadius ? 1 : 0.5 * (1 + Math.cos(((d - plateauRadius) / featherSpan) * Math.PI))
        const t = clampedStrength * falloff
        const key = cellKey(cx, cz)
        cells.set(key, current + (targetDelta - current) * t)
        touched++
      }
    }
    return brushApplied(appliedStrokes, touched, { x, z, radius, strength: clampedStrength, targetHeight, brush: 'flatten' })
  }

  const RECT_FEATHER_FRACTION = 0.15
  function applyRectangularCarve(baseHeightFn, x, z, halfWidth, halfDepth, targetDepth, strength) {
    const bad = brushPrecondition(CARVE_REQUIRES, [typeof baseHeightFn === 'function', Number.isFinite(x), Number.isFinite(z), Number.isFinite(halfWidth) && halfWidth > 0, Number.isFinite(halfDepth) && halfDepth > 0, Number.isFinite(targetDepth)])
    if (bad) return bad
    const clampedStrength = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 1
    const weak = brushPrecondition(STRENGTH_REQUIRES, [clampedStrength > 0])
    if (weak) return weak
    const plateauHW = halfWidth * (1 - RECT_FEATHER_FRACTION)
    const plateauHD = halfDepth * (1 - RECT_FEATHER_FRACTION)
    const featherW = halfWidth - plateauHW
    const featherD = halfDepth - plateauHD
    const cx0 = Math.floor((x - halfWidth) / CELL_M), cx1 = Math.ceil((x + halfWidth) / CELL_M)
    const cz0 = Math.floor((z - halfDepth) / CELL_M), cz1 = Math.ceil((z + halfDepth) / CELL_M)
    let touched = 0
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const [ccx, ccz] = cellCenter(cx, cz)
        const dx = Math.abs(ccx - x), dz = Math.abs(ccz - z)
        if (dx > halfWidth || dz > halfDepth) continue
        const base = baseHeightFn(ccx, ccz)
        if (!Number.isFinite(base)) continue
        const targetDelta = targetDepth - base
        const current = cellRaw(cx, cz)
        let falloffX = 1, falloffZ = 1
        if (dx > plateauHW) falloffX = 0.5 * (1 + Math.cos(((dx - plateauHW) / featherW) * Math.PI))
        if (dz > plateauHD) falloffZ = 0.5 * (1 + Math.cos(((dz - plateauHD) / featherD) * Math.PI))
        const falloff = falloffX * falloffZ
        const t = clampedStrength * falloff
        const key = cellKey(cx, cz)
        cells.set(key, current + (targetDelta - current) * t)
        touched++
      }
    }
    return brushApplied(appliedStrokes, touched, { x, z, halfWidth, halfDepth, targetDepth, strength: clampedStrength, brush: 'rectangularCarve' })
  }

  const SMOOTH_KERNEL_CELLS = 2
  function applySmoothBrush(x, z, radius, strength) {
    const bad = brushPrecondition(SMOOTH_REQUIRES, [Number.isFinite(x), Number.isFinite(z), Number.isFinite(radius) && radius > 0, Number.isFinite(strength) && strength > 0])
    if (bad) return bad
    const clampedStrength = Math.min(1, strength)
    const cx0 = Math.floor((x - radius) / CELL_M), cx1 = Math.ceil((x + radius) / CELL_M)
    const cz0 = Math.floor((z - radius) / CELL_M), cz1 = Math.ceil((z + radius) / CELL_M)
    const writes = []
    let touched = 0
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const [ccx, ccz] = cellCenter(cx, cz)
        const dx = ccx - x, dz = ccz - z
        const d = Math.hypot(dx, dz)
        if (d > radius) continue
        let sum = 0, n = 0
        for (let kz = -SMOOTH_KERNEL_CELLS; kz <= SMOOTH_KERNEL_CELLS; kz++) {
          for (let kx = -SMOOTH_KERNEL_CELLS; kx <= SMOOTH_KERNEL_CELLS; kx++) {
            sum += cellRaw(cx + kx, cz + kz); n++
          }
        }
        const avg = sum / n
        const current = cellRaw(cx, cz)
        if (avg === current) continue
        const falloff = 0.5 * (1 + Math.cos((d / radius) * Math.PI))
        const t = clampedStrength * falloff
        writes.push([cellKey(cx, cz), current + (avg - current) * t])
        touched++
      }
    }
    for (const [key, val] of writes) cells.set(key, val)
    return brushApplied(appliedStrokes, touched, { x, z, radius, strength: clampedStrength, brush: 'smooth' })
  }

  function deltaAt(x, z) {
    if (cells.size === 0) return 0
    const fx = x / CELL_M, fz = z / CELL_M
    const ix = Math.floor(fx), iz = Math.floor(fz)
    const tx = fx - ix, tz = fz - iz
    const h00 = cells.get(cellKey(ix, iz)) || 0
    const h10 = cells.get(cellKey(ix + 1, iz)) || 0
    const h01 = cells.get(cellKey(ix, iz + 1)) || 0
    const h11 = cells.get(cellKey(ix + 1, iz + 1)) || 0
    if (h00 === 0 && h10 === 0 && h01 === 0 && h11 === 0) return 0
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz
  }

  function wrapHeightFn(baseHeightFn) {
    if (typeof baseHeightFn !== 'function') return baseHeightFn
    return function deltaWrappedHeightFn(x, z, yGuess) {
      const base = baseHeightFn(x, z, yGuess)
      if (!Number.isFinite(base)) return base
      return base + deltaAt(x, z)
    }
  }

  function toJSON() { return { version: 1, cellM: CELL_M, strokes: appliedStrokes.slice() } }

  function clear() { cells.clear(); appliedStrokes.length = 0 }

  const api = { applyRaiseBrush, applySmoothBrush, applyFlattenBrush, applyRectangularCarve, deltaAt, wrapHeightFn, toJSON, clear, get cellCount() { return cells.size }, get strokeCount() { return appliedStrokes.length } }
  replayStrokes(strokes, heightStrokeReplay(api, baseHeightFn))
  return api
}

export function loadHeightDelta(json, baseHeightFn) {
  return createHeightDelta(json && json.strokes, baseHeightFn)
}

// --- hot swap ----------------------------------------------------------------------------
// An edit to this file used to be classified RELOAD: findBoundaries walked from here to the app
// root and found no acceptor, so a save cost a whole page load. No boundary ABOVE this file can
// fix that, because a re-import is a new module instance and every importer keeps reading the
// one it imported at boot. What can is this file itself: an ESM import is a LIVE binding to this
// instance's export bindings, so re-assigning them here is visible to every importer already
// holding them. Self-accepting therefore turns the cost of a save into one module fetch.
// This re-points code only. It does not rebuild state the page already built, and every export
// below is re-assigned, so nothing an importer holds is left pointing at the previous copy.
const _hotSwapHeightDelta = (next) => {
  CELL_M = next.CELL_M
  RAISE_REQUIRES = next.RAISE_REQUIRES
  FLATTEN_REQUIRES = next.FLATTEN_REQUIRES
  CARVE_REQUIRES = next.CARVE_REQUIRES
  SMOOTH_REQUIRES = next.SMOOTH_REQUIRES
  createHeightDelta = next.createHeightDelta
  loadHeightDelta = next.loadHeightDelta
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapHeightDelta)
