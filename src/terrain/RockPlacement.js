import { hash3, rand, trunkIdOf, ARIDITY_LINE, RELIEF_CALIBRATION_BASELINE, VEG } from './VegPlacement.js'

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
})

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

const _cornerCache = new Map()
function cornerValue(ix, iz) {
  const k = ((ix & 0x3fffff) * 0x400000) + (iz & 0x3fffff)
  let v = _cornerCache.get(k)
  if (v !== undefined) return v
  v = rand(hash3(0x70c1 | 0, ix, iz), 0)
  _cornerCache.set(k, v)
  return v
}

function patchDensity(x, z) {
  const fx = x / PATCH, fz = z / PATCH
  const ix = Math.floor(fx), iz = Math.floor(fz)
  let tx = fx - ix, tz = fz - iz
  tx = tx * tx * (3 - 2 * tx); tz = tz * tz * (3 - 2 * tz)
  const c00 = cornerValue(ix, iz), c10 = cornerValue(ix + 1, iz)
  const c01 = cornerValue(ix, iz + 1), c11 = cornerValue(ix + 1, iz + 1)
  const a = c00 + (c10 - c00) * tx, b = c01 + (c11 - c01) * tx
  return a + (b - a) * tz
}

const CLUSTER_SCALE = 224
const MAX_CLUSTER_STRENGTH = 0.6
const _clusterCornerCache = new Map()
function clusterCornerValue(ix, iz) {
  const k = ((ix & 0x3fffff) * 0x400000) + (iz & 0x3fffff)
  let v = _clusterCornerCache.get(k)
  if (v !== undefined) return v
  v = rand(hash3(0x70c2 | 0, ix, iz), 0)
  _clusterCornerCache.set(k, v)
  return v
}
function sizeClusterField(x, z) {
  const fx = x / CLUSTER_SCALE, fz = z / CLUSTER_SCALE
  const ix = Math.floor(fx), iz = Math.floor(fz)
  let tx = fx - ix, tz = fz - iz
  tx = tx * tx * (3 - 2 * tx); tz = tz * tz * (3 - 2 * tz)
  const c00 = clusterCornerValue(ix, iz), c10 = clusterCornerValue(ix + 1, iz)
  const c01 = clusterCornerValue(ix, iz + 1), c11 = clusterCornerValue(ix + 1, iz + 1)
  const a = c00 + (c10 - c00) * tx, b = c01 + (c11 - c01) * tx
  return a + (b - a) * tz
}

