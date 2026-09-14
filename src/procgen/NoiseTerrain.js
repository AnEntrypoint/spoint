function mulberry32(seed) {
  let a = seed >>> 0
  function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  rng(); rng()
  return rng
}

const GRAD2 = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
]
const GRAD2_INDEX_MASK = 7

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

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10)
const lerp = (a, b, t) => a + t * (b - a)

export function createNoise2D(seed = 1337) {
  const perm = buildPermutationTable(seed)
  const gradIndex = (ix, iy) => perm[(perm[ix & 255] + iy) & 255] & GRAD2_INDEX_MASK

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
    return lerp(nx0, nx1, v) * Math.SQRT2
  }
}

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
    return maxAmp > 0 ? sum / maxAmp : 0
  }
}

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
  const raw = new Float64Array(n)
  const cx = (width - 1) / 2, cy = (height - 1) / 2
  const maxRadius = Math.max(cx, cy) || 1

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = fbm2D(x * frequency, y * frequency)
      if (shape === 'ridge') v = 1 - Math.abs(v)
      if (shape === 'island') {
        const dx = (x - cx) / maxRadius, dy = (y - cy) / maxRadius
        const r = Math.sqrt(dx * dx + dy * dy)
        const falloff = Math.max(0, 1 - r * r)
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
  if (outMin === Infinity) { outMin = 0; outMax = 0 }

  return { heights, width, height, spacing, seed, min: outMin, max: outMax }
}

export function createHeightSampler(opts = {}) {
  const seed = opts.seed ?? 1337
  const frequency = opts.frequency ?? 0.05
  const amplitude = opts.amplitude ?? 10
  const shape = opts.shape ?? 'none'
  if (shape !== 'none' && shape !== 'ridge') {
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
