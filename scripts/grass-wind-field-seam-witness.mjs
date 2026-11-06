import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const field = await import(pathToFileURL(resolve(ROOT, 'client', 'core', 'GrassWindField.js')).href)
const { DataUtils } = await import('three')

const WARM_FRAMES = 120
const FRAMES = 600
const DT = 1 / 60
const SPEED = 0.25
const AMP = 0.25
const DIR = [0.8, 0.6]
const REACH = 77.6
const PROBE_X = 7.3
const PROBE_Z = -4.1
const MAX_JERK_RATIO = 20

const dirLen = Math.hypot(DIR[0], DIR[1])
const dx = DIR[0] / dirLen
const dz = DIR[1] / dirLen

const lattice = field.createGrassWindField()
const gust = [0, 0, 0]

function latticeSample() {
  const j = Math.floor((PROBE_X - lattice.state.originX) / lattice.cellM)
  const i = Math.floor((PROBE_Z - lattice.state.originZ) / lattice.cellM)
  const o = (i * lattice.cells + j) * 4
  return [DataUtils.fromHalfFloat(lattice.texture.image.data[o]), DataUtils.fromHalfFloat(lattice.texture.image.data[o + 1])]
}

function exactSample(t) {
  field.grassWindGust(gust, PROBE_X, PROBE_Z, t, dx, dz)
  const sway = (field.GRASS_SWAY_BASE + field.GRASS_SWAY_FLOW * gust[0]) * AMP
  return [dx * sway + gust[1] * field.GRASS_FLUTTER_X * AMP, dz * sway + gust[2] * field.GRASS_FLUTTER_Z * AMP]
}

const latticeSeries = []
const exactSeries = []
let t = 0
for (let f = 0; f < FRAMES; f++) {
  t += DT * SPEED
  lattice.update(t, 0, 0, AMP, dx, dz, REACH)
  if (f >= WARM_FRAMES) {
    latticeSeries.push(latticeSample())
    exactSeries.push(exactSample(t))
  }
}

function jerkRms(series, k) {
  const d2 = []
  for (let n = 2; n < series.length; n++) d2.push(series[n][k] - 2 * series[n - 1][k] + series[n - 2][k])
  return Math.sqrt(d2.reduce((s, v) => s + v * v, 0) / d2.length)
}

const latticeJerk = Math.max(jerkRms(latticeSeries, 0), jerkRms(latticeSeries, 1))
const exactJerk = Math.max(jerkRms(exactSeries, 0), jerkRms(exactSeries, 1))
const ratio = latticeJerk / exactJerk
const pass = Number.isFinite(ratio) && ratio <= MAX_JERK_RATIO

console.log(`[grass-wind-field-seam] frames=${FRAMES} warm=${WARM_FRAMES} dt=${DT.toFixed(6)} speed=${SPEED}`)
console.log(`[grass-wind-field-seam] lattice jerk rms=${latticeJerk.toExponential(3)} exact jerk rms=${exactJerk.toExponential(3)} ratio=${ratio.toFixed(2)} max=${MAX_JERK_RATIO}`)
console.log(pass ? 'RESULT: PASS grass wind field: sampled wind at a fixed point moves smoothly frame to frame' : `RESULT: FAIL grass wind field jerk ratio ${ratio.toFixed(2)} exceeds ${MAX_JERK_RATIO}`)
process.exit(pass ? 0 : 1)
