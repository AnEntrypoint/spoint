import { MeshBasicNodeMaterial } from 'three/webgpu'
import {
  Fn, vec2, vec3, vec4, float, texture, uv,
  normalLocal, normalWorld, normalMap, bumpMap,
  packNormalToRGB, depth, vertexColor, mrt, Discard
} from 'three/tsl'

export function makeAtlasCaptureMaterialTSL(sourceMaterial) {
  const hasMap = !!sourceMaterial.map
  const hasAlphaMap = !!sourceMaterial.alphaMap
  const hasNormalMap = !!sourceMaterial.normalMap
  const hasBumpMap = !!sourceMaterial.bumpMap
  const isTransparent = !!sourceMaterial.transparent

  const material = new MeshBasicNodeMaterial({
    transparent: sourceMaterial.transparent,
    side: sourceMaterial.side,
    alphaHash: sourceMaterial.alphaHash,
    depthFunc: sourceMaterial.depthFunc,
    depthWrite: sourceMaterial.depthWrite,
    depthTest: sourceMaterial.depthTest,
    vertexColors: sourceMaterial.vertexColors,
    precision: sourceMaterial.precision,
    visible: sourceMaterial.visible
  })
  material.toneMapped = false

  const albedoOutput = Fn(() => {
    const baseColor = vec3(sourceMaterial.color.r, sourceMaterial.color.g, sourceMaterial.color.b)
    const diffuse = baseColor.toVar()
    const alpha = float(sourceMaterial.opacity).toVar()
    if (sourceMaterial.vertexColors) diffuse.assign(diffuse.mul(vertexColor().rgb))
    if (hasMap) {
      const mapSample = texture(sourceMaterial.map, uv())
      diffuse.assign(diffuse.mul(mapSample.rgb))
      alpha.assign(alpha.mul(mapSample.a))
    }
    if (hasAlphaMap) alpha.assign(alpha.mul(texture(sourceMaterial.alphaMap, uv()).r))

    Discard(alpha.lessThanEqual(0.2))
    if (!isTransparent) alpha.assign(float(1.0))

    return vec4(diffuse, alpha)
  })()

  if (hasNormalMap) {
    const scale = vec2(sourceMaterial.normalScale.x, sourceMaterial.normalScale.y)
    material.normalNode = normalMap(texture(sourceMaterial.normalMap, uv()), scale)
  } else if (hasBumpMap) {
    material.normalNode = bumpMap(texture(sourceMaterial.bumpMap, uv()), float(sourceMaterial.bumpScale))
  } else {
    material.normalNode = normalLocal
  }

  const normalDepthOutput = vec4(packNormalToRGB(normalWorld), float(1.0).sub(depth))

  material.mrtNode = mrt({ output: albedoOutput, normalDepth: normalDepthOutput })
  material.customProgramCacheKey = () => `octaimpostor-atlas-tsl_${hasMap}_${hasAlphaMap}_${hasNormalMap}_${hasBumpMap}_${isTransparent}`

  return material
}
