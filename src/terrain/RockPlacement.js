import {
  hash3, rand, ARIDITY_LINE, VEG, reliefMarginScaleOf, seaNoise, createPlacementCell, placementCellAt, surfaceOfCell,
} from './VegPlacement.js'
import { latticeFor, tangentFrame, tangentFrameQuat, tangentToLocal, quatMulF32, radialSlopeAt, climateAt } from './PlacementChart.js'
import { paintedWeightsFor, paintedSlopeOf } from './PaintedWeights.js'

export const ROCK = Object.freeze({
  CHUNK: 32,
  CELL: 8,
  GRID: 4,
  JITTER: 3.2,
  SLOPE_D: 1.5,
  WATER_MARGIN: 0.3,
  SEA_REJECT: -2,
  TYPES: 6,
  FLOOR: 0.025,
  SCALE_MIN: 2.0,
  SCALE_SPAN: 8.0,
  SQUASH_MIN: 0.55,
  SQUASH_SPAN: 0.55,
})

export const ROCK_SCALE_LEVELS = 10
export const ROCK_SQUASH_LEVELS = 3

function logStepOf(lo, hi, n) {
  return Math.log(hi / lo) / n
}

function logTableOf(lo, step, n) {
  const t = new Float32Array(n)
  for (let i = 0; i < n; i++) t[i] = lo * Math.exp((i + 0.5) * step)
  return t
}

function logLevelOf(value, lo, step, n) {
  const i = Math.round(Math.log((value > lo ? value : lo) / lo) / step - 0.5)
  return i < 0 ? 0 : i > n - 1 ? n - 1 : i
}

const SCALE_STEP = logStepOf(ROCK.SCALE_MIN, ROCK.SCALE_MIN + ROCK.SCALE_SPAN, ROCK_SCALE_LEVELS)
const SQUASH_STEP = logStepOf(ROCK.SQUASH_MIN, ROCK.SQUASH_MIN + ROCK.SQUASH_SPAN, ROCK_SQUASH_LEVELS)

export const ROCK_SCALE_TABLE = logTableOf(ROCK.SCALE_MIN, SCALE_STEP, ROCK_SCALE_LEVELS)
export const ROCK_SQUASH_TABLE = logTableOf(ROCK.SQUASH_MIN, SQUASH_STEP, ROCK_SQUASH_LEVELS)

export function rockScaleLevel(scale) {
  return logLevelOf(scale, ROCK.SCALE_MIN, SCALE_STEP, ROCK_SCALE_LEVELS)
}

export function rockSquashLevel(squash) {
  return logLevelOf(squash, ROCK.SQUASH_MIN, SQUASH_STEP, ROCK_SQUASH_LEVELS)
}

const K_COIN = 10, K_TYPE = 11, K_SCALE = 12, K_YAW = 13, K_TILTX = 14, K_TILTZ = 15, K_SQUASH = 16, K_VAR = 17

export function rockDensity(erosion, slopeRatio, humidity, elevNorm) {
  const ero = Math.max(0, Math.min(1, erosion))
  const slope = Math.max(0, Math.min(1, slopeRatio))
  const hum = Math.max(0, Math.min(1, humidity))
  const arid = hum < ARIDITY_LINE ? 1 + (1 - hum / ARIDITY_LINE) : 1.0
  const band = 0.6 + 0.4 * Math.max(0, Math.min(1, elevNorm))
  const d = (0.15 + 0.85 * ero) * (0.4 + 1.6 * slope * slope) * arid * band
  return Math.max(ROCK.FLOOR, Math.min(1, d))
}

function normalQuat(nx, ny, nz, out) {
  let dot = ny
  if (dot > 1) dot = 1; else if (dot < -1) dot = -1
  const ang = Math.acos(dot)
  let ax = nz, az = -nx
  const al = Math.hypot(ax, az)
  if (al < 1e-6) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1; return out }
  ax /= al; az /= al
  const s = Math.sin(ang / 2)
  out[0] = Math.fround(ax * s); out[1] = 0; out[2] = Math.fround(az * s); out[3] = Math.fround(Math.cos(ang / 2))
  return out
}

const PATCH = 112
const CLUSTER_SCALE = 224
const MAX_CLUSTER_STRENGTH = 0.6

const _rockClimate = { erosion: 0.3, humidity: 0.5, temp: 0.5 }

function readClimate(clim, out) {
  const erosion = clim && Number.isFinite(clim.erosion) ? clim.erosion : 0.3
  const humidity = clim && Number.isFinite(clim.humidity) ? clim.humidity : 0.5
  if (clim && Number.isFinite(clim.seaBias) && clim.seaBias < ROCK.SEA_REJECT) return false
  if (clim && clim.blocked) return false
  out.erosion = erosion
  out.humidity = humidity
  out.temp = clim && Number.isFinite(clim.temp) ? clim.temp : 0.5
  return true
}

