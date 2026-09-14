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
  TILT_CAP: 0.4363,
  SCALE_MIN: 0.75,
  SCALE_SPAN: 0.50,
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

const SIZE_SIBLINGS = {
  [SP_OAK]: [SP_OAK_S, SP_OAK_M, SP_OAK],
  [SP_PINE]: [SP_PINE_S, SP_PINE, SP_PINE_L],
  [SP_ASPEN]: [SP_ASPEN_S, SP_ASPEN, SP_ASPEN_L],
  [SP_ASH]: [SP_ASH_S, SP_ASH, SP_ASH_L],
  [SP_BUSH]: [SP_BUSH, SP_BUSH2, SP_BUSH3],
}
function sizeSibling(genus, sizeR, elevNorm) {
  const sibs = SIZE_SIBLINGS[genus]
  if (!sibs) return genus
  const p = sizeR * 0.7 + (1 - Math.max(0, Math.min(1, elevNorm))) * 0.3
  const idx = p < 0.40 ? 0 : (p < 0.75 ? 1 : 2)
  return sibs[idx]
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

  const base = baseDensity(temp, humidity, erosion)
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
  const vT = (rand(cellHash, K_VARIANT) - 0.5) * 0.50
  const vH = (rand(cellHash, K_SPECIESH) - 0.5) * 0.50
  const genus = speciesFor(temp, humidity, elevNorm, vT, vH)
  const species = sizeSibling(genus, rand(cellHash, K_SIZE), elevNorm)
  const scale = Math.fround(VEG.SCALE_MIN + rand(cellHash, K_SCALE) * VEG.SCALE_SPAN)
  const yaw = Math.fround(rand(cellHash, K_YAW) * Math.PI * 2)
  const windPhase = Math.fround(rand(cellHash, K_WIND) * Math.PI * 2)
  const tiltQuat = [0, 0, 0, 1]

  return {
    x: Math.fround(x), y: Math.fround(groundY), z: Math.fround(z),
    species, scale, yaw, windPhase,
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
