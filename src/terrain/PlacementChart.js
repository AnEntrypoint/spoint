import { createPlacementLattice } from './PlacementLattice.js'
import { guardedGroundHeight } from './PlanetFrame.js'

const SURFACE_LATERAL_TOL_M = 1e-4
const SURFACE_LATERAL_ACCEPT_M = 1e-2
const SURFACE_MAX_ITERS = 16
const POLE_REF_SWITCH = 0.99

const _lattices = new Map()
export function latticeFor(frame, spec) {
  let byShape = _lattices.get(frame.radius)
  if (!byShape) { byShape = new Map(); _lattices.set(frame.radius, byShape) }
  const k = spec.CHUNK * 65536 + spec.GRID
  let l = byShape.get(k)
  if (!l) { l = createPlacementLattice(frame.radius, spec.CHUNK, spec.GRID); byShape.set(k, l) }
  return l
}

const _chunkDir = [0, 0, 0]
export function ringAroundLocal(lattice, frame, x, z, radiusM) {
  const d = frame.localToDir(x, z, undefined, _chunkDir)
  return lattice.ringAroundDir(d[0], d[1], d[2], radiusM)
}

export function chunkKeyAtLocal(lattice, frame, x, z) {
  const d = frame.localToDir(x, z, undefined, _chunkDir)
  return lattice.chunkKeyOfDir(d[0], d[1], d[2])
}

function dotE(frame, v0, v1, v2) { const e = frame.east; return v0 * e[0] + v1 * e[1] + v2 * e[2] }
function dotU(frame, v0, v1, v2) { const u = frame.up; return v0 * u[0] + v1 * u[1] + v2 * u[2] }
function dotN(frame, v0, v1, v2) { const n = frame.north; return v0 * n[0] + v1 * n[1] + v2 * n[2] }

const _cd = [0, 0, 0]
export function chunkCentreLocal(lattice, frame, key, out) {
  lattice.chunkCentreDir(key, _cd)
  out[0] = frame.radius * dotE(frame, _cd[0], _cd[1], _cd[2])
  out[1] = frame.radius * dotN(frame, _cd[0], _cd[1], _cd[2])
  return out
}

const CORNERS = [[0, 0], [1, 0], [0, 1], [1, 1]]
const _bounds = [0, 0, 0, 0]
export function chunkBoundsLocal(lattice, frame, key, placements) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
  for (let c = 0; c < CORNERS.length; c++) {
    lattice.chunkCornerDir(key, CORNERS[c][0], CORNERS[c][1], _cd)
    const x = frame.radius * dotE(frame, _cd[0], _cd[1], _cd[2]), z = frame.radius * dotN(frame, _cd[0], _cd[1], _cd[2])
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  if (placements) for (let i = 0; i < placements.length; i++) {
    const p = placements[i]
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z
  }
  _bounds[0] = minX; _bounds[1] = minZ; _bounds[2] = maxX; _bounds[3] = maxZ
  return _bounds
}

const _groundGuards = new WeakMap()
function guardedGroundOf(frame) {
  let guarded = _groundGuards.get(frame)
  if (!guarded) {
    guarded = guardedGroundHeight('placement chart surface solve', (x, z) => frame.groundHeightLocal(x, z))
    _groundGuards.set(frame, guarded)
  }
  return guarded
}

const LATTICE_SOLVE_ITERS = 8
const LATTICE_SOLVE_TOL_M = 1e-4

function latticeRhoAlongDir(frame, de, du, dn, base, rhoGuess, out) {
  const lattice = frame.sharedLattice
  if (!lattice || typeof lattice.covers !== 'function' || typeof lattice.heightAtLocal !== 'function') return NaN
  if (!(Math.abs(du) > 1e-9)) return NaN
  const offsetY = Number.isFinite(frame.offsetY) ? frame.offsetY : 0
  for (let attempt = 0; attempt < 2; attempt++) {
    const seed = attempt === 0 ? frame.radius + (Number.isFinite(frame.anchorHeight) ? frame.anchorHeight : 0) : rhoGuess
    if (!Number.isFinite(seed) || !(seed > 0)) continue
    let rho = seed, converged = false
    for (let k = 0; k < LATTICE_SOLVE_ITERS; k++) {
      const x = rho * de, z = rho * dn
      if (!lattice.covers(x, z)) { rho = NaN; break }
      const y = lattice.heightAtLocal(x, z)
      if (!Number.isFinite(y)) { rho = NaN; break }
      const next = (y + offsetY + base) / du
      if (!Number.isFinite(next) || !(next > 0)) { rho = NaN; break }
      const step = next - rho
      rho = next
      if (Math.abs(step) <= LATTICE_SOLVE_TOL_M) { converged = true; break }
    }
    if (converged && Number.isFinite(rho)) {
      out[0] = rho * de; out[1] = rho * du - base; out[2] = rho * dn
      return rho
    }
  }
  return NaN
}

