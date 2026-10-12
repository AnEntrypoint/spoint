import { Fn, float, uniform, positionWorld, cameraPosition, smoothstep, mix, shadow } from 'three/tsl'
import { CASCADE_BLEND_M } from './CascadeShadowSelect.js'

// Cascades 1..n are DirectionalLights with intensity 0: they exist only to own a shadow map and a
// shadow camera. three's node lighting folds a light's shadow into THAT light's own contribution
// (`shadowColorNode = colorNode.mul(shadowNode)`), so weighting a cascade's shadow inside its own
// light multiplies it into zero intensity and shows nothing at all -- and the sun's own weight
// fades to 0 past cascade 0's extent, so past it the sun is fully lit and unshadowed.
//
// The selection therefore has to be installed on the SUN (cascade 0, the only cascade carrying
// light) as a fold that picks the cascade map by camera-distance band. Inside cascade 0's band the
// fold is exactly `shadow(cascade0)`, so the near field keeps the previous behaviour bit for bit.
export function installCascadeShadowSelectTSL(cascadeLights, splitExtents) {
  if (!Array.isArray(cascadeLights) || cascadeLights.length <= 1) return null

  const blend = uniform(CASCADE_BLEND_M)
  const maps = cascadeLights.map((light) => shadow(light))
  const edges = cascadeLights.map((light, idx) => uniform((splitExtents && splitExtents[idx]) || 0))

  const select = Fn(() => {
    const camDist = positionWorld.sub(cameraPosition).length()
    const s = float(maps[0]).toVar()
    for (let i = 1; i < maps.length; i++) {
      const edge = edges[i - 1]
      s.assign(mix(s, maps[i], smoothstep(edge.sub(blend), edge, camDist)))
    }
    return s
  })()

  // Only the sun gets a custom shadow node. The extra cascades keep three's default, which is what
  // makes their shadow maps get rendered and updated at all.
  cascadeLights[0].shadow.shadowNode = select

  const state = cascadeLights.map((light, idx) => ({
    light,
    farEdge: edges[idx],
    nearEdge: idx > 0 ? edges[idx - 1] : null,
  }))

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
  state.forEach(({ farEdge }, idx) => {
    farEdge.value = extents[idx] || 0
  })
}

export function isCascadeShadowSelectTSLInstalled(state) {
  return Array.isArray(state) && state.length > 0
}
