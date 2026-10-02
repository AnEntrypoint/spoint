import { DataTexture, RedFormat, FloatType, NearestFilter, ClampToEdgeWrapping, Vector2, Vector3 } from 'three/webgpu'
import { uniform, vec2, float, dot, max, texture, select } from 'three/tsl'

export const SCULPT_RES = 256

export function createSculptOverrideTSL({ defRadius }) {
  const data = new Float32Array(SCULPT_RES * SCULPT_RES)
  const tex = new DataTexture(data, SCULPT_RES, SCULPT_RES, RedFormat, FloatType)
  tex.minFilter = NearestFilter
  tex.magFilter = NearestFilter
  tex.wrapS = ClampToEdgeWrapping
  tex.wrapT = ClampToEdgeWrapping
  tex.needsUpdate = true
  const active = uniform(0)
  const up = uniform(new Vector3(0, 1, 0))
  const east = uniform(new Vector3(1, 0, 0))
  const north = uniform(new Vector3(0, 0, 1))
  const center = uniform(new Vector2())
  const extent = uniform(1)

  function clear() { active.value = 0 }

  function set(centerXZ, ext, frameBasis, heights) {
    const okBasis = frameBasis && frameBasis.up && frameBasis.east && frameBasis.north
    const finite = centerXZ && Number.isFinite(centerXZ[0]) && Number.isFinite(centerXZ[1]) && Number.isFinite(ext) && ext > 0
    if (!okBasis || !finite) { clear(); return }
    if (heights && heights.length !== data.length) { clear(); return }
    if (heights) { data.set(heights); tex.needsUpdate = true }
    center.value.set(centerXZ[0], centerXZ[1])
    extent.value = ext
    up.value.set(frameBasis.up[0], frameBasis.up[1], frameBasis.up[2])
    east.value.set(frameBasis.east[0], frameBasis.east[1], frameBasis.east[2])
    north.value.set(frameBasis.north[0], frameBasis.north[1], frameBasis.north[2])
    active.value = 1
  }

  const op = (dir0, hBase) => {
    const surfR = defRadius.add(hBase)
    const rel = vec2(surfR.mul(dot(dir0, east)), surfR.mul(dot(dir0, north))).sub(center)
    const uv = rel.div(max(extent, float(1.0)).mul(2.0)).add(0.5)
    const inside = uv.x.greaterThanEqual(0.0).and(uv.x.lessThanEqual(1.0))
      .and(uv.y.greaterThanEqual(0.0)).and(uv.y.lessThanEqual(1.0))
      .and(dot(dir0, up).greaterThan(0.0)).and(active.greaterThan(0.5))
    return select(inside, texture(tex, uv, 0).x, float(0.0))
  }

  return { op, set, clear, texture: tex, uniforms: { active, up, east, north, center, extent } }
}