export function classify(x, z, frame, anchorField, h, cellIx, cellIz) {
  const elev = (h !== undefined) ? h : frame.groundHeightLocal(x, z)
  if (!Number.isFinite(elev)) return null
  const reliefMarginScale = ((frame && frame.reliefScale) || RELIEF_CALIBRATION_BASELINE) / RELIEF_CALIBRATION_BASELINE
  if (elev <= ROCK.WATER_MARGIN * reliefMarginScale) return null

  const clim = anchorField
    ? (anchorField.climateAtLocal ? anchorField.climateAtLocal(x, z) : anchorField.sampleDir(frame.localToDir(x, z)))
    : null
  const erosion = clim && Number.isFinite(clim.erosion) ? clim.erosion : 0.3
  const humidity = clim && Number.isFinite(clim.humidity) ? clim.humidity : 0.5
  if (clim && Number.isFinite(clim.seaBias) && clim.seaBias < ROCK.SEA_REJECT) return null
  if (clim && clim.blocked) return null

  const elevNorm = Math.max(0, Math.min(1, elev / VEG.TREELINE))
  const ix = (cellIx !== undefined) ? cellIx : Math.round(x / ROCK.CELL)
  const iz = (cellIz !== undefined) ? cellIz : Math.round(z / ROCK.CELL)
  const cellHash = hash3(0x70c | 0, ix, iz)
  const patch = 0.25 + 1.5 * patchDensity(x, z)
  const cluster = sizeClusterField(x, z)
  const coin = rand(cellHash, K_COIN)
  const clusterBoostUpperBoundOverAllSlopes = 1 + MAX_CLUSTER_STRENGTH * Math.max(0, cluster - 0.5)
  const ceiling = Math.max(ROCK.FLOOR, Math.min(1, rockDensity(erosion, 1, humidity, elevNorm) * patch * clusterBoostUpperBoundOverAllSlopes))
  if (coin >= ceiling) return null

  const D = ROCK.SLOPE_D
  const hx1 = frame.groundHeightLocal(x + D, z), hx0 = frame.groundHeightLocal(x - D, z)
  const hz1 = frame.groundHeightLocal(x, z + D), hz0 = frame.groundHeightLocal(x, z - D)
  if (!Number.isFinite(hx1) || !Number.isFinite(hx0) || !Number.isFinite(hz1) || !Number.isFinite(hz0)) return null
  const dHdx = (hx1 - hx0) / (2 * D), dHdz = (hz1 - hz0) / (2 * D)
  const grad = Math.hypot(dHdx, dHdz)
  const slopeRatio = grad / (grad + 1)

  let nx = -dHdx, ny = 1, nz = -dHdz
  const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl

  const clusterStrength = MAX_CLUSTER_STRENGTH * (1 - slopeRatio)
  const accept = Math.max(ROCK.FLOOR, Math.min(1, rockDensity(erosion, slopeRatio, humidity, elevNorm) * patch * (1 + clusterStrength * (cluster - 0.5))))
  if (coin >= accept) return null

  const type = Math.floor(rand(cellHash, K_TYPE) * ROCK.TYPES) % ROCK.TYPES
  const sc = rand(cellHash, K_SCALE)
  const scBiased = Math.max(0, Math.min(1, sc + (cluster - 0.5) * 0.6))
  const scale = Math.fround(ROCK.SCALE_MIN + scBiased * scBiased * scBiased * ROCK.SCALE_SPAN)
  const yaw = Math.fround(rand(cellHash, K_YAW) * Math.PI * 2)
  const wob = (rand(cellHash, K_TILTX) - 0.5) * 0.12, wobZ = (rand(cellHash, K_TILTZ) - 0.5) * 0.12
  const squash = Math.fround(0.55 + rand(cellHash, K_SQUASH) * 0.55)
  const variant = Math.fround(rand(cellHash, K_VAR))
  let bnx = nx + wob, bny = ny, bnz = nz + wobZ
  const bl = Math.hypot(bnx, bny, bnz); bnx /= bl; bny /= bl; bnz /= bl
  const tq = normalQuat(bnx, bny, bnz, [0, 0, 0, 1])

  return {
    x: Math.fround(x), y: Math.fround(elev), z: Math.fround(z),
    type, scale, yaw, squash, variant,
    normal: [Math.fround(nx), Math.fround(ny), Math.fround(nz)], tiltQuat: tq,
    rockId: trunkIdOf(x, z),
  }
}

export function placementsForRockChunk(chunkX, chunkZ, frame, anchorField, worldSeed) {
  const out = []
  const baseX = chunkX * ROCK.CHUNK, baseZ = chunkZ * ROCK.CHUNK
  const seed = (worldSeed | 0) ^ 0x70c5
  for (let gz = 0; gz < ROCK.GRID; gz++) {
    for (let gx = 0; gx < ROCK.GRID; gx++) {
      const cellX = baseX + gx * ROCK.CELL + ROCK.CELL * 0.5
      const cellZ = baseZ + gz * ROCK.CELL + ROCK.CELL * 0.5
      const ix = Math.round(cellX / ROCK.CELL), iz = Math.round(cellZ / ROCK.CELL)
      const hh = hash3(seed, ix, iz)
      const jx = (rand(hh, 0) * 2 - 1) * ROCK.JITTER
      const jz = (rand(hh, 1) * 2 - 1) * ROCK.JITTER
      const p = classify(cellX + jx, cellZ + jz, frame, anchorField, undefined, ix, iz)
      if (p) out.push(p)
    }
  }
  return out
}
