import { Fn, If, float, uniform, positionWorld, cameraPosition, smoothstep, mix, shadow } from 'three/tsl'

const BLEND_M = 4.0

export function installCascadeShadowSelectTSL(cascadeLights, splitExtents) {
  if (!Array.isArray(cascadeLights) || cascadeLights.length <= 1) return null

  const blend = uniform(BLEND_M)

  const state = cascadeLights.map((light, idx) => {
    const farEdge = uniform((splitExtents && splitExtents[idx]) || 0)
    const nearEdge = idx > 0 ? uniform((splitExtents && splitExtents[idx - 1]) || 0) : null
    const baseShadow = shadow(light)

    light.shadow.shadowNode = Fn(() => {
      const camDist = positionWorld.sub(cameraPosition).length()
      const w = float(1.0).toVar()

      If(farEdge.greaterThan(0.0), () => {
        w.mulAssign(float(1.0).sub(smoothstep(farEdge.sub(blend), farEdge, camDist)))
      })

      if (nearEdge !== null) {
        w.mulAssign(smoothstep(nearEdge.sub(blend), nearEdge, camDist))
      }

      return mix(float(1.0), baseShadow, w)
    })()

    return { light, farEdge, nearEdge }
  })

  if (typeof window !== 'undefined') {
    window.__cascadeShadowSelectTSL = {
      installed: true,
      cascadeCount: cascadeLights.length,
      setCascadeSplits: (extents) => setCascadeSplitsTSL(state, extents),
    }
  }

  return state
}

export function setCascadeSplitsTSL(state, extents) {
  if (!Array.isArray(state) || !Array.isArray(extents)) return
  state.forEach(({ farEdge, nearEdge }, idx) => {
    farEdge.value = extents[idx] || 0
    if (nearEdge) nearEdge.value = extents[idx - 1] || 0
  })
}

export function isCascadeShadowSelectTSLInstalled(state) {
  return Array.isArray(state) && state.length > 0
}
