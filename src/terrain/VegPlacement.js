import {
  latticeFor, surfaceAlongDir, tangentFrame, tangentFrameQuat, quatMulF32, radialSlopeAt, climateAt, valueNoise3, seaLocalXZ,
} from './PlacementChart.js'
import { paintedWeightsFor, paintedSlopeOf } from './PaintedWeights.js'

export const VEG = Object.freeze({
  CHUNK: 32,
  CELL: 4,
  GRID: 8,
  JITTER: 1.8,
  SLOPE_D: 1.5,
  SLOPE_MAX: 0.6,
  SEA_REJECT: -2,
  TREELINE: 4000,
  TREELINE_FADE: 120,
})

export const SPECIES = Object.freeze([
  'Oak Large', 'Pine Medium', 'Aspen Medium', 'Ash Medium', 'Bush',
  'Ash Small', 'Ash Large', 'Aspen Small', 'Aspen Large', 'Bush 2',
  'Bush 3', 'Oak Small', 'Oak Medium', 'Pine Small', 'Pine Large',
])
const SP_OAK = 0, SP_PINE = 1, SP_ASPEN = 2, SP_ASH = 3, SP_BUSH = 4
const SP_ASH_S = 5, SP_ASH_L = 6, SP_ASPEN_S = 7, SP_ASPEN_L = 8, SP_BUSH2 = 9
const SP_BUSH3 = 10, SP_OAK_S = 11, SP_OAK_M = 12, SP_PINE_S = 13, SP_PINE_L = 14

const K_JITX = 0, K_JITZ = 1, K_COIN = 2, K_VARIANT = 3, K_YAW = 4, K_SCALE = 5, K_WIND = 6, K_SPECIESH = 7, K_SIZE = 8
const K_SHAPE = 9, K_TINT_HUE = 10, K_TINT_SAT = 11, K_TINT_VAL = 12, K_LEAN = 13, K_LEAN_DIR = 14, K_UNDERSTORY = 15, K_COMPANION = 16

export const VEG_SHAPE_VARIANTS = 3

const GROVE_SEED = 0x67a0e5, PATCH_T_SEED = 0x51a7c1, PATCH_H_SEED = 0x2b3c4d, SEASON_SEED = 0x5ea50a
const GROVE_CELL_M = 96, GROVE_DETAIL_CELL_M = 37, PATCH_CELL_M = 64, SEASON_CELL_M = 420
const GROVE_MUL_FLOOR = 0.15, GROVE_MUL_SPAN = 1.45
const UNDERSTORY_BASE = 0.08, UNDERSTORY_CLEARING_GAIN = 0.35
const SCALE_LOW = 0.62, SCALE_SPAN_AGE = 0.72, SCALE_AGE_SKEW = 1.4
const SIZE_CLASS_SCALE = [0.90, 1.0, 1.10]
const LEAN_MAX_TREE = 0.09, LEAN_MAX_BUSH = 0.16
const TINT_BRIGHT_LOW = 0.80, TINT_BRIGHT_SPAN = 0.36, TINT_AGE_DARKEN = 0.06
const TINT_SAT_LOW = 0.35, TINT_SAT_SPAN = 0.65
const TINT_HUE_RANDOM_WEIGHT = 0.55, TINT_HUE_SEASON_WEIGHT = 0.45
const TINT_WARM = Object.freeze([1.22, 0.76, 0.52]), TINT_COOL = Object.freeze([0.64, 1.07, 0.58])
const GENUS_TINT_STRENGTH = Object.freeze({ [SP_PINE]: 0.4, [SP_BUSH]: 0.8 })
const COMPANION_CHANCE = 0.22
const COMPANION_GENUS = Object.freeze({ [SP_OAK]: SP_ASH, [SP_ASH]: SP_ASPEN, [SP_ASPEN]: SP_OAK, [SP_PINE]: SP_ASPEN })

