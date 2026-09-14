export const CELL_M = 8

function cellKey(cx, cz) {
  const KEY_AXIS_SPAN = 1 << 23, KEY_AXIS_OFFSET = KEY_AXIS_SPAN >> 1
  return (cx + KEY_AXIS_OFFSET) * KEY_AXIS_SPAN + (cz + KEY_AXIS_OFFSET)
}

export const BIOME_PRESETS = Object.freeze({
  desert: Object.freeze({ temp: 0.85, humidity: 0.10, erosion: 0.55 }),
  tundra: Object.freeze({ temp: 0.10, humidity: 0.45, erosion: 0.35 }),
  forest: Object.freeze({ temp: 0.55, humidity: 0.75, erosion: 0.25 }),
  grassland: Object.freeze({ temp: 0.55, humidity: 0.40, erosion: 0.30 }),
  wetland: Object.freeze({ temp: 0.60, humidity: 0.95, erosion: 0.15 }),
})
export const BIOME_NAMES = Object.freeze(Object.keys(BIOME_PRESETS))

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v }

export function createBiomeOverride(strokes) {
  const cells = new Map()
  const appliedStrokes = []

  function cellCenter(cx, cz) { return [cx * CELL_M + CELL_M * 0.5, cz * CELL_M + CELL_M * 0.5] }

  function applyPaintBrush(x, z, radius, target, strength) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius <= 0) return { touched: 0 }
    if (!target || !Number.isFinite(target.temp) || !Number.isFinite(target.humidity) || !Number.isFinite(target.erosion)) return { touched: 0 }
    const clampedStrength = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 1
    if (clampedStrength <= 0) return { touched: 0 }
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
    if (touched > 0) appliedStrokes.push({ x, z, radius, strength: clampedStrength, target: tgt })
    return { touched }
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
      climateAtLocal(x, z) {
        const base = baseField.climateAtLocal(x, z)
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

  return {
    applyPaintBrush, overrideAt, wrapClimateField, toJSON, clear,
    get cellCount() { return cells.size }, get strokeCount() { return appliedStrokes.length },
  }
}

export function loadBiomeOverride(json) {
  const bo = createBiomeOverride()
  if (json && Array.isArray(json.strokes)) {
    for (const s of json.strokes) {
      if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.z) || !Number.isFinite(s.radius) || !s.target) continue
      bo.applyPaintBrush(s.x, s.z, s.radius, s.target, s.strength)
    }
  }
  return bo
}
