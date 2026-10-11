import { elevationAtLocal } from '../terrain/PlanetFrame.js'

export const DEFAULT_CLEARANCE_M = 2
export const MAX_CLEARANCE_M = 500
export const MAX_ABS_COORD_M = 1e7
const MIN_UP_DOT = 0.05
const ELEVATION_REFINE_TOL_M = 1e-3
const ELEVATION_BRACKET_PASSES = 16
const ELEVATION_BISECT_PASSES = 64
const DEG = Math.PI / 180

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const isCoord = (v) => Number.isFinite(v) && Math.abs(v) <= MAX_ABS_COORD_M

export function latLonToDir(latDeg, lonDeg) {
  const la = latDeg * DEG, lo = lonDeg * DEG, c = Math.cos(la)
  return [c * Math.cos(lo), Math.sin(la), c * Math.sin(lo)]
}

export function parseDir3(value, what = 'dir') {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) throw new TypeError(`${what} must be [x,y,z] finite`)
  const length = Math.hypot(value[0], value[1], value[2])
  if (!(length > 0)) throw new TypeError(`${what} must name a direction; the zero vector names no point on the planet`)
  return { dir: [value[0] / length, value[1] / length, value[2] / length], length }
}

export function dirToLatLon(d) {
  const { dir } = parseDir3(d)
  return { lat: Math.asin(dir[1]) / DEG, lon: Math.atan2(dir[2], dir[0]) / DEG }
}

export function angleFromAnchorDeg(frame, dir) {
  const { dir: unit } = parseDir3(dir)
  return Math.acos(Math.max(-1, Math.min(1, dot(unit, frame.up)))) / DEG
}

function rayMissM(frame, d, x, y, z) {
  const p = frame.localToDir(x, z, y)
  return frame.radius * Math.hypot(p[0] - d[0], p[1] - d[1], p[2] - d[2])
}

export function dirToLocalXZ(frame, dir, heightAt) {
  const { dir: d } = parseDir3(dir, 'teleport dir')
  if (!(dot(d, frame.up) > MIN_UP_DOT)) return null
  const seedReader = typeof frame.cpuElevationAtDir === 'function' ? frame.cpuElevationAtDir : frame.elevationAtDir
  const dirElevation = typeof seedReader === 'function' ? seedReader(d) : null
  let elevation = Number.isFinite(dirElevation) ? dirElevation : frame.anchorHeight
  const de = dot(d, frame.east), dn = dot(d, frame.north)
  const seed = frame.radius + elevation
  let x = seed * de, z = seed * dn
  if (typeof heightAt !== 'function') return [x, z]
  const probe = (s) => {
    const px = s * de, pz = s * dn
    const y = heightAt(px, pz)
    if (!Number.isFinite(y)) return null
    const e = elevationAtLocal(frame, px, y, pz)
    if (!Number.isFinite(e)) return null
    return { s: frame.radius + e, x: px, z: pz, y }
  }
  let bestX = x, bestZ = z, bestMiss = Infinity
  let s = seed, prevS = 0, prevG = 0
  let lo = 0, hi = 0, gLo = 0
  for (let i = 0; i < ELEVATION_BRACKET_PASSES; i++) {
    const p = probe(s)
    if (!p) break
    const miss = rayMissM(frame, d, p.x, p.y, p.z)
    if (miss < bestMiss) { bestMiss = miss; bestX = p.x; bestZ = p.z }
    const g = p.s - s
    if (Math.abs(g) < ELEVATION_REFINE_TOL_M) return [p.x, p.z]
    if (i > 0 && ((prevG < 0) !== (g < 0))) {
      if (prevS < s) { lo = prevS; gLo = prevG; hi = s } else { lo = s; gLo = g; hi = prevS }
      break
    }
    prevS = s; prevG = g; s = p.s
  }
  for (let i = 0; i < ELEVATION_BISECT_PASSES && hi - lo > ELEVATION_REFINE_TOL_M; i++) {
    const mid = (lo + hi) / 2
    const p = probe(mid)
    if (!p) break
    const miss = rayMissM(frame, d, p.x, p.y, p.z)
    if (miss < bestMiss) { bestMiss = miss; bestX = p.x; bestZ = p.z }
    const g = p.s - mid
    if ((g < 0) === (gLo < 0)) { lo = mid; gLo = g } else { hi = mid }
  }
  return [bestX, bestZ]
}

export function resolveTarget(spec, { frame, heightAt } = {}) {
  if (Array.isArray(spec)) spec = { x: spec[0], y: spec[1], z: spec[2] }
  if (!spec || typeof spec !== 'object') throw new Error('teleport target must be an object or [x,y,z]')
  const alt = spec.alt === undefined ? null : spec.alt
  if (alt !== null && !isCoord(alt)) throw new Error('teleport alt must be a finite number')
  let x, z, y = null, standNearY = null
  if (spec.lat !== undefined || spec.lon !== undefined) {
    if (!Number.isFinite(spec.lat) || !Number.isFinite(spec.lon) || Math.abs(spec.lat) > 90) throw new Error('teleport lat/lon must be finite degrees, |lat| <= 90')
    if (!frame) throw new Error('teleport lat/lon needs a planet frame (world has no terrain)')
    const xz = dirToLocalXZ(frame, latLonToDir(spec.lat, spec.lon), heightAt)
    if (!xz) throw new Error(`teleport lat/lon is ${angleFromAnchorDeg(frame, latLonToDir(spec.lat, spec.lon)).toFixed(1)} deg from the anchor; the local frame reaches under ~87 deg`)
    ;[x, z] = xz
  } else if (spec.dir !== undefined) {
    if (!Array.isArray(spec.dir) || spec.dir.length !== 3 || !spec.dir.every(Number.isFinite)) throw new Error('teleport dir must be [x,y,z] finite')
    if (!frame) throw new Error('teleport dir needs a planet frame (world has no terrain)')
    const xz = dirToLocalXZ(frame, spec.dir, heightAt)
    if (!xz) throw new Error('teleport dir is beyond the local frame (over ~87 deg from the anchor)')
    ;[x, z] = xz
  } else {
    x = spec.x; z = spec.z; y = spec.y === undefined ? null : spec.y
    if (!isCoord(x) || !isCoord(z)) throw new Error('teleport needs finite x and z (|v| <= 1e7)')
    if (y !== null && !isCoord(y)) throw new Error('teleport y must be finite (|v| <= 1e7)')
    if (spec.standNearY !== undefined) {
      if (!isCoord(spec.standNearY)) throw new Error('teleport standNearY must be finite (|v| <= 1e7)')
      if (y !== null) throw new Error('teleport y and standNearY both name a height: state an exact y or a standNearY hint, not both')
      standNearY = spec.standNearY
    }
  }
  const clearance = spec.clearance === undefined ? (alt ?? DEFAULT_CLEARANCE_M) : spec.clearance
  if (!Number.isFinite(clearance) || clearance < 0 || clearance > MAX_CLEARANCE_M) throw new Error(`teleport clearance must be within 0..${MAX_CLEARANCE_M}`)
  const snap = spec.snap === 'first' ? 'first' : 'terrain'
  return { x, y, z, clearance, snap, standNearY }
}