const SIZE_SIBLINGS = {
  [SP_OAK]: [SP_OAK_S, SP_OAK_M, SP_OAK],
  [SP_PINE]: [SP_PINE_S, SP_PINE, SP_PINE_L],
  [SP_ASPEN]: [SP_ASPEN_S, SP_ASPEN, SP_ASPEN_L],
  [SP_ASH]: [SP_ASH_S, SP_ASH, SP_ASH_L],
  [SP_BUSH]: [SP_BUSH, SP_BUSH2, SP_BUSH3],
}
function sizeClassOf(sizeR, elevNorm) {
  const p = sizeR * 0.7 + (1 - Math.max(0, Math.min(1, elevNorm))) * 0.3
  return p < 0.40 ? 0 : (p < 0.75 ? 1 : 2)
}
function sizeSibling(genus, sizeClass) {
  const sibs = SIZE_SIBLINGS[genus]
  return sibs ? sibs[sizeClass] : genus
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export function seaNoise(seed, s, cellM) {
  return valueNoise3(hash3, seed, s[0], s[1], s[2], cellM)
}

export function groveAt(s) {
  return seaNoise(GROVE_SEED, s, GROVE_CELL_M) * 0.7 + seaNoise(GROVE_SEED ^ 0x9e37, s, GROVE_DETAIL_CELL_M) * 0.3
}

export function tintMultiplier(hue, sat, value) {
  const target = hue >= 0 ? TINT_WARM : TINT_COOL
  const w = Math.abs(hue) * sat
  return [
    Math.fround(value * (1 + w * (target[0] - 1))),
    Math.fround(value * (1 + w * (target[1] - 1))),
    Math.fround(value * (1 + w * (target[2] - 1))),
  ]
}

export function leanQuat(magnitude, dirAngle) {
  const s = Math.sin(magnitude * 0.5), c = Math.cos(magnitude * 0.5)
  return [Math.fround(Math.cos(dirAngle) * s), 0, Math.fround(Math.sin(dirAngle) * s), Math.fround(c)]
}

export function hash3(seed, ix, iz) {
  let h = seed | 0
  h = Math.imul(h ^ (ix | 0), 0x27d4eb2d) >>> 0
  h = Math.imul(h ^ (iz | 0), 0x165667b1) >>> 0
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39) >>> 0
  h ^= h >>> 15
  return h >>> 0
}

export function rand(h, k) {
  let x = (h ^ Math.imul((k | 0) + 1, 0x9e3779b1)) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0
  x ^= x >>> 13
  return (x >>> 0) / 4294967296
}

export const ARIDITY_LINE = 0.28

export const RELIEF_CALIBRATION_BASELINE = 0.01

export function reliefMarginScaleOf(frame) {
  return ((frame && frame.reliefScale) || RELIEF_CALIBRATION_BASELINE) / RELIEF_CALIBRATION_BASELINE
}

export const RENDERED_BEACH_TOP_M = 15
export const RENDERED_SAND_ONLY_BELOW_M = RENDERED_BEACH_TOP_M * 0.3

export function renderedSoilWeight(elevAboveSea) {
  const t = (elevAboveSea - RENDERED_SAND_ONLY_BELOW_M) / (RENDERED_BEACH_TOP_M - RENDERED_SAND_ONLY_BELOW_M)
  if (!(t > 0)) return 0
  if (t >= 1) return 1
  return t * t * (3 - 2 * t)
}

export function speciesFor(temp, humidity, elevNorm, vT = 0, vH = 0) {
  const t = Math.round((temp + vT) * 10) / 10
  const h = Math.round((humidity + vH) * 10) / 10
  const unjitteredHumidityIsArid = Math.round(humidity * 10) / 10 < ARIDITY_LINE
  if (unjitteredHumidityIsArid) return SP_BUSH
  if (elevNorm > 0.62 || t < 0.30) return SP_PINE
  if (t > 0.62 && h > 0.55) return SP_OAK
  if (h > 0.50) return SP_ASH
  return SP_ASPEN
}

export function baseDensity(temp, humidity, erosion = 0) {
  const wet = Math.max(0, Math.min(1, humidity))
  const warm = Math.max(0, Math.min(1, temp))
  const ero = Math.max(0, Math.min(1, erosion))
  return (0.12 + 0.73 * wet * (0.4 + 0.6 * warm)) * (1 - 0.45 * ero)
}

const BASE_DENSITY_CEILING = baseDensity(1, 1, 0)

const _vegClimate = { temp: 0.5, humidity: 0.5, base: 0 }

