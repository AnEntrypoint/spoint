import { elevationAtLocal } from './PlanetFrame.js'

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
const K_SHAPE = 9, K_TINT_HUE = 10, K_TINT_SAT = 11, K_TINT_VAL = 12, K_LEAN = 13, K_LEAN_DIR = 14, K_UNDERSTORY = 15

export const VEG_SHAPE_VARIANTS = 3

const GROVE_SEED = 0x67a0e5, PATCH_T_SEED = 0x51a7c1, PATCH_H_SEED = 0x2b3c4d, SEASON_SEED = 0x5ea50a
const GROVE_CELL_M = 96, GROVE_DETAIL_CELL_M = 37, PATCH_CELL_M = 64, SEASON_CELL_M = 420
const GROVE_MUL_FLOOR = 0.15, GROVE_MUL_SPAN = 1.45
const UNDERSTORY_BASE = 0.08, UNDERSTORY_CLEARING_GAIN = 0.35
const SCALE_LOW = 0.62, SCALE_SPAN_AGE = 0.72, SCALE_AGE_SKEW = 1.4
const SIZE_CLASS_SCALE = [0.90, 1.0, 1.10]
const LEAN_MAX_TREE = 0.09, LEAN_MAX_BUSH = 0.16
const TINT_BRIGHT_LOW = 0.80, TINT_BRIGHT_SPAN = 0.36, TINT_AGE_DARKEN = 0.06
const TINT_SAT_LOW = 0.10, TINT_SAT_SPAN = 0.70
const TINT_HUE_RANDOM_WEIGHT = 0.65, TINT_HUE_SEASON_WEIGHT = 0.35
const TINT_WARM = Object.freeze([1.16, 1.02, 0.72]), TINT_COOL = Object.freeze([0.84, 1.0, 1.10])

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

function latticeValue(seed, ix, iz) {
  return hash3(seed, ix, iz) / 4294967296
}

export function valueNoise(seed, x, z, cellM) {
  const fx = x / cellM, fz = z / cellM
  const ix = Math.floor(fx), iz = Math.floor(fz)
  const tx = fx - ix, tz = fz - iz
  const sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz)
  const a = latticeValue(seed, ix, iz), b = latticeValue(seed, ix + 1, iz)
  const c = latticeValue(seed, ix, iz + 1), d = latticeValue(seed, ix + 1, iz + 1)
  return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sz
}

