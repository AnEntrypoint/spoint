// procedural-content-noise-terrain-generator-module: standalone, renderer/editor-independent
// noise-based HEIGHTFIELD generator -- the noise-terrain third of the WFC.js/LSystem.js PCG-suite
// epic (procedural-content-generation-suite-wfc-l-systems-noise-terrain), split off after the WFC
// slice shipped. Same scope shape as its siblings: one real algorithm module, seeded, zero
// rendering/editor coupling, verified via direct Node execution.
//
// SCOPE DECISION (made explicit per this row's own instruction, before writing any code): this
// project ALREADY has a full LIVE production terrain pipeline in packages/mapspinner (GLSL
// fractalTerrainH, anchor-field HPF baking, cube-sphere quadtree LOD, GPU-patch collider, FXC
// runtime-loop-bound workarounds -- see packages/mapspinner/AGENTS.md) plus a CPU-parity mirror in
// packages/mapspinner/src/height-cpu.js that composes THAT exact pipeline for a headless physics
// collider. Both are deeply coupled to planet-scale concerns this module must NOT depend on or
// duplicate: cube-sphere face/UV mapping, the anchor-field continental-bias HPF texture bake,
// sector-bounded quantization, FXC-safe runtime-bounded octave loops, and the whole GPU-shader/CPU
// parity contract (gen-height.mjs transpilation, pl-parity-test). Importing height-cpu.js here would
// silently couple a "generate a small custom heightfield patch for hand-placing a feature" authoring
// tool to live-planet internals (it needs a `radius`, an anchor-field bake, and produces a *signed
// planetary elevation*, not a bounded 0..1 patch height) -- the wrong shape for this row's stated use
// case (editor-toolbar "generate a heightfield from these noise params" preview, a procedural
// island/dungeon-floor patch, hand-placed custom terrain feature). So: THIS module writes its own
// small, STANDARD, well-known 2D value/simplex-style fractal Brownian motion (fBm) noise from
// scratch, deliberately not reaching for mapspinner's ~2000-line carve/anchor-field/HPF stack --
// the reuse-vs-duplicate line is drawn at "standard textbook fBm primitive" (fine to reimplement
// small and cleanly, same as WFC.js's own from-scratch WFC solver and LSystem.js's own from-scratch
// turtle interpreter) vs "mapspinner's planet-shape-specific machinery" (must not touch/duplicate).
//
// ALGORITHM (real, not a stub): a seeded 2D gradient (Perlin-style) noise lattice, hashed via a
// deterministic seeded permutation table (Ken Perlin's classic 256-entry shuffle-and-double
// approach, standard and well-known -- not proprietary to this project or to mapspinner), sampled
// through a quintic-smoothstep-interpolated gradient-dot lattice (the standard Perlin `fade`
// curve, C2-continuous so no visible lattice-boundary derivative discontinuity), composed into
// fractal Brownian motion (fbm2D: sum of `octaves` layers at doubling frequency / halving
// amplitude -- the standard fBm construction) to produce a heightfield.
//
// OUTPUT CONTRACT (clean, decoupled, per this row's own guidance): generateHeightfield returns a
// plain { heights: Float32Array(width*height), width, height, spacing, min, max } -- world-unit
// spacing between adjacent samples, heights already scaled to the caller's requested amplitude/
// range, zero notion of a planet radius, face, or sea level. A caller (e.g. the future editor-
// toolbar integration row) can turn that into a plane mesh, a collider heightfield, or a placed-
// model displacement map however it likes -- this module does not know or care.

// Seeded PRNG -- SAME mulberry32 (with the same live-measured 2-draw warm-up discard) as WFC.js/
// LSystem.js use, kept as an independent copy per module (not imported cross-module) matching this
// repo's own PCG-suite convention of each generator module being fully standalone/dependency-free.
function mulberry32(seed) {
  let a = seed >>> 0
  function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  rng(); rng() // warm-up discard -- see WFC.js's own header comment for the measured justification
  return rng
}