function readClimate(clim, groveMul, coin, out) {
  const temp = clim && Number.isFinite(clim.temp) ? clim.temp : 0.5
  const humidity = clim && Number.isFinite(clim.humidity) ? clim.humidity : 0.5
  const erosion = clim && Number.isFinite(clim.erosion) ? clim.erosion : 0.3
  if (clim && Number.isFinite(clim.seaBias) && clim.seaBias < VEG.SEA_REJECT) return false
  if (clim && clim.blocked) return false
  const base = baseDensity(temp, humidity, erosion) * groveMul
  if (coin >= base) return false
  out.temp = temp
  out.humidity = humidity
  out.base = base
  return true
}

export function createPlacementCell(frame) {
  return { dir: [0, 0, 0], sea: [0, 0, 0], at: [0, 0, 0], xz: [0, 0], row: 0, j: 0, id: 0, area: 1, rho: frame.radius + frame.anchorHeight }
}

export function placementCellAt(frame, lattice, dec, gx, gz, prejitterSeed, jitterOverCell, kJx, kJz, cell) {
  const i = dec[1] * lattice.cellsPerChunk + gx, j = dec[2] * lattice.cellsPerChunk + gz
  const row = lattice.hashRow(dec[0], i)
  const h = hash3(prejitterSeed, row, j)
  const d = lattice.cellDir(dec[0], i + 0.5 + (rand(h, kJx) * 2 - 1) * jitterOverCell, j + 0.5 + (rand(h, kJz) * 2 - 1) * jitterOverCell, cell.dir)
  const r = frame.radius
  cell.sea[0] = d[0] * r; cell.sea[1] = d[1] * r; cell.sea[2] = d[2] * r
  seaLocalXZ(frame, d, cell.xz)
  cell.row = row; cell.j = j
  cell.id = lattice.cellId(dec[0], i, j)
  cell.area = lattice.cellAreaOverTarget(i + 0.5, j + 0.5)
  return cell
}

export function surfaceOfCell(frame, cell) {
  const d = cell.dir
  const rho = surfaceAlongDir(frame, d[0], d[1], d[2], cell.rho, cell.at)
  if (Number.isFinite(rho)) cell.rho = rho
  return rho
}

