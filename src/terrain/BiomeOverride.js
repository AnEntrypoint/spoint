import { brushPrecondition, brushApplied, STRENGTH_REQUIRES } from './brushResult.js'
import { biomeStrokeReplay, replayStrokes } from './brushStroke.js'

export let CELL_M = 8

export let PAINT_REQUIRES = Object.freeze(['x is finite', 'z is finite', 'radius is finite and positive', 'target carries a finite temp, humidity and erosion'])

function cellKey(cx, cz) {
  const KEY_AXIS_SPAN = 1 << 23, KEY_AXIS_OFFSET = KEY_AXIS_SPAN >> 1
  return (cx + KEY_AXIS_OFFSET) * KEY_AXIS_SPAN + (cz + KEY_AXIS_OFFSET)
}

export let BIOME_PRESETS = Object.freeze({
  desert: Object.freeze({ temp: 0.85, humidity: 0.10, erosion: 0.55 }),
  tundra: Object.freeze({ temp: 0.10, humidity: 0.45, erosion: 0.35 }),
  forest: Object.freeze({ temp: 0.55, humidity: 0.75, erosion: 0.25 }),
  grassland: Object.freeze({ temp: 0.55, humidity: 0.40, erosion: 0.30 }),
  wetland: Object.freeze({ temp: 0.60, humidity: 0.95, erosion: 0.15 }),
})
export let BIOME_NAMES = Object.freeze(Object.keys(BIOME_PRESETS))

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v }

export function createBiomeOverride(strokes) {
  const cells = new Map()
  const appliedStrokes = []

  function cellCenter(cx, cz) { return [cx * CELL_M + CELL_M * 0.5, cz * CELL_M + CELL_M * 0.5] }

  function applyPaintBrush(x, z, radius, target, strength) {
    const bad = brushPrecondition(PAINT_REQUIRES, [Number.isFinite(x), Number.isFinite(z), Number.isFinite(radius) && radius > 0, !!target && Number.isFinite(target.temp) && Number.isFinite(target.humidity) && Number.isFinite(target.erosion)])
    if (bad) return bad
    const clampedStrength = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 1
    const weak = brushPrecondition(STRENGTH_REQUIRES, [clampedStrength > 0])
    if (weak) return weak
    const tgt = { temp: clamp01(target.temp), humidity: clamp01(target.humidity), erosion: clamp01(target.erosion) }
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
        const t = clampedStrength * falloff
        if (t <= 0) continue
        const key = cellKey(cx, cz)
        const prev = cells.get(key)
        if (!prev) {
          cells.set(key, { temp: tgt.temp, humidity: tgt.humidity, erosion: tgt.erosion, w: t })
        } else {
          const neww = Math.min(1, prev.w + t * (1 - prev.w))
          const mix = neww > 0 ? t / neww : 0
          cells.set(key, {
            temp: prev.temp + (tgt.temp - prev.temp) * mix,
            humidity: prev.humidity + (tgt.humidity - prev.humidity) * mix,
            erosion: prev.erosion + (tgt.erosion - prev.erosion) * mix,
            w: neww,
          })
        }
        touched++
      }
    }
    return brushApplied(appliedStrokes, touched, { x, z, radius, strength: clampedStrength, target: tgt })
  }

  function overrideAt(x, z) {
    if (cells.size === 0) return null
    const cx = Math.floor(x / CELL_M), cz = Math.floor(z / CELL_M)
    return cells.get(cellKey(cx, cz)) || null
  }

  function wrapClimateField(baseField) {
    if (!baseField || typeof baseField.climateAtLocal !== 'function') return baseField
    return {
      ...baseField,
      get climateUsesLocalXZ() { return cells.size > 0 || baseField.climateUsesLocalXZ === true },
      climateAtLocal(x, z, dir) {
        const base = baseField.climateAtLocal(x, z, dir)
        const ov = overrideAt(x, z)
        if (!ov) return base
        if (!base) return { temp: ov.temp, humidity: ov.humidity, erosion: ov.erosion, seaBias: 0 }
        const w = ov.w
        return {
          temp: base.temp + (ov.temp - base.temp) * w,
          humidity: base.humidity + (ov.humidity - base.humidity) * w,
          erosion: base.erosion + (ov.erosion - base.erosion) * w,
          seaBias: base.seaBias,
        }
      },
    }
  }

  function toJSON() { return { version: 1, cellM: CELL_M, strokes: appliedStrokes.slice() } }

  function clear() { cells.clear(); appliedStrokes.length = 0 }

  const api = {
    applyPaintBrush, overrideAt, wrapClimateField, toJSON, clear,
    get cellCount() { return cells.size }, get strokeCount() { return appliedStrokes.length },
  }
  replayStrokes(strokes, biomeStrokeReplay(api))
  return api
}

export function loadBiomeOverride(json) {
  return createBiomeOverride(json && json.strokes)
}

// --- hot swap -----------------------------------------------------------------------------
// An edit to this file used to be classified RELOAD: findBoundaries walked from here to the app
// root and found no acceptor, so a save cost a whole page load. No boundary ABOVE this file can
// fix that, because a re-import is a new module instance and every importer keeps reading the
// one it imported at boot. What can is this file itself: an ESM import is a LIVE binding to this
// instance's export bindings, so re-assigning them here is visible to every importer already
// holding them. Self-accepting therefore turns the cost of a save into one module fetch.
// This re-points code only. It does not rebuild state the page already built, and every export
// below is re-assigned, so nothing an importer holds is left pointing at the previous copy.
const _hotSwapBiomeOverride = (next) => {
  createBiomeOverride = next.createBiomeOverride
  loadBiomeOverride = next.loadBiomeOverride
  CELL_M = next.CELL_M
  PAINT_REQUIRES = next.PAINT_REQUIRES
  BIOME_PRESETS = next.BIOME_PRESETS
  BIOME_NAMES = next.BIOME_NAMES
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapBiomeOverride)
