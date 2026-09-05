// World<->planet coordinate mapping; single source of truth shared by client render, server physics, entity placement.

// mapspinner/patch-baker.js's createPatchHeightFn has its own internal default (maxLevel = 11) for the
// GPU-patch quadtree depth used by both the client render-height override (TerrainBackdrop.js) and the
// server collider bake (TerrainPhysics.js's createGpuPatchHeightFn). Both call sites must pass the SAME
// value when cfg.maxLevel/tcfg.maxLevel is unset, or client render height and server collider height
// desync (the exact gridMeshSize-drift failure class) -- so spoint owns one copy of that fallback here
// instead of each call site re-hardcoding its own literal 11.
export const DEFAULT_PATCH_MAX_LEVEL = 11

const _norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l] }
const _add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const _scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s]
const _cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

export function createPlanetFrame({ sampler, anchorDir = [0, 1, 0], offsetY = 0, reliefScale }) {
  const radius = sampler.radius
  const _reliefScale = (reliefScale != null) ? reliefScale : 0.01
  const up = _norm(anchorDir)
  // cross(ref,up) not cross(up,ref): matches three's right-handed x-up=z; swapped order mirrors the frame and inverts camera yaw.
  const ref = Math.abs(up[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0]
  const east = _norm(_cross(ref, up))
  const north = _cross(east, up)
  const anchorHeight = sampler.heightAt(up)
  // Scalar form of _norm(_add(up, _scale(_add(_scale(east,x), _scale(north,z)), 1/radius))): same
  // per-component op order, so bit-identical (verified over 200k random (x,z) at the tps-game frame),
  // but 6 intermediate arrays per call become 1. localToDir is the per-tap entry point of the whole
  // placement/collider path (5 taps per veg/rock/grass candidate via groundHeightLocal, plus every
  // patch-baker heightFn/prefetchAround lookup and ClimateCache sector miss). Still returns a FRESH
  // array -- callers (ClimateCache.atSector, patch-baker.dirToFace) hold it past the call, so a shared
  // module scratch would alias.
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
  // drop term uses the catastrophic-cancellation-safe r2/R/((sqrt(1+s)+1)sqrt(1+s)) form; must be exactly 0 at (0,0).
  function groundHeightLocal(x, z) {
    const d = localToDir(x, z)
    const r2 = x * x + z * z
    const s = r2 / _radius2
    const sq = Math.sqrt(1 + s)
    const drop = r2 / radius / ((sq + 1) * sq)
    return (sampler.heightAt(d) - anchorHeight) - drop + offsetY
  }
  const anchorSurfaceWorld = _scale(up, radius + anchorHeight)
  function localToWorld(x, y, z) {
    const surf = _add(_scale(up, radius + anchorHeight + y), _add(_scale(east, x), _scale(north, z)))
    return surf
  }
  return { radius, up, east, north, anchorDir: up, anchorHeight, anchorSurfaceWorld, offsetY, reliefScale: _reliefScale, localToDir, groundHeightLocal, localToWorld }
}