export function classify(frame, anchorField, cell) {
  const s = cell.sea
  const grove = groveAt(s)
  const groveWeight = smoothstep(0.30, 0.70, grove)
  const groveMul = (GROVE_MUL_FLOOR + GROVE_MUL_SPAN * groveWeight) * cell.area
  const cellHash = hash3(0x5eed | 0, cell.row, cell.j)
  const coin = rand(cellHash, K_COIN)
  if (coin >= BASE_DENSITY_CEILING * groveMul) return null

  const climateBeforeSolve = anchorField.climateUsesLocalXZ !== true
  if (climateBeforeSolve && !readClimate(climateAt(anchorField, cell.xz[0], cell.xz[1], cell.dir), groveMul, coin, _vegClimate)) return null

  const rho = surfaceOfCell(frame, cell)
  if (!Number.isFinite(rho)) return null
  const x = cell.at[0], groundY = cell.at[1], z = cell.at[2]
  if (!climateBeforeSolve && !readClimate(climateAt(anchorField, x, z, cell.dir), groveMul, coin, _vegClimate)) return null
  const temp = _vegClimate.temp, humidity = _vegClimate.humidity, base = _vegClimate.base
  const elev = rho - frame.radius
  const reliefMarginScale = reliefMarginScaleOf(frame)
  const treeline = VEG.TREELINE * reliefMarginScale
  const treelineMul = elev > treeline ? 1 - (elev - treeline) / (VEG.TREELINE_FADE * reliefMarginScale) : 1
  const soilMul = renderedSoilWeight(elev) * treelineMul
  if (soilMul <= 0) return null
  const tf = tangentFrame(frame, cell.dir[0], cell.dir[1], cell.dir[2])
  const slope = radialSlopeAt(frame, tf, rho, VEG.SLOPE_D)
  if (!slope) return null
  if (Math.hypot(slope[0], slope[1]) > VEG.SLOPE_MAX) return null
  const painted = paintedWeightsFor(frame.hashVersion)(cell.dir, elev, paintedSlopeOf(slope[0], slope[1]), temp, humidity)
  const densityMul = soilMul * painted.grass
  if (densityMul <= 0 || coin >= base * densityMul) return null

  const elevNorm = Math.max(0, Math.min(1, elev / VEG.TREELINE))
  const vT = (rand(cellHash, K_VARIANT) - 0.5) * 0.30 + (seaNoise(PATCH_T_SEED, s, PATCH_CELL_M) - 0.5) * 0.60
  const vH = (rand(cellHash, K_SPECIESH) - 0.5) * 0.30 + (seaNoise(PATCH_H_SEED, s, PATCH_CELL_M) - 0.5) * 0.60
  const climateGenus = speciesFor(temp, humidity, elevNorm, vT, vH)
  const understoryChance = UNDERSTORY_BASE + UNDERSTORY_CLEARING_GAIN * (1 - groveWeight)
  const companion = COMPANION_GENUS[climateGenus]
  const canopyGenus = companion !== undefined && rand(cellHash, K_COMPANION) < COMPANION_CHANCE ? companion : climateGenus
  const genus = rand(cellHash, K_UNDERSTORY) < understoryChance ? SP_BUSH : canopyGenus
  const sizeClass = sizeClassOf(rand(cellHash, K_SIZE), elevNorm)
  const species = sizeSibling(genus, sizeClass)
  const age = Math.pow(rand(cellHash, K_SCALE), SCALE_AGE_SKEW)
  const scale = Math.fround((SCALE_LOW + SCALE_SPAN_AGE * age) * SIZE_CLASS_SCALE[sizeClass])
  const yaw = Math.fround(rand(cellHash, K_YAW) * Math.PI * 2)
  const windPhase = Math.fround(rand(cellHash, K_WIND) * Math.PI * 2)
  const shape = Math.min(VEG_SHAPE_VARIANTS - 1, Math.floor(rand(cellHash, K_SHAPE) * VEG_SHAPE_VARIANTS))
  const leanR = rand(cellHash, K_LEAN)
  const leanMax = genus === SP_BUSH ? LEAN_MAX_BUSH : LEAN_MAX_TREE
  const tiltQuat = quatMulF32(tangentFrameQuat(tf), leanQuat(leanR * leanR * leanMax, rand(cellHash, K_LEAN_DIR) * Math.PI * 2))
  const season = (seaNoise(SEASON_SEED, s, SEASON_CELL_M) - 0.5) * 2
  const hue = Math.max(-1, Math.min(1, (rand(cellHash, K_TINT_HUE) * 2 - 1) * TINT_HUE_RANDOM_WEIGHT + season * TINT_HUE_SEASON_WEIGHT))
  const sat = (TINT_SAT_LOW + TINT_SAT_SPAN * rand(cellHash, K_TINT_SAT)) * (GENUS_TINT_STRENGTH[genus] ?? 1)
  const value = (TINT_BRIGHT_LOW + TINT_BRIGHT_SPAN * rand(cellHash, K_TINT_VAL)) * (1 - TINT_AGE_DARKEN * (scale - 1))
  const tint = tintMultiplier(hue, sat, value)

  return {
    x: Math.fround(x), y: Math.fround(groundY), z: Math.fround(z),
    species, shape, scale, yaw, windPhase, tint,
    tiltQuat, normal: [Math.fround(tf.upL[0]), Math.fround(tf.upL[1]), Math.fround(tf.upL[2])],
    trunkId: cell.id,
  }
}

export function placementsForChunk(key, frame, anchorField, worldSeed) {
  const out = []
  const lattice = latticeFor(frame, VEG)
  const dec = lattice.decodeChunk(key, [0, 0, 0])
  const seed = (worldSeed | 0) ^ 0x7eed
  const cell = createPlacementCell(frame)
  for (let gz = 0; gz < VEG.GRID; gz++) {
    for (let gx = 0; gx < VEG.GRID; gx++) {
      placementCellAt(frame, lattice, dec, gx, gz, seed, VEG.JITTER / VEG.CELL, K_JITX, K_JITZ, cell)
      const p = classify(frame, anchorField, cell)
      if (p) out.push(p)
    }
  }
  return out
}
