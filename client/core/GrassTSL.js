import * as THREE from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import {
  Fn, Loop, If, Break, int, float, vec2, vec3, vec4,
  uniform, uniformArray, attribute, varying, buffer, instanceIndex,
  positionLocal, normalLocal, normalWorld, frontFacing,
  clamp, mix, smoothstep, dot, normalize, max, sin, cos
} from 'three/tsl'

function instanceMatrixNodeFor(object) {
  const im = object.instanceMatrix
  return buffer(im.array, 'mat4', Math.max(im.count, 1)).element(instanceIndex)
}
import { MAX_BENDERS, MAX_DECALS, UNUSED_BENDER_SLOT_XZ, makeBladeGeo, makeWind } from './GrassMaterial.js'

export { MAX_BENDERS, MAX_DECALS, UNUSED_BENDER_SLOT_XZ, makeBladeGeo, makeWind }

export function makeGrassMaterialTSL(wind) {
  const uGrassTime = uniform(wind.uGrassTime.value)
  const uGrassWind = uniform(wind.uGrassWind.value)
  const uGrassWindDir = uniform(wind.uGrassWindDir.value)
  const uCamPosXZ = uniform(wind.uCamPosXZ.value)
  const uGrassRing = uniform(wind.uGrassRing.value)
  const uSunDir = uniform(wind.uSunDir.value)
  const uSunColor = uniform(wind.uSunColor.value)
  const uAmbient = uniform(wind.uAmbient.value)
  const uGrassBendRadius = uniform(wind.uGrassBendRadius.value)
  const uGrassBendStrength = uniform(wind.uGrassBendStrength.value)
  const uBenderCount = uniform(wind.uBenderCount.value)
  const uDecalCount = uniform(wind.uDecalCount.value)
  const uGrassScorchShrink = uniform(wind.uGrassScorchShrink.value)
  const uGrassScorchColor = uniform(wind.uGrassScorchColor.value)

  const benderSlots = []
  for (let i = 0; i < MAX_BENDERS; i++) benderSlots.push(new THREE.Vector2(UNUSED_BENDER_SLOT_XZ, UNUSED_BENDER_SLOT_XZ))
  const uBenderPosXZ = uniformArray(benderSlots, 'vec2')

  const decalSlots = []
  for (let i = 0; i < MAX_DECALS; i++) decalSlots.push(new THREE.Vector4(0, 0, 0, 0))
  const uDecalPosXZRS = uniformArray(decalSlots, 'vec4')

  const windPhase = attribute('windPhase', 'float')
  const tint = attribute('tint', 'float')
  const instShadow = attribute('instShadow', 'float')
  const instWorldXZ = attribute('instWorldXZ', 'vec2')

  const vGrassY = varying(positionLocal.y, 'vGrassY')
  const vTint = varying(tint, 'vTint')
  const vInstShadow = varying(instShadow, 'vInstShadow')

  const bendField = Fn(() => {
    const bendXZ = vec2(0.0, 0.0).toVar()
    Loop({ start: int(0), end: int(MAX_BENDERS), type: 'int', condition: '<' }, ({ i }) => {
      If(i.greaterThanEqual(int(uBenderCount)), () => { Break() })
      const toBlade = instWorldXZ.sub(uBenderPosXZ.element(i))
      const bd = toBlade.length()
      const bInfluence = float(1.0).sub(smoothstep(0.0, uGrassBendRadius, bd))
      If(bInfluence.greaterThan(0.0), () => {
        const bDir = bd.greaterThan(1e-4).select(toBlade.div(bd), vec2(1.0, 0.0))
        bendXZ.addAssign(bDir.mul(bInfluence).mul(uGrassBendStrength))
      })
    })
    return bendXZ
  })

  const scorchField = Fn(() => {
    const scorch = float(0.0).toVar()
    Loop({ start: int(0), end: int(MAX_DECALS), type: 'int', condition: '<' }, ({ i }) => {
      If(i.greaterThanEqual(int(uDecalCount)), () => { Break() })
      const dc = uDecalPosXZRS.element(i)
      const dRadius = dc.z
      If(dRadius.greaterThan(0.0), () => {
        const dd = instWorldXZ.sub(dc.xy).length()
        const dInfluence = float(1.0).sub(smoothstep(0.0, dRadius, dd)).mul(clamp(dc.w, 0.0, 1.0))
        scorch.assign(max(scorch, dInfluence))
      })
    })
    return scorch
  })

  let vScorch = null

  const displacedPosition = Fn((builder) => {
    const instanceMatrixNode = instanceMatrixNodeFor(builder.object)
    const transformed = positionLocal.toVar()
    const gv = clamp(transformed.y, 0.0, 1.0)
    const gw = gv.mul(gv).mul(0.45)
    const gFlow = sin(dot(instWorldXZ, vec2(0.06, 0.045)).add(uGrassTime.mul(1.4)))
      .add(sin(dot(instWorldXZ, vec2(-0.11, 0.09)).add(uGrassTime.mul(2.3))).mul(0.5))
    const gAmp = float(0.6).add(gFlow.mul(0.4)).mul(gw).mul(uGrassWind)
    const gph = uGrassTime.mul(2.2).add(windPhase)
    const gWdir = normalize(uGrassWindDir.add(1e-4))
    transformed.x.addAssign(gWdir.x.mul(gAmp).add(sin(gph).mul(gw).mul(0.25).mul(uGrassWind)))
    transformed.z.addAssign(gWdir.y.mul(gAmp).add(cos(gph.mul(0.7)).mul(gw).mul(0.25).mul(uGrassWind)))

    const bendXZ = bendField()
    transformed.x.addAssign(bendXZ.x.mul(gw))
    transformed.z.addAssign(bendXZ.y.mul(gw))
    transformed.y.subAssign(bendXZ.length().mul(gw).mul(0.35))

    const scorch = scorchField().toVar()
    const scorchScale = mix(1.0, uGrassScorchShrink, scorch)
    transformed.mulAssign(scorchScale)

    const gDist = instWorldXZ.sub(uCamPosXZ).length()
    const gFade = float(1.0).sub(smoothstep(uGrassRing.mul(0.7), uGrassRing, gDist))
    transformed.y.mulAssign(gFade)
    transformed.x.mulAssign(mix(0.5, 1.0, gFade))
    transformed.z.mulAssign(mix(0.5, 1.0, gFade))

    vScorch = varying(scorch, 'vScorch')

    return instanceMatrixNode.mul(vec4(transformed, 1.0)).xyz
  })

  const flatNormalLocal = normalize(mix(normalize(normalLocal), vec3(0.0, 1.0, 0.0), 0.6))

  const litColor = Fn(() => {
    const gLo = vec3(0.12, 0.22, 0.06)
    const gHi = mix(vec3(0.34, 0.55, 0.16), vec3(0.45, 0.5, 0.14), vTint)
    const gAO = float(0.6).add(smoothstep(0.0, 0.2, vGrassY).mul(0.4))
    const baseColor = mix(gLo, gHi, clamp(vGrassY, 0.0, 1.0)).mul(gAO).mul(2.0).toVar()
    baseColor.assign(mix(baseColor, uGrassScorchColor, vScorch))
    const n = frontFacing.select(normalWorld, normalWorld.negate())
    const ndl = max(dot(n, uSunDir), 0.0)
    const lit = baseColor.mul(uAmbient.add(uSunColor.mul(ndl).mul(vInstShadow)))
    return vec4(lit, 1.0)
  })

  const material = new MeshBasicNodeMaterial({ side: THREE.FrontSide })
  material.normalNode = flatNormalLocal
  material.positionNode = displacedPosition()
  material.colorNode = litColor()
  material.customProgramCacheKey = () => 'grassblade-lambert-tsl'

  return {
    material,
    nodes: {
      uGrassTime, uGrassWind, uGrassWindDir, uCamPosXZ, uGrassRing,
      uSunDir, uSunColor, uAmbient, uGrassBendRadius, uGrassBendStrength,
      uBenderCount, uDecalCount, uGrassScorchShrink, uGrassScorchColor,
      benderSlots, decalSlots
    }
  }
}

export function syncGrassMaterialTSL(nodes, wind) {
  nodes.uGrassTime.value = wind.uGrassTime.value
  nodes.uGrassWind.value = wind.uGrassWind.value
  nodes.uGrassRing.value = wind.uGrassRing.value
  nodes.uGrassBendRadius.value = wind.uGrassBendRadius.value
  nodes.uGrassBendStrength.value = wind.uGrassBendStrength.value
  nodes.uBenderCount.value = wind.uBenderCount.value
  nodes.uDecalCount.value = wind.uDecalCount.value
  nodes.uGrassScorchShrink.value = wind.uGrassScorchShrink.value
  const benderArr = wind.uBenderPosXZ.value
  for (let i = 0; i < MAX_BENDERS; i++) nodes.benderSlots[i].set(benderArr[i * 2], benderArr[i * 2 + 1])
  const decalArr = wind.uDecalPosXZRS.value
  for (let i = 0; i < MAX_DECALS; i++) nodes.decalSlots[i].set(decalArr[i * 4], decalArr[i * 4 + 1], decalArr[i * 4 + 2], decalArr[i * 4 + 3])
}