// Classic Perlin gradient set for 2D: 8 unit-ish directions is the standard minimal set (avoids the
// axis/diagonal bias a naive random-angle-per-hash table can introduce at low table resolution).
const GRAD2 = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
]

// Builds a seeded 512-entry permutation table (256 values, doubled to avoid wrap-around index
// checks in the sampler) via a Fisher-Yates shuffle driven by the seeded RNG -- deterministic per
// seed, standard technique (mirrors Perlin's own reference implementation's `p[256+i] = p[i] = perm[i]`
// doubling, substituting a seeded shuffle for Perlin's original fixed table so this module is
// actually seed-parameterized, not just seed-labeled).
function buildPermutationTable(seed) {
  const rng = mulberry32(seed)
  const perm = new Uint8Array(256)
  for (let i = 0; i < 256; i++) perm[i] = i
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = perm[i]; perm[i] = perm[j]; perm[j] = tmp
  }
  const doubled = new Uint8Array(512)
  for (let i = 0; i < 512; i++) doubled[i] = perm[i & 255]
  return doubled
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10) // Perlin's quintic smoothstep (C2-continuous)
const lerp = (a, b, t) => a + t * (b - a)

// Creates a seeded 2D noise sampler: sample2D(x, y) -> value in [-1, 1] (standard Perlin-noise
// range, NOT normalized to [0,1] -- fbm2D below handles that for the caller-facing heightfield).
export function createNoise2D(seed = 1337) {
  const perm = buildPermutationTable(seed)
  const gradIndex = (ix, iy) => perm[(perm[ix & 255] + iy) & 255] & 7 // & 7 -> one of the 8 GRAD2 entries

  return function sample2D(x, y) {
    const x0 = Math.floor(x), y0 = Math.floor(y)
    const xf = x - x0, yf = y - y0
    const u = fade(xf), v = fade(yf)

    const dot = (ix, iy, dx, dy) => {
      const g = GRAD2[gradIndex(ix, iy)]
      return g[0] * dx + g[1] * dy
    }
    const n00 = dot(x0, y0, xf, yf)
    const n10 = dot(x0 + 1, y0, xf - 1, yf)
    const n01 = dot(x0, y0 + 1, xf, yf - 1)
    const n11 = dot(x0 + 1, y0 + 1, xf - 1, yf - 1)

    const nx0 = lerp(n00, n10, u)
    const nx1 = lerp(n01, n11, u)
    // The 8-gradient set's max |dot| is sqrt(2); scale so the practical output range is close to
    // [-1, 1] (matches conventional Perlin-noise-library normalization, not load-bearing for
    // correctness -- fbm2D's own min/max tracking normalizes the FINAL heightfield regardless).
    return lerp(nx0, nx1, v) * Math.SQRT2
  }
}

// Fractal Brownian motion: sums `octaves` layers of the seeded 2D noise at doubling frequency
// (lacunarity, default 2.0 -- standard) and halving amplitude (persistence, default 0.5 -- standard),
// the textbook fBm construction used for natural-looking terrain-like noise. Returns a raw
// (unnormalized-range) value; generateHeightfield below normalizes the whole sampled field.
export function createFbm2D(seed = 1337, opts = {}) {
  const octaves = Math.max(1, opts.octaves ?? 5)
  const lacunarity = opts.lacunarity ?? 2.0
  const persistence = opts.persistence ?? 0.5
  const noise2D = createNoise2D(seed)
  return function fbm2D(x, y) {
    let amplitude = 1, frequency = 1, sum = 0, maxAmp = 0
    for (let o = 0; o < octaves; o++) {
      sum += noise2D(x * frequency, y * frequency) * amplitude
      maxAmp += amplitude
      amplitude *= persistence
      frequency *= lacunarity
    }
    return maxAmp > 0 ? sum / maxAmp : 0 // normalize by the max-possible-amplitude sum -> stays near [-1,1]
  }
}

