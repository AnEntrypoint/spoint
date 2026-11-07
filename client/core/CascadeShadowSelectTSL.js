import { Fn, float, uniform, positionWorld, cameraPosition, smoothstep, mix, shadow } from 'three/tsl'
import { CASCADE_BLEND_M } from './CascadeShadowSelect.js'

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

  cascadeLights[0].shadow.shadowNode = select

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
