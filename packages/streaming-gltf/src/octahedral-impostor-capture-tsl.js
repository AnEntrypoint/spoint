import { MeshBasicNodeMaterial, Color } from 'three/webgpu'
import { Fn, float, vec4, texture, uniform, uv, attribute, mrt, modelViewProjection, transformedNormalView } from 'three/tsl'

const ALPHA_CUTOFF = 0.2

export function makeCaptureMaterialTSL(source) {
  const material = new MeshBasicNodeMaterial()
  material.name = 'impostor-atlas-capture-tsl'
  material.side = source.side
  material.alphaTest = ALPHA_CUTOFF
  material.transparent = false
  if (source.normalMap) material.normalMap = source.normalMap

  const diffuse = uniform(source.color ? source.color.clone() : new Color(1, 1, 1))
  const opacity = uniform(source.opacity != null ? source.opacity : 1)

  const albedo = Fn(() => {
    let c = vec4(diffuse, opacity)
    if (source.map) c = c.mul(texture(source.map, uv()))
    if (source.vertexColors) c = c.mul(vec4(attribute('color', 'vec3'), 1.0))
    return c
  })()

  const depth01 = modelViewProjection.z.div(modelViewProjection.w)

  material.colorNode = albedo
  material.mrtNode = mrt({
    output: albedo,
    normalDepth: vec4(transformedNormalView.mul(0.5).add(0.5), float(1.0).sub(depth01)),
  })
  return material
}