export function classify(frame, anchorField, cell) {
  const climateBeforeSolve = anchorField.climateUsesLocalXZ !== true
  let climateRead = false
  if (climateBeforeSolve) {
    if (!readClimate(climateAt(anchorField, cell.xz[0], cell.xz[1], cell.dir), _rockClimate)) return null
    climateRead = true
  }

  const cellHash = hash3(0x70c | 0, cell.row, cell.j)
  const patch = 0.25 + 1.5 * seaNoise(0x70c1, cell.sea, PATCH)
  const cluster = seaNoise(0x70c2, cell.sea, CLUSTER_SCALE)
  const coin = rand(cellHash, K_COIN)
  const clusterBoostUpperBoundOverAllSlopes = 1 + MAX_CLUSTER_STRENGTH * Math.max(0, cluster - 0.5)
  if (climateRead) {
    const ceilingOverAllElevations = Math.max(ROCK.FLOOR, Math.min(1, rockDensity(_rockClimate.erosion, 1, _rockClimate.humidity, 1) * patch * clusterBoostUpperBoundOverAllSlopes)) * cell.area
    if (coin >= ceilingOverAllElevations) return null
  }

  const rho = surfaceOfCell(frame, cell)
  if (!Number.isFinite(rho)) return null
  const x = cell.at[0], groundY = cell.at[1], z = cell.at[2]
  const elev = rho - frame.radius
  if (!(elev > ROCK.WATER_MARGIN * reliefMarginScaleOf(frame))) return null
  if (!climateRead && !readClimate(climateAt(anchorField, x, z, cell.dir), _rockClimate)) return null
  const erosion = _rockClimate.erosion, humidity = _rockClimate.humidity

  const elevNorm = Math.max(0, Math.min(1, elev / VEG.TREELINE))
  const ceiling = Math.max(ROCK.FLOOR, Math.min(1, rockDensity(erosion, 1, humidity, elevNorm) * patch * clusterBoostUpperBoundOverAllSlopes)) * cell.area
  if (coin >= ceiling) return null

  const tf = tangentFrame(frame, cell.dir[0], cell.dir[1], cell.dir[2])
  const slope = radialSlopeAt(frame, tf, rho, ROCK.SLOPE_D)
  if (!slope) return null
  const dHdx = slope[0], dHdz = slope[1]
  const grad = Math.hypot(dHdx, dHdz)
  const slopeRatio = grad / (grad + 1)
  const temp = _rockClimate.temp
  const paintedRock = paintedWeightsFor(frame.hashVersion)(cell.dir, elev, paintedSlopeOf(dHdx, dHdz), temp, humidity).rock

  let nx = -dHdx, ny = 1, nz = -dHdz
  const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl

  const clusterStrength = MAX_CLUSTER_STRENGTH * (1 - slopeRatio)
  const accept = Math.max(ROCK.FLOOR, Math.min(1, rockDensity(erosion, slopeRatio, humidity, elevNorm) * patch * (1 + clusterStrength * (cluster - 0.5)))) * cell.area * paintedRock
  if (coin >= accept) return null

  const type = Math.floor(rand(cellHash, K_TYPE) * ROCK.TYPES) % ROCK.TYPES
  const sc = rand(cellHash, K_SCALE)
  const scBiased = Math.max(0, Math.min(1, sc + (cluster - 0.5) * 0.6))
  const scale = ROCK_SCALE_TABLE[rockScaleLevel(ROCK.SCALE_MIN + scBiased * scBiased * scBiased * ROCK.SCALE_SPAN)]
  const yaw = Math.fround(rand(cellHash, K_YAW) * Math.PI * 2)
  const wob = (rand(cellHash, K_TILTX) - 0.5) * 0.12, wobZ = (rand(cellHash, K_TILTZ) - 0.5) * 0.12
  const squash = ROCK_SQUASH_TABLE[rockSquashLevel(ROCK.SQUASH_MIN + rand(cellHash, K_SQUASH) * ROCK.SQUASH_SPAN)]
  const variant = Math.fround(rand(cellHash, K_VAR))
  let bnx = nx + wob, bny = ny, bnz = nz + wobZ
  const bl = Math.hypot(bnx, bny, bnz); bnx /= bl; bny /= bl; bnz /= bl
  const tq = quatMulF32(tangentFrameQuat(tf), normalQuat(bnx, bny, bnz, [0, 0, 0, 1]))
  const normalL = tangentToLocal(tf, nx, ny, nz)

  return {
    x: Math.fround(x), y: Math.fround(groundY), z: Math.fround(z),
    type, scale, yaw, squash, variant,
    normal: [Math.fround(normalL[0]), Math.fround(normalL[1]), Math.fround(normalL[2])], tiltQuat: tq,
    rockId: cell.id,
  }
}

export function placementsForRockChunk(key, frame, anchorField, worldSeed) {
  const out = []
  const lattice = latticeFor(frame, ROCK)
  const dec = lattice.decodeChunk(key, [0, 0, 0])
  const seed = (worldSeed | 0) ^ 0x70c5
  const cell = createPlacementCell(frame)
  for (let gz = 0; gz < ROCK.GRID; gz++) {
    for (let gx = 0; gx < ROCK.GRID; gx++) {
      placementCellAt(frame, lattice, dec, gx, gz, seed, ROCK.JITTER / ROCK.CELL, 0, 1, cell)
      const p = classify(frame, anchorField, cell)
      if (p) out.push(p)
    }
  }
  return out
}
