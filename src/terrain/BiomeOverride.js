// Sparse per-cell BIOME/CLIMATE override layer for in-editor terrain "paint biome" brush -- same
// CELL_M-quantized-grid shape as HeightDelta.js (that file overrides a scalar height offset; this one
// overrides a {temp,humidity,erosion} climate tuple), wrapping src/terrain/ClimateCache.js's
// createCachedAnchorField the same additive/composed way HeightDelta wraps a base heightFn. The
// procedural climate field (packages/mapspinner/src/anchor-field.js) is NEVER mutated or called with
// altered args -- this is purely a blend applied AFTER the base sample, so a world's (seed, params)
// stays shareable/reproducible and the painted look travels alongside the world def as its own layer.
//
// Consumed by src/terrain/VegPlacement.js / RockPlacement.js / GrassPlacement.js's classify() via
// anchorField.climateAtLocal(x,z) -- the same seam HeightDelta's wrapHeightFn hooks into for heightFn,
// so a painted cell changes species/density mid-placement-query with zero change to any of those three
// placement files.
//
// seaBias is intentionally left untouched by every preset/blend here: painting a biome should never
// move the procedural coastline (a "desert" stroke over shallow water would otherwise flip a
// SEA_REJECT gate and place vegetation underwater) -- only temp/humidity/erosion (the fields that
// actually drive species/density selection) are overridable.

export const CELL_M = 8 // matches ClimateCache.SECTOR_M: painting at sector granularity means a stroke's effect is visible at the same resolution placement already samples climate at, no wasted precision.

function cellKey(cx, cz) {
  // packed integer key, same +-4M-cell-per-axis scheme as HeightDelta.js's cellKey.
  const BIG = 1 << 23, OFF = BIG >> 1
  return (cx + OFF) * BIG + (cz + OFF)
}

// Named biome presets: each is a {temp,humidity,erosion} target tuple in the same [0,1]-ish range the
// procedural field emits (see packages/mapspinner/src/anchor-field.js), picked to land solidly inside
// VegPlacement.js's speciesFor()/ARIDITY_LINE bands so a painted stroke visibly changes species/density,
// not just nudges it.
export const BIOME_PRESETS = Object.freeze({
  desert: Object.freeze({ temp: 0.85, humidity: 0.10, erosion: 0.55 }), // below ARIDITY_LINE (0.28) -> bush-only, sparse
  tundra: Object.freeze({ temp: 0.10, humidity: 0.45, erosion: 0.35 }), // t<0.30 -> pine-dominant, cold
  forest: Object.freeze({ temp: 0.55, humidity: 0.75, erosion: 0.25 }), // warm+wet -> oak-dominant, dense
  grassland: Object.freeze({ temp: 0.55, humidity: 0.40, erosion: 0.30 }), // mid-humidity, sparser tree cover, grass-heavy
  wetland: Object.freeze({ temp: 0.60, humidity: 0.95, erosion: 0.15 }), // near-max humidity -> densest growth
})
export const BIOME_NAMES = Object.freeze(Object.keys(BIOME_PRESETS))

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v }

// Creates an empty biome-override store. `strokes` (optional) seeds it from a previously-serialized
// toJSON() payload (world-persistence round-trip), replayed in stroke order like HeightDelta.
export function createBiomeOverride(strokes) {
  const cells = new Map() // cellKey -> {temp,humidity,erosion} override tuple at that cell's center
  const appliedStrokes = []

  function cellCenter(cx, cz) { return [cx * CELL_M + CELL_M * 0.5, cz * CELL_M + CELL_M * 0.5] }

  // Stamp a biome paint centered at local (x,z), radius metres, blending each touched cell's stored
  // override toward `target` ({temp,humidity,erosion}) by `strength` (0..1) times the same cosine
  // falloff every other brush in this repo uses -- feathers into the surrounding unpainted/differently-
  // painted terrain rather than a hard-edged disc. Accumulates additively via blend-toward-target (not
  // overwrite), matching HeightDelta's repeated-strokes-build-up discipline: a cell already painted
  // partway toward desert that gets a second desert stroke converges further toward desert, not reset.
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
        const falloff = 0.5 * (1 + Math.cos((d / radius) * Math.PI)) // 1 at center, 0 at edge -- same profile as HeightDelta's raise/lower/smooth
        const t = clampedStrength * falloff
        if (t <= 0) continue
        const key = cellKey(cx, cz)
        // blend-weight is stored alongside the tuple so a later stroke's blend-toward-target composes
        // correctly against an already-partially-painted cell (weighted average, not a naive re-blend
        // against raw 0 which would bias every repeated stroke back toward the un-painted procedural value).
        const prev = cells.get(key)
        if (!prev) {
          cells.set(key, { temp: tgt.temp, humidity: tgt.humidity, erosion: tgt.erosion, w: t })
        } else {
          const neww = Math.min(1, prev.w + t * (1 - prev.w)) // repeated full-strength strokes converge to w=1, never exceed it
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

  // Raw (unblended-with-neighbours) cell read -- biome painting is a per-sector-cell override, no
  // bilinear interpolation (unlike HeightDelta's deltaAt): climateAtLocal already samples at
  // sector-center granularity, so this cell IS the query answer, matching ClimateCache's own
  // integer-sector-floor lookup semantics exactly (no interpolation seam to introduce).
  function overrideAt(x, z) {
    if (cells.size === 0) return null
    const cx = Math.floor(x / CELL_M), cz = Math.floor(z / CELL_M)
    return cells.get(cellKey(cx, cz)) || null
  }

  // Wraps a base anchorField-shaped object (must expose climateAtLocal(x,z)) with this override layer.
  // The base's own climateAtLocal is called unmodified with the same (x,z) it would always receive --
  // purely additive composition (blend the RESULT, w toward the painted target), never a mutation of the
  // base field or its inputs, so the procedural climate stays byte-identical/provable, same discipline
  // as HeightDelta.wrapHeightFn.
  function wrapClimateField(baseField) {
    if (!baseField || typeof baseField.climateAtLocal !== 'function') return baseField
    return {
      ...baseField,
      climateAtLocal(x, z) {
        const base = baseField.climateAtLocal(x, z)
        const ov = overrideAt(x, z)
        if (!ov) return base
        if (!base) return { temp: ov.temp, humidity: ov.humidity, erosion: ov.erosion, seaBias: 0 }
        // blend base -> painted tuple by the accumulated weight w (never exceeds 1); seaBias passes through untouched (see file header).
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

// Rebuild a BiomeOverride from a previously-serialized toJSON() payload by replaying its strokes in
// order, exact regardless of CELL_M ever changing between the versions that wrote/read it -- same
// discipline as HeightDelta.js's loadHeightDelta.
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
