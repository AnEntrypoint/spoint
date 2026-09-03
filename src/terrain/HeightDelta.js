// Sparse heightfield DELTA-OVERRIDE layer for in-editor terrain sculpting brushes. Stored strictly
// separate from the procedural base noise (mapspinner/height-gen.js's composeHeight/fractalTerrainH,
// generated from src/shaders/terrain.glsl) so a raise/lower brush never mutates the seed-derived
// shape function itself -- a world's (seed, params) stays shareable/reproducible, and this layer is
// the only thing that needs to travel alongside the world def for the sculpted look to persist.
//
// Coordinate space: LOCAL planet-frame XZ world metres, the same space every heightFn/groundHeightLocal
// caller already uses (src/terrain/PlanetFrame.js's localToDir, src/terrain/TerrainPhysics.js's
// setupTerrainStreaming heightFn, mapspinner/patch-baker.js's createPatchHeightFn) -- no extra
// coordinate conversion needed at the wrap point.
//
// Storage: a sparse Map of quantized grid cells (CELL_M metres/cell) -> accumulated height offset at
// that cell's center. A brush stamp writes/accumulates into every cell whose center falls within the
// brush radius, with a smooth circular falloff (cosine, 1 at center -> 0 at the edge) so the raised
// area blends into the surrounding untouched terrain rather than showing a hard cylindrical step.
// wrapHeightFn(baseHeightFn) returns a NEW function that adds a bilinearly-interpolated read of this
// sparse grid on top of the base -- the base function itself is never called with different args or
// mutated, so the underlying procedural noise is provably unchanged by sculpting.

export const CELL_M = 1 // delta-grid resolution: 1 cell per metre: fine enough for a hand-placed brush edit, coarse enough to keep the sparse map small for a typical brush radius (a 10m-radius raise touches ~314 cells).

function cellKey(cx, cz) {
  // packed integer key, safe well beyond any realistic world extent (matches the PKEY_BIG pattern in
  // packages/mapspinner/src/patch-baker.js): supports +-4M cells (+-4,000,000m) per axis before collision.
  const BIG = 1 << 23, OFF = BIG >> 1
  return (cx + OFF) * BIG + (cz + OFF)
}

