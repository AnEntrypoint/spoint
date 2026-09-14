export const DEFAULT_PATCH_MAX_LEVEL = 11

const _norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l] }
const _add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const _scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s]
const _cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

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
  const _invR = 1 / radius, _radius2 = radius * radius
  function localToDir(x, z) {
    const ax = _u0 + (_e0 * x + _n0 * z) * _invR
    const ay = _u1 + (_e1 * x + _n1 * z) * _invR
    const az = _u2 + (_e2 * x + _n2 * z) * _invR
    const l = Math.hypot(ax, ay, az) || 1
    return [ax / l, ay / l, az / l]
  }
  function groundHeightLocal(x, z) {
    const d = localToDir(x, z)
    const r2 = x * x + z * z
    const s = r2 / _radius2
    const sq = Math.sqrt(1 + s)
    const curvatureDrop = r2 / radius / ((sq + 1) * sq)
    return (sampler.heightAt(d) - anchorHeight) - curvatureDrop + offsetY
  }
  const anchorSurfaceWorld = _scale(up, radius + anchorHeight)
  function localToWorld(x, y, z) {
    const surf = _add(_scale(up, radius + anchorHeight + y), _add(_scale(east, x), _scale(north, z)))
    return surf
  }
  return { radius, up, east, north, anchorDir: up, anchorHeight, anchorSurfaceWorld, offsetY, reliefScale: _reliefScale, localToDir, groundHeightLocal, localToWorld }
}