/**
 * Generates a standalone noise-based heightfield patch.
 *
 * @param {Object} opts
 * @param {number} [opts.width=64] - Grid width in samples.
 * @param {number} [opts.height=64] - Grid height in samples.
 * @param {number} [opts.spacing=1] - World-unit distance between adjacent samples (a pure metadata
 *   field the caller uses to place/scale the returned grid -- this module does no world-space math).
 * @param {number} [opts.seed=1337] - Full-reproducibility seed (default a fixed constant, not
 *   Date.now(), matching WFC.js's own "never Math.random for anything that must reproduce" default
 *   discipline).
 * @param {number} [opts.octaves=5] - fBm layer count.
 * @param {number} [opts.lacunarity=2.0] - Per-octave frequency multiplier.
 * @param {number} [opts.persistence=0.5] - Per-octave amplitude multiplier.
 * @param {number} [opts.frequency=0.05] - Base sample-space frequency (how many noise-lattice units
 *   one grid step covers -- smaller = broader/smoother features, larger = more, tighter hills).
 * @param {number} [opts.amplitude=10] - Output height range half-width in world units: the returned
 *   heights are rescaled to span [-amplitude, amplitude] (see opts.normalize) before ridge/island
 *   shaping is applied.
 * @param {boolean} [opts.normalize=true] - When true (default), the raw per-octave-normalized fBm
 *   output (already close to but not exactly [-1,1], since finitely many octaves rarely hit the
 *   theoretical extremum) is additionally MIN/MAX-rescaled across the actual sampled grid so the
 *   returned heightfield provably spans the full requested amplitude range -- important for a small
 *   preview patch, where a flat/low-variance corner of the noise field would otherwise under-use the
 *   requested range. When false, heights are only multiplied by amplitude (fast, but may not use the
 *   full range) -- useful when composing multiple patches that must stay in a shared absolute scale.
 * @param {'none'|'ridge'|'island'} [opts.shape='none'] - Optional standard terrain-shaping transform
 *   applied to the raw fBm value BEFORE amplitude scaling: 'ridge' takes 1-|n| (the standard "ridged
 *   multifractal" trick, producing sharp ridgelines instead of smooth hills/valleys); 'island' applies
 *   a radial falloff mask (1 at center, 0 at the patch edge) so the patch naturally forms an
 *   isolated landmass/mound suitable for hand-placing, rather than tiling-continuous noise.
 * @returns {{heights: Float32Array, width: number, height: number, spacing: number, seed: number,
 *   min: number, max: number}} heights is row-major (index = y*width+x), in world-unit elevation.
 */