const _elevationDir = [0, 0, 0]
export function surfaceAlongDir(frame, dx, dy, dz, rhoGuess, out) {
  const de = dotE(frame, dx, dy, dz), du = dotU(frame, dx, dy, dz), dn = dotN(frame, dx, dy, dz)
  const base = frame.radius + frame.anchorHeight - frame.offsetY
  const latticeRho = latticeRhoAlongDir(frame, de, du, dn, base, rhoGuess, out)
  if (Number.isFinite(latticeRho)) return latticeRho
  if (frame.groundSource === 'cpu-solve') {
    _elevationDir[0] = dx; _elevationDir[1] = dy; _elevationDir[2] = dz
    const h = frame.elevationAtDir(_elevationDir)
    if (!Number.isFinite(h)) return NaN
    const r = frame.radius + h
    out[0] = r * de; out[1] = r * du - base; out[2] = r * dn
    return r
  }
  const groundAt = guardedGroundOf(frame)
  let rho = rhoGuess, bestRho = NaN, bestLateral2 = Infinity
  for (let k = 0; k < SURFACE_MAX_ITERS; k++) {
    const x = rho * de, z = rho * dn
    const y = groundAt(x, z)
    if (!Number.isFinite(y)) return NaN
    const t = base + y
    const along = t * du + x * de + z * dn
    const lx = x - de * along, ly = t - du * along, lz = z - dn * along
    const lateral2 = lx * lx + ly * ly + lz * lz
    rho = Math.sqrt(t * t + x * x + z * z)
    if (lateral2 < bestLateral2) { bestLateral2 = lateral2; bestRho = rho; out[0] = x; out[1] = y; out[2] = z }
    if (lateral2 <= SURFACE_LATERAL_TOL_M * SURFACE_LATERAL_TOL_M) return rho
  }
  return bestLateral2 <= SURFACE_LATERAL_ACCEPT_M * SURFACE_LATERAL_ACCEPT_M ? bestRho : NaN
}

export function createTangentFrame() {
  return { east: [0, 0, 0], north: [0, 0, 0], up: [0, 0, 0], eastL: [0, 0, 0], upL: [0, 0, 0], northL: [0, 0, 0] }
}

function setChartComponents(out, frame, v0, v1, v2) {
  out[0] = dotE(frame, v0, v1, v2); out[1] = dotU(frame, v0, v1, v2); out[2] = dotN(frame, v0, v1, v2)
}

export function tangentFrameInto(frame, dx, dy, dz, tf) {
  const refY = Math.abs(dy) < POLE_REF_SWITCH
  let ex = refY ? dz : 0, ey = refY ? 0 : -dz, ez = refY ? -dx : dy
  const el = Math.hypot(ex, ey, ez); ex /= el; ey /= el; ez /= el
  const nx = ey * dz - ez * dy, ny = ez * dx - ex * dz, nz = ex * dy - ey * dx
  tf.east[0] = ex; tf.east[1] = ey; tf.east[2] = ez
  tf.north[0] = nx; tf.north[1] = ny; tf.north[2] = nz
  tf.up[0] = dx; tf.up[1] = dy; tf.up[2] = dz
  setChartComponents(tf.eastL, frame, ex, ey, ez)
  setChartComponents(tf.upL, frame, dx, dy, dz)
  setChartComponents(tf.northL, frame, nx, ny, nz)
  return tf
}

export function tangentFrame(frame, dx, dy, dz) {
  return tangentFrameInto(frame, dx, dy, dz, createTangentFrame())
}

export function tangentToLocalInto(tf, a, b, c, out) {
  const e = tf.eastL, u = tf.upL, n = tf.northL
  out[0] = e[0] * a + u[0] * b + n[0] * c
  out[1] = e[1] * a + u[1] * b + n[1] * c
  out[2] = e[2] * a + u[2] * b + n[2] * c
  return out
}

export function tangentToLocal(tf, a, b, c) {
  return tangentToLocalInto(tf, a, b, c, [0, 0, 0])
}

export function tangentHeadingInChart(tf) {
  return Math.atan2(-tf.eastL[2], tf.eastL[0])
}

export function tangentFrameQuatInto(tf, out) {
  const m00 = tf.eastL[0], m10 = tf.eastL[1], m20 = tf.eastL[2]
  const m01 = tf.upL[0], m11 = tf.upL[1], m21 = tf.upL[2]
  const m02 = tf.northL[0], m12 = tf.northL[1], m22 = tf.northL[2]
  const tr = m00 + m11 + m22
  let x, y, z, w
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1)
    w = 0.25 / s; x = (m21 - m12) * s; y = (m02 - m20) * s; z = (m10 - m01) * s
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22)
    w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22)
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11)
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s
  }
  out[0] = x; out[1] = y; out[2] = z; out[3] = w
  return out
}

