const OCTAVES = 8
const BASE_AMP_M = 0.6
const PHASE_STEP = 0.31
const AMP_GAIN = 0.45
const CHOPPY_TO_ONE = 0.3
const GRID = 256
const GRID_STEP = 3.7013
const MEAN_CACHE_LIMIT = 16

const meanByChoppy = new Map()

function hash(x, y) {
  const qx = Math.imul(x | 0, 1597334673) >>> 0
  const qy = Math.imul(y | 0, -482951495) >>> 0
  return Math.imul((qx ^ qy) >>> 0, 1597334673) >>> 0
}

function noise(px, py) {
  const ix = Math.floor(px), iy = Math.floor(py)
  let fx = px - ix, fy = py - iy
  fx = fx * fx * (3 - 2 * fx)
  fy = fy * fy * (3 - 2 * fy)
  const h00 = hash(ix, iy), h10 = hash(ix + 1, iy), h01 = hash(ix, iy + 1), h11 = hash(ix + 1, iy + 1)
  const bottom = h00 + (h10 - h00) * fx
  const top = h01 + (h11 - h01) * fx
  return (bottom + (top - bottom) * fy) / 4294967296
}

function octave(ux, uy, choppy) {
  const n = noise(ux, uy)
  ux += n; uy += n
  let wx = 1 - Math.abs(Math.sin(ux)), wy = 1 - Math.abs(Math.sin(uy))
  const sx = Math.abs(Math.cos(ux)), sy = Math.abs(Math.cos(uy))
  wx += (sx - wx) * wx
  wy += (sy - wy) * wy
  return Math.pow(1 - Math.pow(wx * wy, 0.65), choppy)
}

function octaveMean(choppy, phase) {
  let sum = 0
  for (let iy = 0; iy < GRID; iy++) {
    for (let ix = 0; ix < GRID; ix++) sum += octave(ix * GRID_STEP + phase, iy * GRID_STEP + phase, choppy)
  }
  return sum / (GRID * GRID)
}

export function seaHeightMean(oceanChoppy, oceanAmp) {
  let unitAmpMean = meanByChoppy.get(oceanChoppy)
  if (unitAmpMean === undefined) {
    unitAmpMean = 0
    let amp = BASE_AMP_M, choppy = oceanChoppy
    for (let i = 0; i < OCTAVES; i++) {
      unitAmpMean += amp * octaveMean(choppy, PHASE_STEP * i)
      amp *= AMP_GAIN
      choppy += (1 - choppy) * CHOPPY_TO_ONE
    }
    if (meanByChoppy.size >= MEAN_CACHE_LIMIT) meanByChoppy.clear()
    meanByChoppy.set(oceanChoppy, unitAmpMean)
  }
  return unitAmpMean * oceanAmp
}
