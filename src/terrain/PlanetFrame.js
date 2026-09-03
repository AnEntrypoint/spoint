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
  function localToDir(x, z) {
    return _norm(_add(up, _scale(_add(_scale(east, x), _scale(north, z)), 1 / radius)))
  }
  // drop term uses the catastrophic-cancellation-safe r2/R/((sqrt(1+s)+1)sqrt(1+s)) form; must be exactly 0 at (0,0).
  function groundHeightLocal(x, z) {
    const d = localToDir(x, z)
    const r2 = x * x + z * z
    const s = r2 / (radius * radius)
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
