import { elevationAtLocal } from '../terrain/PlanetFrame.js'

export const DEFAULT_CLEARANCE_M = 2
export const MAX_CLEARANCE_M = 500
export const MAX_ABS_COORD_M = 1e7
const MIN_UP_DOT = 0.05
const ELEVATION_REFINE_PASSES = 8
const ELEVATION_REFINE_TOL_M = 1e-3
const DEG = Math.PI / 180

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const isCoord = (v) => Number.isFinite(v) && Math.abs(v) <= MAX_ABS_COORD_M

export function latLonToDir(latDeg, lonDeg) {
  const la = latDeg * DEG, lo = lonDeg * DEG, c = Math.cos(la)
  return [c * Math.cos(lo), Math.sin(la), c * Math.sin(lo)]
}

export function dirToLatLon(d) {
  const l = Math.hypot(d[0], d[1], d[2]) || 1
  return { lat: Math.asin(d[1] / l) / DEG, lon: Math.atan2(d[2], d[0]) / DEG }
}

export function angleFromAnchorDeg(frame, dir) {
  const l = Math.hypot(dir[0], dir[1], dir[2]) || 1
  return Math.acos(Math.max(-1, Math.min(1, dot(dir, frame.up) / l))) / DEG
}

function rayMissM(frame, d, x, y, z) {
  const p = frame.localToDir(x, z, y)
  return frame.radius * Math.hypot(p[0] - d[0], p[1] - d[1], p[2] - d[2])
}

export function dirToLocalXZ(frame, dir, heightAt) {
  const l = Math.hypot(dir[0], dir[1], dir[2])
  if (!(l > 0)) return null
  const d = [dir[0] / l, dir[1] / l, dir[2] / l]
  if (!(dot(d, frame.up) > MIN_UP_DOT)) return null
  const dirElevation = typeof frame.elevationAtDir === 'function' ? frame.elevationAtDir(d) : null
  let elevation = Number.isFinite(dirElevation) ? dirElevation : frame.anchorHeight
  const de = dot(d, frame.east), dn = dot(d, frame.north)
  let x = (frame.radius + elevation) * de, z = (frame.radius + elevation) * dn
  if (typeof heightAt !== 'function') return [x, z]
  let bestX = x, bestZ = z, bestMiss = Infinity
  for (let i = 0; i < ELEVATION_REFINE_PASSES; i++) {
    const y = heightAt(x, z)
    const e = Number.isFinite(y) ? elevationAtLocal(frame, x, y, z) : null
    if (!Number.isFinite(e)) break
    const miss = rayMissM(frame, d, x, y, z)
    if (miss < bestMiss) { bestMiss = miss; bestX = x; bestZ = z }
    const nx = (frame.radius + e) * de, nz = (frame.radius + e) * dn
    const moved = Math.hypot(nx - x, nz - z)
    x = nx; z = nz
    if (moved < ELEVATION_REFINE_TOL_M) break
  }
  return [bestX, bestZ]
}

export function resolveTarget(spec, { frame, heightAt } = {}) {
  if (Array.isArray(spec)) spec = { x: spec[0], y: spec[1], z: spec[2] }
  if (!spec || typeof spec !== 'object') throw new Error('teleport target must be an object or [x,y,z]')
  const alt = spec.alt === undefined ? null : spec.alt
  if (alt !== null && !(Number.isFinite(alt) && Math.abs(alt) <= MAX_ABS_COORD_M)) throw new Error('teleport alt must be a finite number')
  let x, z, y = null
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
  }
  const clearance = spec.clearance === undefined ? (alt ?? DEFAULT_CLEARANCE_M) : spec.clearance
  if (!Number.isFinite(clearance) || clearance < 0 || clearance > MAX_CLEARANCE_M) throw new Error(`teleport clearance must be within 0..${MAX_CLEARANCE_M}`)
  const snap = spec.snap === 'first' ? 'first' : 'terrain'
  return { x, y, z, clearance, snap }
}