// Creates an empty delta-override store. `strokes` (optional) seeds it from a previously-serialized
// toJSON() payload (world-persistence round-trip) -- an array of {x,z,radius,strength} raise-brush
// stamps replayed in order, NOT the flattened cell map itself, so re-applying is exact regardless of
// CELL_M ever changing between versions.
export function createHeightDelta(strokes) {
  const cells = new Map() // cellKey -> height offset (metres) at that cell's center
  const appliedStrokes = []

  function cellCenter(cx, cz) { return [cx * CELL_M + CELL_M * 0.5, cz * CELL_M + CELL_M * 0.5] }

  // Stamp a raise (positive strength) or lower (negative strength) brush centered at local (x,z),
  // radius metres, peak offset `strength` metres at the center falling to 0 at the edge via a smooth
  // cosine falloff. Accumulates additively onto any existing delta at each touched cell (repeated
  // strokes build up, matching a real sculpting tool) rather than overwriting.
  function applyRaiseBrush(x, z, radius, strength) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius <= 0 || !Number.isFinite(strength) || strength === 0) return { touched: 0 }
    const cx0 = Math.floor((x - radius) / CELL_M), cx1 = Math.ceil((x + radius) / CELL_M)
    const cz0 = Math.floor((z - radius) / CELL_M), cz1 = Math.ceil((z + radius) / CELL_M)
    let touched = 0
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const [ccx, ccz] = cellCenter(cx, cz)
        const dx = ccx - x, dz = ccz - z
        const d = Math.hypot(dx, dz)
        if (d > radius) continue
        // cosine falloff: 1 at center, 0 at the edge, smooth first derivative (no hard rim)
        const falloff = 0.5 * (1 + Math.cos((d / radius) * Math.PI))
        const key = cellKey(cx, cz)
        const prev = cells.get(key) || 0
        cells.set(key, prev + strength * falloff)
        touched++
      }
    }
    appliedStrokes.push({ x, z, radius, strength, brush: strength >= 0 ? 'raise' : 'lower' })
    return { touched }
  }

  // Reads the RAW (unstamped-default-0) cell value at an integer cell coordinate, used by the smooth
  // brush's neighbourhood average -- deliberately bypasses deltaAt's bilinear interpolation since the
  // smoothing kernel needs the grid's own discrete samples, not an interpolated read.
  function cellRaw(cx, cz) { return cells.get(cellKey(cx, cz)) || 0 }

  // Flatten brush: pins the composed surface (base + delta) to a fixed TARGET ELEVATION everywhere
  // inside the brush radius, feathered ONLY near the outer edge so it blends into the surrounding
  // (possibly sloped) terrain rather than showing a hard flat-top disc -- unlike raise/lower/smooth's
  // whole-radius cosine falloff (which fades from the very center and only ever reaches its stated
  // peak AT d=0), flatten needs a genuine FLAT PLATEAU across the bulk of the disc so "flatten" reads
  // as actually flat, not merely peak-at-center-and-fading. FEATHER_FRACTION of the radius (outer
  // portion) ramps 1->0 via the cosine profile; the inner (1-FEATHER_FRACTION) is full strength.
  // Unlike raise/lower (which accumulate an offset) this brush must know each touched cell's BASE
  // height to compute the delta that cancels it out -- `baseHeightFn(x,z)->metres` is passed in
  // per-call (never stored) so this layer stays strictly ignorant of the procedural base function's
  // identity, matching the file-level design invariant that HeightDelta never calls the base fn with
  // altered args or caches a reference to it. `targetHeight` is the absolute elevation (metres) the
  // brush should flatten to -- callers sample it once at the brush center (base+delta, the surface the
  // user actually clicked on) before calling this, so repeated strokes at the same spot converge
  // (each cell's delta is set directly to the value that makes IT read as targetHeight when queried at
  // its own cell center, not merely nudged toward it, so a strength=1 stamp needs exactly one pass in
  // the plateau region -- see the module-level convergence note below deltaAt for why a stamp centered
  // off a cell-center still reads a hair under target at the exact brush-center query point, an
  // inherent bilinear-interpolation artifact shared with every brush here, not unique to flatten).
  // `strength` is a [0,1] blend factor mirroring the smooth brush's contract (0=no change, 1=fully
  // pinned to targetHeight in the plateau) rather than raise/lower's metres-magnitude contract, since
  // "how flat" is a blend question, not a magnitude one.
  const FLATTEN_FEATHER_FRACTION = 0.3 // outer 30% of the brush radius feathers to 0; inner 70% is a flat plateau at full strength
  function applyFlattenBrush(baseHeightFn, x, z, radius, targetHeight, strength) {
    if (typeof baseHeightFn !== 'function' || !Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius <= 0 || !Number.isFinite(targetHeight)) return { touched: 0 }
    const clampedStrength = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 1
    if (clampedStrength <= 0) return { touched: 0 }
    const plateauRadius = radius * (1 - FLATTEN_FEATHER_FRACTION)
    const featherSpan = radius - plateauRadius // always > 0 since FLATTEN_FEATHER_FRACTION in (0,1)
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
        if (!Number.isFinite(base)) continue // unsampleable cell (e.g. outside a bounded base source) -- skip rather than write a NaN delta
        const targetDelta = targetHeight - base // the delta value that makes base+delta == targetHeight exactly at this cell
        const current = cellRaw(cx, cz)
        // flat plateau (falloff=1) for d <= plateauRadius; cosine feather 1->0 across the outer band for d in (plateauRadius, radius]
        const falloff = d <= plateauRadius ? 1 : 0.5 * (1 + Math.cos(((d - plateauRadius) / featherSpan) * Math.PI))
        const t = clampedStrength * falloff
        const key = cellKey(cx, cz)
        cells.set(key, current + (targetDelta - current) * t)
        touched++
      }
    }
    if (touched > 0) appliedStrokes.push({ x, z, radius, strength: clampedStrength, targetHeight, brush: 'flatten' })
    return { touched }
  }

  // Rectangular carve: lowers the heightfield to a target depth within an axis-aligned rectangle,
  // feathered ONLY near the outer edge so it blends into the surrounding terrain. Designed for building
  // stencils (basements/bunkers) where a placed building entity's footprint should carve a hole into the
  // terrain. Like applyFlattenBrush, this needs baseHeightFn to compute the cancelling delta for each
  // cell, and uses the same plateau+feather pattern (FEATHER_FRACTION of the half-extent feathers, the
  // inner region is a flat plateau at full strength). `targetDepth` is the absolute elevation (metres)
  // the floor should sit at -- callers derive it from the building entity's floor Y in world space.
  const RECT_FEATHER_FRACTION = 0.15 // outer 15% of each half-extent feathers to 0; inner 85% is a flat plateau
  function applyRectangularCarve(baseHeightFn, x, z, halfWidth, halfDepth, targetDepth, strength) {
    if (typeof baseHeightFn !== 'function' || !Number.isFinite(x) || !Number.isFinite(z)) return { touched: 0 }
    if (!Number.isFinite(halfWidth) || halfWidth <= 0 || !Number.isFinite(halfDepth) || halfDepth <= 0) return { touched: 0 }
    if (!Number.isFinite(targetDepth)) return { touched: 0 }
    const clampedStrength = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 1
    if (clampedStrength <= 0) return { touched: 0 }
    const plateauHW = halfWidth * (1 - RECT_FEATHER_FRACTION)
    const plateauHD = halfDepth * (1 - RECT_FEATHER_FRACTION)
    const featherW = halfWidth - plateauHW // always > 0 since RECT_FEATHER_FRACTION in (0,1)
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
        // plateau falloff: 1 for dx<=plateauHW && dz<=plateauHD, cosine feather in each axis
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
    if (touched > 0) appliedStrokes.push({ x, z, halfWidth, halfDepth, targetDepth, strength: clampedStrength, brush: 'rectangularCarve' })
    return { touched }
  }

  // Smooth brush: blends each touched cell's delta toward its local neighbourhood's average delta
  // (a box-blur over a small fixed kernel radius in CELLS, independent of the brush's own metre radius),
  // pulled by `strength` in [0,1] (0 = no change, 1 = fully replaced by the local average) and feathered
  // by the same cosine falloff as raise/lower so the smoothing itself blends into untouched terrain at
  // the brush edge rather than leaving a hard-edged smoothed disc. Operates STRICTLY on this sparse
  // delta layer -- it never reads or touches the procedural base noise, so smoothing a never-sculpted
  // area (all neighbours 0) is a correct no-op (averaging zeros with zeros stays zero), and smoothing
  // near a sculpted stroke's edge pulls the delta gently toward its surroundings without needing to know
  // anything about the base heightFn. Two-pass (compute all new values from the CURRENT grid, then write)
  // so a stroke's own effect never contaminates its own average mid-computation (order-independent).
  const SMOOTH_KERNEL_CELLS = 2 // 5x5 box average around each touched cell, in CELL_M units
  function applySmoothBrush(x, z, radius, strength) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius <= 0 || !Number.isFinite(strength) || strength <= 0) return { touched: 0 }
    const clampedStrength = Math.min(1, strength)
    const cx0 = Math.floor((x - radius) / CELL_M), cx1 = Math.ceil((x + radius) / CELL_M)
    const cz0 = Math.floor((z - radius) / CELL_M), cz1 = Math.ceil((z + radius) / CELL_M)
    const writes = [] // [key, newValue][], applied after the full read pass
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
        if (avg === current) continue // no-op cell (e.g. untouched flat neighbourhood), skip the write
        const falloff = 0.5 * (1 + Math.cos((d / radius) * Math.PI))
        const t = clampedStrength * falloff
        writes.push([cellKey(cx, cz), current + (avg - current) * t])
        touched++
      }
    }
    for (const [key, val] of writes) cells.set(key, val)
    if (touched > 0) appliedStrokes.push({ x, z, radius, strength: clampedStrength, brush: 'smooth' })
    return { touched }
  }

  // Bilinear read of the sparse delta grid at local (x,z); cells never stamped read as 0 (no override
  // = base terrain unchanged there), so this is safe to add to ANY base heightFn result unconditionally.
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

  // Wraps a base heightFn(x,z)->metres with this delta layer. The base fn is called unmodified with
  // the same (x,z) it would always receive -- this is purely additive composition, never a mutation
  // of the base function or its inputs, so the procedural noise stays byte-identical/provable.
  function wrapHeightFn(baseHeightFn) {
    if (typeof baseHeightFn !== 'function') return baseHeightFn
    return function deltaWrappedHeightFn(x, z) {
      const base = baseHeightFn(x, z)
      if (!Number.isFinite(base)) return base
      return base + deltaAt(x, z)
    }
  }

  function toJSON() { return { version: 1, cellM: CELL_M, strokes: appliedStrokes.slice() } }

  function clear() { cells.clear(); appliedStrokes.length = 0 }

  return { applyRaiseBrush, applySmoothBrush, applyFlattenBrush, applyRectangularCarve, deltaAt, wrapHeightFn, toJSON, clear, get cellCount() { return cells.size }, get strokeCount() { return appliedStrokes.length } }
}

