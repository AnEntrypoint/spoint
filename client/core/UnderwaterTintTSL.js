import * as THREE from 'three'
import {
  Fn, uniform, positionWorld, cameraPosition,
  vec2, vec3, vec4, float, clamp, max, sqrt, dot, mix,
} from 'three/tsl'

const SUBMERGE_MARGIN_M = 2.0
const CAM_ABOVE_WATER_TINT_LIMIT_M = 3.0

export const seaUniform = uniform(new THREE.Vector4(-100000, 0, 0, 0))
export const seaShiftUniform = uniform(new THREE.Vector3(0, 0, 0))

function buildSeaSurfaceYNode(seaU, seaShiftU) {
  return Fn(([renderPos]) => {
    const a = vec2(renderPos.x.add(seaShiftU.x), renderPos.z.add(seaShiftU.z))
    const r2 = dot(a, a)
    const rho = seaU.y
    const drop = rho.greaterThan(0.0).select(
      r2.div(rho.add(sqrt(max(rho.mul(rho).sub(r2), 0.0)))),
      float(0.0),
    )
    return seaU.x.sub(seaShiftU.y).sub(drop)
  })
}

function buildUnderwaterMixNode(baseNode, seaU, seaShiftU) {
  const seaSurfaceY = buildSeaSurfaceYNode(seaU, seaShiftU)
  return Fn(() => {
    const worldY = positionWorld.y
    const seaYAtFrag = seaSurfaceY(positionWorld).toVar()
    const seaYAtCam = seaSurfaceY(cameraPosition)
    const camGate = seaU.z.greaterThan(0.5).and(cameraPosition.y.lessThan(seaYAtCam.add(CAM_ABOVE_WATER_TINT_LIMIT_M)))
    const submerged = worldY.lessThan(seaYAtFrag.sub(SUBMERGE_MARGIN_M))
    const gate = camGate.and(submerged)
    const dSub = clamp(seaYAtFrag.sub(SUBMERGE_MARGIN_M).sub(worldY).mul(0.08), 0.0, 0.6)
    const tinted = mix(baseNode.rgb.mul(vec3(0.30, 0.55, 0.65)), vec3(0.04, 0.34, 0.52), dSub)
    const rgb = gate.select(tinted, baseNode.rgb)
    return vec4(rgb, baseNode.a)
  })()
}

export function applyUnderwaterTintNode(material, seaU = seaUniform, seaShiftU = seaShiftUniform) {
  const base = material.outputNode || vec4(material.colorNode || vec3(1, 1, 1), material.opacityNode || float(1))
  material.outputNode = buildUnderwaterMixNode(base, seaU, seaShiftU)
  material.needsUpdate = true
  return material.outputNode
}

export function setSeaLevelY(seaY, planetRadius, seaU = seaUniform) {
  if (Number.isFinite(planetRadius) && planetRadius > 0) seaU.value.y = planetRadius
  if (!Number.isFinite(seaY)) return
  seaU.value.x = seaY
  seaU.value.z = 1
  if (typeof window !== 'undefined') window.__seaLevelY = seaY
}

export function syncSeaFloatingOriginShift(seaShiftU = seaShiftUniform) {
  const fo = typeof window !== 'undefined' && window.__floatingOrigin
  const s = fo && typeof fo.getShift === 'function' ? fo.getShift() : null
  if (!s) return
  seaShiftU.value.set(s.x, s.y, s.z)
}