export function tangentFrameQuat(tf) {
  return tangentFrameQuatInto(tf, [0, 0, 0, 0])
}

export function quatMulF32Into(a, b, out) {
  const x = Math.fround(a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1])
  const y = Math.fround(a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0])
  const z = Math.fround(a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3])
  const w = Math.fround(a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2])
  out[0] = x; out[1] = y; out[2] = z; out[3] = w
  return out
}

export function quatMulF32(a, b) {
  return quatMulF32Into(a, b, [0, 0, 0, 0])
}

const _probe = [0, 0, 0]
function radialProbe(frame, tf, rho, sx, sz) {
  const d = tf.up, e = tf.east, n = tf.north
  const px = d[0] * rho + e[0] * sx + n[0] * sz, py = d[1] * rho + e[1] * sx + n[1] * sz, pz = d[2] * rho + e[2] * sx + n[2] * sz
  const l = Math.hypot(px, py, pz)
  return surfaceAlongDir(frame, px / l, py / l, pz / l, rho, _probe)
}
export function radialSlopeInto(frame, tf, rho, stepM, out) {
  const ex1 = radialProbe(frame, tf, rho, stepM, 0), ex0 = radialProbe(frame, tf, rho, -stepM, 0)
  const nz1 = radialProbe(frame, tf, rho, 0, stepM), nz0 = radialProbe(frame, tf, rho, 0, -stepM)
  if (!Number.isFinite(ex1) || !Number.isFinite(ex0) || !Number.isFinite(nz1) || !Number.isFinite(nz0)) return null
  out[0] = (ex1 - ex0) / (2 * stepM)
  out[1] = (nz1 - nz0) / (2 * stepM)
  return out
}
export function radialSlopeAt(frame, tf, rho, stepM) {
  return radialSlopeInto(frame, tf, rho, stepM, [0, 0])
}

export function climateAt(anchorField, x, z, d) {
  if (!anchorField) return null
  return anchorField.climateAtLocal ? anchorField.climateAtLocal(x, z, d) : anchorField.sampleDir(d)
}

export function seaLocalXZ(frame, dir, out) {
  out[0] = frame.radius * dotE(frame, dir[0], dir[1], dir[2])
  out[1] = frame.radius * dotN(frame, dir[0], dir[1], dir[2])
  return out
}

export function valueNoise3(hash, seed, px, py, pz, cellM) {
  const fx = px / cellM, fy = py / cellM, fz = pz / cellM
  const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz)
  let tx = fx - ix, ty = fy - iy, tz = fz - iz
  tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty); tz = tz * tz * (3 - 2 * tz)
  const c000 = hash(hash(seed, ix, iy), iz, 0) / 4294967296
  const c100 = hash(hash(seed, ix + 1, iy), iz, 0) / 4294967296
  const c010 = hash(hash(seed, ix, iy + 1), iz, 0) / 4294967296
  const c110 = hash(hash(seed, ix + 1, iy + 1), iz, 0) / 4294967296
  const c001 = hash(hash(seed, ix, iy), iz + 1, 0) / 4294967296
  const c101 = hash(hash(seed, ix + 1, iy), iz + 1, 0) / 4294967296
  const c011 = hash(hash(seed, ix, iy + 1), iz + 1, 0) / 4294967296
  const c111 = hash(hash(seed, ix + 1, iy + 1), iz + 1, 0) / 4294967296
  const x00 = c000 + (c100 - c000) * tx
  const x10 = c010 + (c110 - c010) * tx
  const x01 = c001 + (c101 - c001) * tx
  const x11 = c011 + (c111 - c011) * tx
  const y0 = x00 + (x10 - x00) * ty, y1 = x01 + (x11 - x01) * ty
  return y0 + (y1 - y0) * tz
}

const _hotSwapPlacementChart = (next) => {
  latticeFor = next.latticeFor
  ringAroundLocal = next.ringAroundLocal
  chunkKeyAtLocal = next.chunkKeyAtLocal
  chunkCentreLocal = next.chunkCentreLocal
  chunkBoundsLocal = next.chunkBoundsLocal
  surfaceAlongDir = next.surfaceAlongDir
  tangentFrame = next.tangentFrame
  createTangentFrame = next.createTangentFrame
  tangentFrameInto = next.tangentFrameInto
  tangentToLocalInto = next.tangentToLocalInto
  tangentFrameQuatInto = next.tangentFrameQuatInto
  quatMulF32Into = next.quatMulF32Into
  radialSlopeInto = next.radialSlopeInto
  tangentToLocal = next.tangentToLocal
  tangentHeadingInChart = next.tangentHeadingInChart
  tangentFrameQuat = next.tangentFrameQuat
  quatMulF32 = next.quatMulF32
  radialSlopeAt = next.radialSlopeAt
  climateAt = next.climateAt
  seaLocalXZ = next.seaLocalXZ
  valueNoise3 = next.valueNoise3
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapPlacementChart)
