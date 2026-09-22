import { MeshStandardNodeMaterial } from 'three/webgpu'
import {
  Fn, If, Discard, vec2, vec3, vec4, float, mat3, uniform, texture, attribute, varying,
  buffer, instanceIndex, cameraPosition, cameraViewMatrix, modelWorldMatrix, positionGeometry,
  screenCoordinate, select, mix, min, floor, fract, ceil, abs, dot, mod, clamp,
} from 'three/tsl'
import { Matrix4 } from 'three'

function instanceMatrixNodeFor(object) {
  const im = object.instanceMatrix
  return buffer(im.array, 'mat4', Math.max(im.count, 1)).element(instanceIndex)
}

function encodeDirectionTSL(direction) {
  const sum = abs(direction.x).add(abs(direction.y)).add(abs(direction.z))
  const o = direction.div(sum)
  const cond = o.y.lessThan(0.0)
  const sx = select(o.x.greaterThanEqual(0.0), float(1.0), float(-1.0))
  const sz = select(o.z.greaterThanEqual(0.0), float(1.0), float(-1.0))
  const oxAlt = sx.mul(float(1.0).sub(abs(o.z)))
  const ozAlt = sz.mul(float(1.0).sub(abs(o.x)))
  const ox = select(cond, oxAlt, o.x)
  const oz = select(cond, ozAlt, o.z)
  return vec2(ox.mul(0.5).add(0.5), oz.mul(0.5).add(0.5))
}

function decodeDirectionTSL(gridIndex, spritesMinusOne) {
  const gridUV = gridIndex.div(spritesMinusOne)
  const px = gridUV.x.sub(0.5).mul(2.0)
  const pz = gridUV.y.sub(0.5).mul(2.0)
  const ax = abs(px)
  const az = abs(pz)
  const py = float(1.0).sub(ax).sub(az)
  const cond = py.lessThan(0.0)
  const sx = select(px.greaterThanEqual(0.0), float(1.0), float(-1.0))
  const sz = select(pz.greaterThanEqual(0.0), float(1.0), float(-1.0))
  const pxAdj = select(cond, sx.mul(float(1.0).sub(az)), px)
  const pzAdj = select(cond, sz.mul(float(1.0).sub(ax)), pz)
  return vec3(pxAdj, py, pzAdj).normalize()
}

function computePlaneBasisTSL(normal) {
  let up = vec3(0.0, 1.0, 0.0)
  up = select(normal.y.greaterThan(0.999), vec3(-1.0, 0.0, 0.0), up)
  up = select(normal.y.lessThan(-0.999), vec3(1.0, 0.0, 0.0), up)
  const tangent = up.cross(normal).normalize()
  const bitangent = normal.cross(tangent)
  return [tangent, bitangent]
}

function projectToPlaneUVTSL(normal, tangent, bitangent, camPos, viewDir) {
  const denom = dot(viewDir, normal)
  const t = dot(camPos, normal).mul(-1.0).div(denom)
  const hit = camPos.add(viewDir.mul(t))
  return vec2(dot(tangent, hit), dot(bitangent, hit)).add(0.5)
}

function computeSpritesWeightTSL(gridFract) {
  const fx = gridFract.x
  const fy = gridFract.y
  return vec4(
    min(float(1.0).sub(fx), float(1.0).sub(fy)),
    abs(fx.sub(fy)),
    min(fx, fy),
    ceil(fx.sub(fy)),
  )
}

function getUVTSL(uvF, frame, frameSize) {
  const clamped = clamp(uvF, vec2(0.0), vec2(1.0))
  const framed = frameSize.mul(frame.add(clamped))
  return clamp(framed, vec2(0.0), vec2(1.0))
}

