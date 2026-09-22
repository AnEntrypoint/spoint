import {
  Fn, uniform, mat3, modelWorldMatrix, normalLocal, normalize,
  vec3, vec4, float, clamp, max, pow, dot, mix, smoothstep,
} from 'three/tsl'

export const wetnessUniform = uniform(0)

function buildWetUpFacingNode() {
  return clamp(dot(normalize(mat3(modelWorldMatrix).mul(normalLocal)), vec3(0.0, 1.0, 0.0)), 0.0, 1.0)
}

export const wetSpecularContribution = Fn(([normalW, lightDir, lightColor, viewDir]) => {
  const halfV = normalize(lightDir.add(viewDir))
  return pow(max(dot(normalW, halfV), 0.0), 28.0).mul(dot(lightColor, vec3(0.3333)))
})

function buildWetnessMixNode(baseNode, specSumNode, wetU) {
  return Fn(() => {
    const wetUpFacing = buildWetUpFacingNode().toVar()
    const wetAmt = wetU.mul(smoothstep(0.0, 0.2, wetUpFacing))
    const darkened = baseNode.rgb.mul(mix(float(1.0), float(0.68), wetAmt))
    const specAdd = specSumNode.mul(wetAmt).mul(wetUpFacing).mul(1.4).mul(vec3(1.0, 1.0, 0.95))
    const rgb = wetU.greaterThan(0.001).select(darkened.add(specAdd), baseNode.rgb)
    return vec4(rgb, baseNode.a)
  })()
}

export function applyWetnessTintNode(material, specSumNode = float(0.0), wetU = wetnessUniform) {
  const base = material.outputNode || vec4(material.colorNode || vec3(1, 1, 1), material.opacityNode || float(1))
  material.outputNode = buildWetnessMixNode(base, specSumNode, wetU)
  material.needsUpdate = true
  return material.outputNode
}

export function setWetness(w, wetU = wetnessUniform) {
  const v = Number.isFinite(w) ? Math.min(1, Math.max(0, w)) : 0
  wetU.value = v
  if (typeof window !== 'undefined') window.__wetness = v
}