export function groveAt(x, z) {
  return valueNoise(GROVE_SEED, x, z, GROVE_CELL_M) * 0.7 + valueNoise(GROVE_SEED ^ 0x9e37, x, z, GROVE_DETAIL_CELL_M) * 0.3
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

const TRUNK_ID_QUANTUM_M = 0.04
export function trunkIdOf(x, z) {
  const qx = (Math.round(x / TRUNK_ID_QUANTUM_M) & 0xffff) >>> 0
  const qz = (Math.round(z / TRUNK_ID_QUANTUM_M) & 0xffff) >>> 0
  let m = 0
  for (let i = 0; i < 16; i++) m |= ((qx >> i) & 1) << (2 * i) | ((qz >> i) & 1) << (2 * i + 1)
  return m >>> 0
}

export const ARIDITY_LINE = 0.28

export const RELIEF_CALIBRATION_BASELINE = 0.01

export function reliefMarginScaleOf(frame) {
  return ((frame && frame.reliefScale) || RELIEF_CALIBRATION_BASELINE) / RELIEF_CALIBRATION_BASELINE
}

export function elevationAboveSea(frame, x, groundY, z) {
  const e = elevationAtLocal(frame, x, groundY, z)
  return Number.isFinite(e) ? e : NaN
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

const VEG_UP_NORMAL = Object.freeze([0, 1, 0])

export function classify(x, z, frame, anchorField, h, cellIx, cellIz) {
  const clim = anchorField
    ? (anchorField.climateAtLocal ? anchorField.climateAtLocal(x, z) : anchorField.sampleDir(frame.localToDir(x, z)))
    : null
  const temp = clim && Number.isFinite(clim.temp) ? clim.temp : 0.5
  const humidity = clim && Number.isFinite(clim.humidity) ? clim.humidity : 0.5
  const erosion = clim && Number.isFinite(clim.erosion) ? clim.erosion : 0.3
  if (clim && Number.isFinite(clim.seaBias) && clim.seaBias < VEG.SEA_REJECT) return null
  if (clim && clim.blocked) return null

  const grove = groveAt(x, z)
  const groveWeight = smoothstep(0.30, 0.70, grove)
  const base = baseDensity(temp, humidity, erosion) * (GROVE_MUL_FLOOR + GROVE_MUL_SPAN * groveWeight)
  const ix = (cellIx !== undefined) ? cellIx : Math.round(x / VEG.CELL)
  const iz = (cellIz !== undefined) ? cellIz : Math.round(z / VEG.CELL)
  const cellHash = hash3(0x5eed | 0, ix, iz)
  const coin = rand(cellHash, K_COIN)
  if (coin >= base) return null

  const groundY = (h !== undefined) ? h : frame.groundHeightLocal(x, z)
  if (!Number.isFinite(groundY)) return null
  const elev = elevationAboveSea(frame, x, groundY, z)
  if (!Number.isFinite(elev)) return null
  const reliefMarginScale = reliefMarginScaleOf(frame)
  const treeline = VEG.TREELINE * reliefMarginScale
  const treelineMul = elev > treeline ? 1 - (elev - treeline) / (VEG.TREELINE_FADE * reliefMarginScale) : 1
  const densityMul = renderedSoilWeight(elev) * treelineMul
  if (densityMul <= 0 || coin >= base * densityMul) return null

  const D = VEG.SLOPE_D
  const hx1 = frame.groundHeightLocal(x + D, z), hx0 = frame.groundHeightLocal(x - D, z)
  const hz1 = frame.groundHeightLocal(x, z + D), hz0 = frame.groundHeightLocal(x, z - D)
  if (!Number.isFinite(hx1) || !Number.isFinite(hx0) || !Number.isFinite(hz1) || !Number.isFinite(hz0)) return null
  const dHdx = (hx1 - hx0) / (2 * D), dHdz = (hz1 - hz0) / (2 * D)
  const grad = Math.hypot(dHdx, dHdz)
  if (grad > VEG.SLOPE_MAX) return null

  const elevNorm = Math.max(0, Math.min(1, elev / VEG.TREELINE))
  const vT = (rand(cellHash, K_VARIANT) - 0.5) * 0.30 + (valueNoise(PATCH_T_SEED, x, z, PATCH_CELL_M) - 0.5) * 0.60
  const vH = (rand(cellHash, K_SPECIESH) - 0.5) * 0.30 + (valueNoise(PATCH_H_SEED, x, z, PATCH_CELL_M) - 0.5) * 0.60
  const climateGenus = speciesFor(temp, humidity, elevNorm, vT, vH)
  const understoryChance = UNDERSTORY_BASE + UNDERSTORY_CLEARING_GAIN * (1 - groveWeight)
  const genus = rand(cellHash, K_UNDERSTORY) < understoryChance ? SP_BUSH : climateGenus
  const sizeClass = sizeClassOf(rand(cellHash, K_SIZE), elevNorm)
  const species = sizeSibling(genus, sizeClass)
  const age = Math.pow(rand(cellHash, K_SCALE), SCALE_AGE_SKEW)
  const scale = Math.fround((SCALE_LOW + SCALE_SPAN_AGE * age) * SIZE_CLASS_SCALE[sizeClass])
  const yaw = Math.fround(rand(cellHash, K_YAW) * Math.PI * 2)
  const windPhase = Math.fround(rand(cellHash, K_WIND) * Math.PI * 2)
  const shape = Math.min(VEG_SHAPE_VARIANTS - 1, Math.floor(rand(cellHash, K_SHAPE) * VEG_SHAPE_VARIANTS))
  const leanR = rand(cellHash, K_LEAN)
  const leanMax = genus === SP_BUSH ? LEAN_MAX_BUSH : LEAN_MAX_TREE
  const tiltQuat = leanQuat(leanR * leanR * leanMax, rand(cellHash, K_LEAN_DIR) * Math.PI * 2)
  const season = (valueNoise(SEASON_SEED, x, z, SEASON_CELL_M) - 0.5) * 2
  const hue = Math.max(-1, Math.min(1, (rand(cellHash, K_TINT_HUE) * 2 - 1) * TINT_HUE_RANDOM_WEIGHT + season * TINT_HUE_SEASON_WEIGHT))
  const sat = TINT_SAT_LOW + TINT_SAT_SPAN * rand(cellHash, K_TINT_SAT)
  const value = (TINT_BRIGHT_LOW + TINT_BRIGHT_SPAN * rand(cellHash, K_TINT_VAL)) * (1 - TINT_AGE_DARKEN * (scale - 1))
  const tint = tintMultiplier(hue, sat, value)

  return {
    x: Math.fround(x), y: Math.fround(groundY), z: Math.fround(z),
    species, shape, scale, yaw, windPhase, tint,
    tiltQuat, normal: VEG_UP_NORMAL,
    trunkId: trunkIdOf(x, z),
  }
}

export function placementsForChunk(chunkX, chunkZ, frame, anchorField, worldSeed) {
  const out = []
  const baseX = chunkX * VEG.CHUNK, baseZ = chunkZ * VEG.CHUNK
  const seed = (worldSeed | 0) ^ 0x7eed
  for (let gz = 0; gz < VEG.GRID; gz++) {
    for (let gx = 0; gx < VEG.GRID; gx++) {
      const cellX = baseX + gx * VEG.CELL + VEG.CELL * 0.5
      const cellZ = baseZ + gz * VEG.CELL + VEG.CELL * 0.5
      const ix = Math.round(cellX / VEG.CELL), iz = Math.round(cellZ / VEG.CELL)
      const h = hash3(seed, ix, iz)
      const jx = (rand(h, K_JITX) * 2 - 1) * VEG.JITTER
      const jz = (rand(h, K_JITZ) * 2 - 1) * VEG.JITTER
      const p = classify(cellX + jx, cellZ + jz, frame, anchorField, undefined, ix, iz)
      if (p) out.push(p)
    }
  }
  return out
}