export function makeOctahedralImpostorDisplayMaterialTSL(params) {
  const p = params || {}
  if (p.useHemiOctahedron) throw new Error('octahedral-impostor-display-tsl: hemi-octahedron projection is not ported')
  if (!p.albedo) throw new Error('octahedral-impostor-display-tsl: "albedo" texture is required')

  const isTransparent = !!p.transparent
  const atlasTile = !!p.atlasTile
  const farSingleSprite = p.farSingleSprite !== false
  const parallax = p.parallax === true && !!p.normalDepth
  const hasNormalDepth = !!p.normalDepth
  const nearCutoff = Number.isFinite(p.nearCutoff) && p.nearCutoff > 0 ? p.nearCutoff : 0
  const fadeBandM = Number.isFinite(p.fadeBandM) ? p.fadeBandM : 3.0

  const material = new MeshStandardNodeMaterial({
    transparent: isTransparent,
    side: p.side,
    depthWrite: p.depthWrite,
    depthTest: p.depthTest,
  })
  material.roughness = p.roughness ?? 1.0
  material.metalness = p.metalness ?? 0.0
  material.polygonOffset = !!p.polygonOffset
  material.polygonOffsetFactor = p.polygonOffsetFactor ?? 0
  material.polygonOffsetUnits = p.polygonOffsetUnits ?? 0

  const uSpritesPerSide = uniform(p.spritesPerSide ?? 16)
  const uAlphaClamp = uniform(p.alphaClamp ?? 0.4)
  const uAtlasGridSide = uniform(p.atlasGridSide ?? 1)
  const uAtlasTileScale = uniform(1 / (p.atlasGridSide ?? 1))
  const uParallaxScale = uniform(p.parallaxScale ?? 0.3)
  const uImpostorTransform = uniform(p.transform || new Matrix4(), 'mat4')
  const uNearCutoff = nearCutoff ? uniform(nearCutoff) : null
  const uFadeBand = nearCutoff ? uniform(fadeBandM) : null

  const albedoMap = p.albedo
  const normalDepthMap = p.normalDepth

  let vSprite1 = null
  let vSprite2 = null
  let vSprite3 = null
  let vSpritesWeight = null
  let vSpriteUV1 = null
  let vSpriteUV2 = null
  let vSpriteUV3 = null
  let vImpCamDist = null
  let vViewDirLocal = null
  let vTangent1 = null
  let vBitangent1 = null
  let vTangent2 = null
  let vBitangent2 = null
  let vTangent3 = null
  let vBitangent3 = null

  const displacedPosition = Fn((builder) => {
    const instanceMatrixNode = instanceMatrixNodeFor(builder.object)
    const transformedInstanceMatrix = instanceMatrixNode.mul(uImpostorTransform)
    const combined = transformedInstanceMatrix.mul(modelWorldMatrix)
    const cameraPosLocal = combined.inverse().mul(vec4(cameraPosition, 1.0)).xyz
    const cameraDir = cameraPosLocal.normalize()

    const spritesMinusOne = vec2(uSpritesPerSide.sub(1.0), uSpritesPerSide.sub(1.0))

    const [xBasis, yBasis] = computePlaneBasisTSL(cameraDir)
    const projectedVertex = xBasis.mul(positionGeometry.x).add(yBasis.mul(positionGeometry.y))
    const viewDirLocal = projectedVertex.sub(cameraPosLocal).normalize()

    const grid = encodeDirectionTSL(cameraDir).mul(spritesMinusOne)
    const gridFloor = min(floor(grid), spritesMinusOne)
    const gridFract = fract(grid)
    const spritesWeight = computeSpritesWeightTSL(gridFract)

    const sprite1 = gridFloor
    const sprite2 = min(sprite1.add(mix(vec2(0.0, 1.0), vec2(1.0, 0.0), spritesWeight.w)), spritesMinusOne)
    const sprite3 = min(sprite1.add(vec2(1.0, 1.0)), spritesMinusOne)

    const normal1 = decodeDirectionTSL(sprite1, spritesMinusOne)
    const normal2 = decodeDirectionTSL(sprite2, spritesMinusOne)
    const normal3 = decodeDirectionTSL(sprite3, spritesMinusOne)

    const [t1, b1] = computePlaneBasisTSL(normal1)
    const [t2, b2] = computePlaneBasisTSL(normal2)
    const [t3, b3] = computePlaneBasisTSL(normal3)

    const spriteUV1 = projectToPlaneUVTSL(normal1, t1, b1, cameraPosLocal, viewDirLocal)
    const spriteUV2 = projectToPlaneUVTSL(normal2, t2, b2, cameraPosLocal, viewDirLocal)
    const spriteUV3 = projectToPlaneUVTSL(normal3, t3, b3, cameraPosLocal, viewDirLocal)

    vSprite1 = varying(sprite1, 'vImpSprite1')
    vSprite2 = varying(sprite2, 'vImpSprite2')
    vSprite3 = varying(sprite3, 'vImpSprite3')
    vSpritesWeight = varying(spritesWeight, 'vImpSpritesWeight')
    vSpriteUV1 = varying(spriteUV1, 'vImpSpriteUV1')
    vSpriteUV2 = varying(spriteUV2, 'vImpSpriteUV2')
    vSpriteUV3 = varying(spriteUV3, 'vImpSpriteUV3')

    if (parallax) {
      vViewDirLocal = varying(viewDirLocal, 'vImpViewDirLocal')
      vTangent1 = varying(t1, 'vImpTangent1')
      vBitangent1 = varying(b1, 'vImpBitangent1')
      vTangent2 = varying(t2, 'vImpTangent2')
      vBitangent2 = varying(b2, 'vImpBitangent2')
      vTangent3 = varying(t3, 'vImpTangent3')
      vBitangent3 = varying(b3, 'vImpBitangent3')
    }

    if (nearCutoff) {
      const instanceWorldPos = transformedInstanceMatrix.mul(modelWorldMatrix).mul(vec4(0.0, 0.0, 0.0, 1.0)).xyz
      const camDist = cameraPosition.sub(instanceWorldPos).length()
      vImpCamDist = varying(camDist, 'vImpCamDist')
    }

    return transformedInstanceMatrix.mul(vec4(projectedVertex, 1.0)).xyz
  })

  function sampleSprites() {
    const spriteSize = float(1.0).div(uSpritesPerSide)

    let uv1 = getUVTSL(vSpriteUV1, vSprite1, spriteSize)
    let uv2 = getUVTSL(vSpriteUV2, vSprite2, spriteSize)
    let uv3 = getUVTSL(vSpriteUV3, vSprite3, spriteSize)

    if (parallax) {
      const applyParallax = (uvBase, cellBase, tangent, bitangent) => {
        const normal = tangent.cross(bitangent).normalize()
        const depthS = texture(normalDepthMap, uvBase).a
        const viewTS = vec3(dot(vViewDirLocal, tangent), dot(vViewDirLocal, bitangent), dot(vViewDirLocal, normal))
        const offset = viewTS.xy.mul(depthS.sub(0.5).mul(uParallaxScale))
        return clamp(uvBase.add(offset), cellBase, cellBase.add(vec2(spriteSize)))
      }
      uv1 = applyParallax(uv1, vSprite1.mul(spriteSize), vTangent1, vBitangent1)
      uv2 = applyParallax(uv2, vSprite2.mul(spriteSize), vTangent2, vBitangent2)
      uv3 = applyParallax(uv3, vSprite3.mul(spriteSize), vTangent3, vBitangent3)
    }

    if (atlasTile) {
      const atlasTileAttr = attribute('atlasTile', 'float')
      const tileBase = vec2(mod(atlasTileAttr, uAtlasGridSide), floor(atlasTileAttr.div(uAtlasGridSide)))
      uv1 = tileBase.add(uv1).mul(uAtlasTileScale)
      uv2 = tileBase.add(uv2).mul(uAtlasTileScale)
      uv3 = tileBase.add(uv3).mul(uAtlasTileScale)
    }

    const sprite1c = vec4(0.0).toVar('impSprite1c')
    const sprite2c = vec4(0.0).toVar('impSprite2c')
    const sprite3c = vec4(0.0).toVar('impSprite3c')

    if (farSingleSprite) {
      const uvBest = select(
        vSpritesWeight.y.greaterThanEqual(vSpritesWeight.x).and(vSpritesWeight.y.greaterThanEqual(vSpritesWeight.z)),
        uv2,
        select(vSpritesWeight.z.greaterThanEqual(vSpritesWeight.x).and(vSpritesWeight.z.greaterThanEqual(vSpritesWeight.y)), uv3, uv1),
      )
      const s = texture(albedoMap, uvBest)
      Discard(s.a.lessThanEqual(uAlphaClamp))
      sprite1c.assign(s)
      sprite2c.assign(s)
      sprite3c.assign(s)
      uv1 = uvBest
      uv2 = uvBest
      uv3 = uvBest
    } else {
      const test = float(1.0).sub(uAlphaClamp)
      If(vSpritesWeight.x.greaterThanEqual(test), () => {
        const s1 = texture(albedoMap, uv1)
        Discard(s1.a.lessThanEqual(uAlphaClamp))
        sprite1c.assign(s1)
        sprite2c.assign(texture(albedoMap, uv2))
        sprite3c.assign(texture(albedoMap, uv3))
      }).ElseIf(vSpritesWeight.y.greaterThanEqual(test), () => {
        const s2 = texture(albedoMap, uv2)
        Discard(s2.a.lessThanEqual(uAlphaClamp))
        sprite2c.assign(s2)
        sprite1c.assign(texture(albedoMap, uv1))
        sprite3c.assign(texture(albedoMap, uv3))
      }).ElseIf(vSpritesWeight.z.greaterThanEqual(test), () => {
        const s3 = texture(albedoMap, uv3)
        Discard(s3.a.lessThanEqual(uAlphaClamp))
        sprite3c.assign(s3)
        sprite1c.assign(texture(albedoMap, uv1))
        sprite2c.assign(texture(albedoMap, uv2))
      }).Else(() => {
        sprite1c.assign(texture(albedoMap, uv1))
        sprite2c.assign(texture(albedoMap, uv2))
        sprite3c.assign(texture(albedoMap, uv3))
      })
    }

    let blended = sprite1c.mul(vSpritesWeight.x).add(sprite2c.mul(vSpritesWeight.y)).add(sprite3c.mul(vSpritesWeight.z))
    Discard(blended.a.lessThanEqual(uAlphaClamp))

    if (!isTransparent) blended = vec4(blended.rgb.div(blended.a), 1.0)

    return { blended, uv1, uv2, uv3 }
  }

  const colorOutput = Fn(() => {
    const { blended } = sampleSprites()

    if (nearCutoff) {
      const fade = clamp(vImpCamDist.sub(uNearCutoff.sub(uFadeBand)).div(uFadeBand), 0.0, 1.0)
      const dither = fract(float(52.9829189).mul(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715)))))
      Discard(dither.greaterThan(fade))
    }

    return blended
  })

  if (hasNormalDepth) {
    material.normalNode = Fn(() => {
      const spriteSize = float(1.0).div(uSpritesPerSide)
      let uv1 = getUVTSL(vSpriteUV1, vSprite1, spriteSize)
      let uv2 = getUVTSL(vSpriteUV2, vSprite2, spriteSize)
      let uv3 = getUVTSL(vSpriteUV3, vSprite3, spriteSize)

      if (atlasTile) {
        const atlasTileAttr = attribute('atlasTile', 'float')
        const tileBase = vec2(mod(atlasTileAttr, uAtlasGridSide), floor(atlasTileAttr.div(uAtlasGridSide)))
        uv1 = tileBase.add(uv1).mul(uAtlasTileScale)
        uv2 = tileBase.add(uv2).mul(uAtlasTileScale)
        uv3 = tileBase.add(uv3).mul(uAtlasTileScale)
      }

      let worldNormal
      if (farSingleSprite) {
        const uvBest = select(
          vSpritesWeight.y.greaterThanEqual(vSpritesWeight.x).and(vSpritesWeight.y.greaterThanEqual(vSpritesWeight.z)),
          uv2,
          select(vSpritesWeight.z.greaterThanEqual(vSpritesWeight.x).and(vSpritesWeight.z.greaterThanEqual(vSpritesWeight.y)), uv3, uv1),
        )
        worldNormal = texture(normalDepthMap, uvBest).rgb.mul(2.0).sub(1.0)
      } else {
        const n1 = texture(normalDepthMap, uv1).rgb.mul(2.0).sub(1.0)
        const n2 = texture(normalDepthMap, uv2).rgb.mul(2.0).sub(1.0)
        const n3 = texture(normalDepthMap, uv3).rgb.mul(2.0).sub(1.0)
        worldNormal = n1.mul(vSpritesWeight.x).add(n2.mul(vSpritesWeight.y)).add(n3.mul(vSpritesWeight.z)).normalize()
      }

      return mat3(cameraViewMatrix).mul(worldNormal).normalize()
    })()
  }

  material.positionNode = displacedPosition()
  material.colorNode = colorOutput()
  material.customProgramCacheKey = () => `octaimpostor-display-tsl_${isTransparent}_${atlasTile}_${farSingleSprite}_${parallax}_${hasNormalDepth}_${!!nearCutoff}`

  return material
}
