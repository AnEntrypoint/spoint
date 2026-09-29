import { createPlacementLattice } from './PlacementLattice.js'

const SURFACE_LATERAL_TOL_M = 1e-4
const SURFACE_LATERAL_ACCEPT_M = 1e-2
const SURFACE_MAX_ITERS = 16
const POLE_REF_SWITCH = 0.99

const _lattices = new Map()
export function latticeFor(frame, spec) {
  const k = frame.radius + ':' + spec.CHUNK + ':' + spec.GRID
  let l = _lattices.get(k)
  if (!l) { l = createPlacementLattice(frame.radius, spec.CHUNK, spec.GRID); _lattices.set(k, l) }
  return l
}

export function ringAroundLocal(lattice, frame, x, z, radiusM) {
  const d = frame.localToDir(x, z)
  return lattice.ringAroundDir(d[0], d[1], d[2], radiusM)
}

export function chunkKeyAtLocal(lattice, frame, x, z) {
  const d = frame.localToDir(x, z)
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
export function chunkBoundsLocal(lattice, frame, key, placements) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
  for (const [cu, cv] of CORNERS) {
    lattice.chunkCornerDir(key, cu, cv, _cd)
    const x = frame.radius * dotE(frame, _cd[0], _cd[1], _cd[2]), z = frame.radius * dotN(frame, _cd[0], _cd[1], _cd[2])
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  if (placements) for (let i = 0; i < placements.length; i++) {
    const p = placements[i]
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z
  }
  return [minX, minZ, maxX, maxZ]
}

export function surfaceAlongDir(frame, dx, dy, dz, rhoGuess, out) {
  const de = dotE(frame, dx, dy, dz), du = dotU(frame, dx, dy, dz), dn = dotN(frame, dx, dy, dz)
  const base = frame.radius + frame.anchorHeight - frame.offsetY
  if (frame.groundHeightLocal === frame.cpuGroundHeightLocal) {
    const h = frame.elevationAtDir([dx, dy, dz])
    if (!Number.isFinite(h)) return NaN
    const r = frame.radius + h
    out[0] = r * de; out[1] = r * du - base; out[2] = r * dn
    return r
  }
  let rho = rhoGuess, bestRho = NaN, bestLateral2 = Infinity
  for (let k = 0; k < SURFACE_MAX_ITERS; k++) {
    const x = rho * de, z = rho * dn
    const y = frame.groundHeightLocal(x, z)
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

export function tangentFrame(frame, dx, dy, dz) {
  const refY = Math.abs(dy) < POLE_REF_SWITCH
  let ex = refY ? dz : 0, ey = refY ? 0 : -dz, ez = refY ? -dx : dy
  const el = Math.hypot(ex, ey, ez); ex /= el; ey /= el; ez /= el
  const nx = ey * dz - ez * dy, ny = ez * dx - ex * dz, nz = ex * dy - ey * dx
  return {
    east: [ex, ey, ez], north: [nx, ny, nz], up: [dx, dy, dz],
    eastL: [dotE(frame, ex, ey, ez), dotU(frame, ex, ey, ez), dotN(frame, ex, ey, ez)],
    upL: [dotE(frame, dx, dy, dz), dotU(frame, dx, dy, dz), dotN(frame, dx, dy, dz)],
    northL: [dotE(frame, nx, ny, nz), dotU(frame, nx, ny, nz), dotN(frame, nx, ny, nz)],
  }
}

export function tangentToLocal(tf, a, b, c) {
  const e = tf.eastL, u = tf.upL, n = tf.northL
  return [e[0] * a + u[0] * b + n[0] * c, e[1] * a + u[1] * b + n[1] * c, e[2] * a + u[2] * b + n[2] * c]
}

export function tangentHeadingInChart(tf) {
  return Math.atan2(-tf.eastL[2], tf.eastL[0])
}

export function tangentFrameQuat(tf) {
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
  return [x, y, z, w]
}

export function quatMulF32(a, b) {
  return [
    Math.fround(a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1]),
    Math.fround(a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0]),
    Math.fround(a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3]),
    Math.fround(a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]),
  ]
}

const _probe = [0, 0, 0]
export function radialSlopeAt(frame, tf, rho, stepM) {
  const d = tf.up, e = tf.east, n = tf.north
  const r = (sx, sz) => {
    const px = d[0] * rho + e[0] * sx + n[0] * sz, py = d[1] * rho + e[1] * sx + n[1] * sz, pz = d[2] * rho + e[2] * sx + n[2] * sz
    const l = Math.hypot(px, py, pz)
    return surfaceAlongDir(frame, px / l, py / l, pz / l, rho, _probe)
  }
  const ex1 = r(stepM, 0), ex0 = r(-stepM, 0), nz1 = r(0, stepM), nz0 = r(0, -stepM)
  if (!Number.isFinite(ex1) || !Number.isFinite(ex0) || !Number.isFinite(nz1) || !Number.isFinite(nz0)) return null
  return [(ex1 - ex0) / (2 * stepM), (nz1 - nz0) / (2 * stepM)]
}

export function climateAt(anchorField, x, z, d) {
  if (!anchorField) return null
  return anchorField.climateAtLocal ? anchorField.climateAtLocal(x, z, d) : anchorField.sampleDir(d)
}

export function valueNoise3(hash, seed, px, py, pz, cellM) {
  const fx = px / cellM, fy = py / cellM, fz = pz / cellM
  const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz)
  let tx = fx - ix, ty = fy - iy, tz = fz - iz
  tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty); tz = tz * tz * (3 - 2 * tz)
  const c = (ox, oy, oz) => hash(hash(seed, ix + ox, iy + oy), iz + oz, 0) / 4294967296
  const x00 = c(0, 0, 0) + (c(1, 0, 0) - c(0, 0, 0)) * tx
  const x10 = c(0, 1, 0) + (c(1, 1, 0) - c(0, 1, 0)) * tx
  const x01 = c(0, 0, 1) + (c(1, 0, 1) - c(0, 0, 1)) * tx
  const x11 = c(0, 1, 1) + (c(1, 1, 1) - c(0, 1, 1)) * tx
  const y0 = x00 + (x10 - x00) * ty, y1 = x01 + (x11 - x01) * ty
  return y0 + (y1 - y0) * tz
}
