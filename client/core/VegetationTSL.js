import { Fn, uniform, attribute, positionLocal, positionGeometry, sin, cos, vec3, vec4, materialColor } from 'three/tsl'

export function makeWindUniformsTSL() {
  return { uVegTime: uniform(0), uVegWind: uniform(1) }
}

export function tickWindTSL(wind, dt) {
  wind.uVegTime.value += dt
  if (typeof window !== 'undefined' && window.__vegWind != null) wind.uVegWind.value = +window.__vegWind
}

export function buildWindPositionNode(wind) {
  return Fn(() => {
    const windPhase = attribute('windPhase', 'float')
    const wsway = positionGeometry.y.mul(0.06)
    const wph = wind.uVegTime.mul(1.3).add(windPhase)
    const swayX = sin(wph).mul(wsway).mul(wind.uVegWind)
    const swayZ = cos(wph.mul(0.8)).mul(wsway).mul(0.6).mul(wind.uVegWind)
    return vec3(positionLocal.x.add(swayX), positionLocal.y, positionLocal.z.add(swayZ))
  })()
}

export function applyWindTSL(material, wind) {
  material.positionNode = buildWindPositionNode(wind)
  material.customProgramCacheKey = () => 'vegwind3tsl'
  return material
}

export function applyTintTSL(material) {
  material.colorNode = Fn(() => {
    const tint = attribute('tint', 'float')
    return vec4(materialColor.rgb.mul(tint), materialColor.a)
  })()
  return material
}
