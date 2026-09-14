export const DEFAULT_PATCH_MAX_LEVEL = 11

const SURFACE_SOLVE_MAX_EVALS = 8
const RENDER_F32_HALF_ULP_REL = 2 ** -24

const _norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l] }
const _add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const _scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s]
const _cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

export function sphereDropBelowTangent(r2, sphereRadius) {
  const q = sphereRadius * sphereRadius - r2
  return q > 0 ? r2 / (sphereRadius + Math.sqrt(q)) : sphereRadius
}

function _frameRadius(frame) {
  return Number.isFinite(frame.radius) && frame.radius > 0 ? frame.radius : Infinity
}

export function sphereSurfaceLocalY(frame, x, z, elevation) {
  if (!frame || !Number.isFinite(frame.offsetY) || !Number.isFinite(frame.anchorHeight) || !Number.isFinite(elevation)) return null
  const radius = _frameRadius(frame)
  const drop = radius === Infinity ? 0 : sphereDropBelowTangent(x * x + z * z, radius + elevation)
  return frame.offsetY + (elevation - frame.anchorHeight) - drop
}

export function waterlineLocalY(frame, x, z) {
  return sphereSurfaceLocalY(frame, x, z, 0)
}

export function elevationAtLocal(frame, x, y, z) {
  if (!frame || !Number.isFinite(frame.offsetY) || !Number.isFinite(frame.anchorHeight)) return null
  const radius = _frameRadius(frame)
  if (radius === Infinity) return y - frame.offsetY + frame.anchorHeight
  const t = radius + frame.anchorHeight + (y - frame.offsetY)
  const r2 = x * x + z * z
  const l = Math.sqrt(t * t + r2)
  return (t - radius) + r2 / (l + t)
}

export function createPlanetFrame({ sampler, anchorDir = [0, 1, 0], offsetY = 0, reliefScale }) {
  const radius = sampler.radius
  const _reliefScale = (reliefScale != null) ? reliefScale : 0.01
  const up = _norm(anchorDir)
  const ref = Math.abs(up[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0]
  const east = _norm(_cross(ref, up))
  const north = _cross(east, up)
  const anchorHeight = sampler.heightAt(up)
  const _e0 = east[0], _e1 = east[1], _e2 = east[2]
  const _n0 = north[0], _n1 = north[1], _n2 = north[2]
  const _u0 = up[0], _u1 = up[1], _u2 = up[2]
  const _solveTolTimesR = radius * RENDER_F32_HALF_ULP_REL * radius
  function renderDirAt(x, renderY, z) {
    const t = radius + anchorHeight + renderY
    const ax = _u0 * t + _e0 * x + _n0 * z
    const ay = _u1 * t + _e1 * x + _n1 * z
    const az = _u2 * t + _e2 * x + _n2 * z
    const l = Math.hypot(ax, ay, az) || 1
    return [ax / l, ay / l, az / l]
  }
  function renderYOnSphere(r2, elevation) {
    return (elevation - anchorHeight) - sphereDropBelowTangent(r2, radius + elevation)
  }
  function localToDir(x, z, y) {
    const renderY = (y === undefined) ? renderYOnSphere(x * x + z * z, 0) : y - offsetY
    return renderDirAt(x, renderY, z)
  }
  function solveSurfaceY(x, z, heightAtDir) {
    const r2 = x * x + z * z, r = Math.sqrt(r2)
    let y = renderYOnSphere(r2, 0), yPrev = 0, gPrev = 0
    let belowSurface = -Infinity, aboveSurface = Infinity
    let bestY = null, bestG = Infinity
    for (let k = 0; k < SURFACE_SOLVE_MAX_EVALS; k++) {
      const h = heightAtDir(renderDirAt(x, y, z))
      if (h == null || !Number.isFinite(h)) return null
      const yF = renderYOnSphere(r2, h)
      const g = yF - y
      if (Math.abs(g) < bestG) { bestG = Math.abs(g); bestY = yF }
      if (Math.abs(g) * r <= _solveTolTimesR) return yF
      if (g > 0) belowSurface = Math.max(belowSurface, y)
      else aboveSurface = Math.min(aboveSurface, y)
      let yNext = (k > 0 && g !== gPrev) ? y - g * (y - yPrev) / (g - gPrev) : yF
      if (!(yNext > belowSurface && yNext < aboveSurface)) {
        yNext = (belowSurface > -Infinity && aboveSurface < Infinity) ? 0.5 * (belowSurface + aboveSurface) : yF
      }
      yPrev = y; gPrev = g; y = yNext
    }
    return bestY
  }
  function groundHeightLocal(x, z) {
    const y = solveSurfaceY(x, z, (d) => sampler.heightAt(d))
    return y == null ? NaN : y + offsetY
  }
  const anchorSurfaceWorld = _scale(up, radius + anchorHeight)
  function localToWorld(x, y, z) {
    const surf = _add(_scale(up, radius + anchorHeight + y), _add(_scale(east, x), _scale(north, z)))
    return surf
  }
  return { radius, up, east, north, anchorDir: up, anchorHeight, anchorSurfaceWorld, offsetY, reliefScale: _reliefScale, localToDir, solveSurfaceY, groundHeightLocal, localToWorld }
}
