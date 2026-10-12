import { Fn, float, uniform, positionWorld, cameraPosition, smoothstep, mix, shadow } from 'three/tsl'
import { CASCADE_BLEND_M } from './CascadeShadowSelect.js'

// Cascades 1..n are DirectionalLights with intensity 0: they exist only to own a shadow map and a
// shadow camera. three's node lighting folds a light's shadow into THAT light's own contribution
// (`AnalyticLightNode.setupShadow`: `shadowColorNode = colorNode.mul(shadowNode)`, and
// `colorNode` is `light.color * light.intensity`), so a cascade's own shadow is always multiplied
// into zero and can never darken a pixel.
//
// The selection therefore has to be installed on the SUN (cascade 0, the only cascade carrying
// light) as a fold that picks the cascade map by camera-distance band. Inside cascade 0's band the
// fold is exactly `shadow(cascade0)`, so the near field keeps the previous behaviour bit for bit;
// past each split the fold selects the NEXT cascade's map rather than fading to 1, so the sun does
// not go unshadowed at a split.
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

  // Only the sun gets the fold -- it is the only cascade whose shadow can reach the screen.
  cascadeLights[0].shadow.shadowNode = select

  // Cascades 1..n also get a shadow node, but the SAME one the fold samples, not a fresh one.
  // three gives every scene light an AnalyticLightNode, and that node builds its own ShadowNode
  // for the light's LightShadow unless `light.shadow.shadowNode` is already set. Two ShadowNodes
  // over one LightShadow means two render targets and two independent per-fragment shadow samples
  // for one cascade, where the cascade's own sample is then multiplied by its zero intensity and
  // discarded. Pointing it at `maps[i]` collapses both: one render target, one sample, and the
  // fold still reads the same map it always did. (`shadow.needsUpdate` lives on the shared
  // LightShadow, so a second node would also never render -- the second target stays unwritten.)
  for (let i = 1; i < cascadeLights.length; i++) cascadeLights[i].shadow.shadowNode = maps[i]

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