export function generateHeightfield(opts = {}) {
  const width = opts.width ?? 64
  const height = opts.height ?? 64
  if (!Number.isInteger(width) || width <= 0) throw new Error('NoiseTerrain: width must be a positive integer')
  if (!Number.isInteger(height) || height <= 0) throw new Error('NoiseTerrain: height must be a positive integer')

  const spacing = opts.spacing ?? 1
  const seed = opts.seed ?? 1337
  const frequency = opts.frequency ?? 0.05
  const amplitude = opts.amplitude ?? 10
  const normalize = opts.normalize ?? true
  const shape = opts.shape ?? 'none'
  if (shape !== 'none' && shape !== 'ridge' && shape !== 'island') {
    throw new Error(`NoiseTerrain: unknown shape "${shape}" (expected 'none'|'ridge'|'island')`)
  }

  const fbm2D = createFbm2D(seed, {
    octaves: opts.octaves ?? 5,
    lacunarity: opts.lacunarity ?? 2.0,
    persistence: opts.persistence ?? 0.5,
  })

  const n = width * height
  const raw = new Float64Array(n) // full precision during shaping/normalization; downcast to Float32 at the end
  const cx = (width - 1) / 2, cy = (height - 1) / 2
  const maxRadius = Math.max(cx, cy) || 1

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = fbm2D(x * frequency, y * frequency)
      if (shape === 'ridge') v = 1 - Math.abs(v) // ridged multifractal transform (standard technique)
      if (shape === 'island') {
        const dx = (x - cx) / maxRadius, dy = (y - cy) / maxRadius
        const r = Math.sqrt(dx * dx + dy * dy)
        const falloff = Math.max(0, 1 - r * r) // smooth radial falloff, 1 at center -> 0 at/past the edge
        v = v * falloff
      }
      raw[y * width + x] = v
    }
  }

  let outMin = Infinity, outMax = -Infinity
  const heights = new Float32Array(n)
  if (normalize) {
    let rawMin = Infinity, rawMax = -Infinity
    for (let i = 0; i < n; i++) { if (raw[i] < rawMin) rawMin = raw[i]; if (raw[i] > rawMax) rawMax = raw[i] }
    const range = rawMax - rawMin
    for (let i = 0; i < n; i++) {
      // rescale raw[i] from [rawMin,rawMax] to [-amplitude, amplitude]; a perfectly flat sampled
      // field (range===0, degenerate but possible with e.g. octaves producing an exact-zero patch)
      // maps everything to 0 rather than dividing by zero.
      const t = range > 0 ? (raw[i] - rawMin) / range : 0.5
      const h = (t * 2 - 1) * amplitude
      heights[i] = h
      if (h < outMin) outMin = h
      if (h > outMax) outMax = h
    }
  } else {
    for (let i = 0; i < n; i++) {
      const h = raw[i] * amplitude
      heights[i] = h
      if (h < outMin) outMin = h
      if (h > outMax) outMax = h
    }
  }
  if (outMin === Infinity) { outMin = 0; outMax = 0 } // n===0 is unreachable (width/height guarded >0), kept defensive

  return { heights, width, height, spacing, seed, min: outMin, max: outMax }
}

// Convenience: samples heightAt(worldX, worldY) using the SAME fbm2D construction generateHeightfield
// uses internally, for a caller that wants a continuous (non-grid-snapped) query -- e.g. an editor
// "hover to preview height" tool, or placing one prop at an arbitrary point without generating a
// whole grid. Mirrors generateHeightfield's shape/amplitude/normalize=false semantics (a single-point
// query has no "grid" to min/max-normalize against, so normalize is not offered here -- amplitude-only
// scaling, matching generateHeightfield's normalize:false path exactly for parity).
export function createHeightSampler(opts = {}) {
  const seed = opts.seed ?? 1337
  const frequency = opts.frequency ?? 0.05
  const amplitude = opts.amplitude ?? 10
  const shape = opts.shape ?? 'none'
  if (shape !== 'none' && shape !== 'ridge') {
    // 'island' needs a patch-relative center/radius this point-sampler has no notion of; only
    // 'none'/'ridge' (both pure functions of world position alone) are supported here.
    throw new Error(`NoiseTerrain: createHeightSampler only supports shape 'none'|'ridge' (got "${shape}")`)
  }
  const fbm2D = createFbm2D(seed, {
    octaves: opts.octaves ?? 5,
    lacunarity: opts.lacunarity ?? 2.0,
    persistence: opts.persistence ?? 0.5,
  })
  return function heightAt(worldX, worldY) {
    let v = fbm2D(worldX * frequency, worldY * frequency)
    if (shape === 'ridge') v = 1 - Math.abs(v)
    return v * amplitude
  }
}

// Renders a heightfield to a plain ASCII-art string (min->max mapped across a caller-supplied glyph
// ramp, e.g. ' .:-=+*#%@' from low to high) -- a convenience for logging/debugging/CLI use, same
// purpose as WFC.js's gridToString/LSystem.js's turtle-segment dump, not required by the generator.
export function heightfieldToString(result, ramp = ' .:-=+*#%@') {
  const { heights, width, height, min, max } = result
  const range = max - min
  const lines = []
  for (let y = 0; y < height; y++) {
    let line = ''
    for (let x = 0; x < width; x++) {
      const t = range > 0 ? (heights[y * width + x] - min) / range : 0
      const gi = Math.min(ramp.length - 1, Math.max(0, Math.floor(t * ramp.length)))
      line += ramp[gi]
    }
    lines.push(line)
  }
  return lines.join('\n')
}