// Rebuild a HeightDelta from a previously-serialized toJSON() payload by replaying its strokes in
// order -- exact regardless of CELL_M ever changing between the versions that wrote/read it. `brush`
// dispatches to the matching apply* fn; legacy strokes with no `brush` field (serialized before the
// smooth brush shipped) default to 'raise' (applyRaiseBrush itself handles a negative strength as
// 'lower' internally, so untagged raise/lower strokes both replay correctly through this default).
// `baseHeightFn` (optional) is required to correctly replay 'flatten' strokes (applyFlattenBrush needs
// the base terrain sample at each touched cell to compute the cancelling delta) -- callers that have it
// in scope at load time (src/terrain/TerrainPhysics.js's setupTerrainStreaming, right after baseHeightFn
// is resolved) should pass it; a flatten stroke replayed with no baseHeightFn is skipped (not dropped
// from appliedStrokes' round-trip -- toJSON() replay just leaves that stroke's cells unflattened for
// this session) rather than throwing, so an old/degraded caller still loads the rest of the delta layer.
export function loadHeightDelta(json, baseHeightFn) {
  const hd = createHeightDelta()
  if (json && Array.isArray(json.strokes)) {
    for (const s of json.strokes) {
      if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.z) || !Number.isFinite(s.radius) || !Number.isFinite(s.strength)) continue
      if (s.brush === 'smooth') hd.applySmoothBrush(s.x, s.z, s.radius, s.strength)
      else if (s.brush === 'flatten') { if (typeof baseHeightFn === 'function' && Number.isFinite(s.targetHeight)) hd.applyFlattenBrush(baseHeightFn, s.x, s.z, s.radius, s.targetHeight, s.strength) }
      else if (s.brush === 'rectangularCarve') { if (typeof baseHeightFn === 'function' && Number.isFinite(s.targetDepth) && Number.isFinite(s.halfWidth) && Number.isFinite(s.halfDepth)) hd.applyRectangularCarve(baseHeightFn, s.x, s.z, s.halfWidth, s.halfDepth, s.targetDepth, s.strength) }
      else hd.applyRaiseBrush(s.x, s.z, s.radius, s.strength)
    }
  }
  return hd
}
