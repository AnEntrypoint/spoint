import * as THREE from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import {
  Fn, Loop, If, Break, int, float, vec2, vec3, vec4,
  uniform, uniformArray, attribute, varying,
  positionGeometry, normalGeometry, modelWorldMatrix,
  clamp, mix, smoothstep, dot, normalize, max, sin, cos, texture, uv, fract, floor, pow,
  cameraPosition, positionWorld
} from 'three/tsl'

import { MAX_BENDERS, MAX_DECALS, UNUSED_BENDER_SLOT_XZ, GRASS_ALPHA_CUTOFF, makeWind } from './GrassMaterial.js'
import { instanceMatrixNodeFor } from './WebGPUInstancing.js'
import { displayReferredToSceneLinear } from '/node_modules/mapspinner/src/tsl/display-referred-tsl.js'

export { MAX_BENDERS, MAX_DECALS, UNUSED_BENDER_SLOT_XZ, makeWind }

const grassHash = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)))

const grassNoise = Fn(([p]) => {
  const i = floor(p)
  const f = fract(p)
  const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0)))
  const a = grassHash(i)
  const b = grassHash(i.add(vec2(1.0, 0.0)))
  const c = grassHash(i.add(vec2(0.0, 1.0)))
  const d = grassHash(i.add(vec2(1.0, 1.0)))
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y)
})

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
  const uGrassBase = uniform(wind.uGrassBase.value)
  const uGrassTip1 = uniform(wind.uGrassTip1.value)
  const uGrassTip2 = uniform(wind.uGrassTip2.value)
  const clumpSample = texture(wind.uClumpTex.value, uv())

  const benderSlots = []
  for (let i = 0; i < MAX_BENDERS; i++) benderSlots.push(new THREE.Vector2(UNUSED_BENDER_SLOT_XZ, UNUSED_BENDER_SLOT_XZ))
  const uBenderPosXZ = uniformArray(benderSlots, 'vec2')

  const decalSlots = []
  for (let i = 0; i < MAX_DECALS; i++) decalSlots.push(new THREE.Vector4(0, 0, 0, 0))
  const uDecalPosXZRS = uniformArray(decalSlots, 'vec4')

  const windPhase = attribute('windPhase', 'float')
  const tint = attribute('tint', 'float')
  const instShadow = attribute('instShadow', 'float')

  const vUv = varying(uv(), 'vUv')
  let vFieldXZ = null
  const vTint = varying(tint, 'vTint')
  const vInstShadow = varying(instShadow, 'vInstShadow')

  const bendField = (instWorldXZ) => Fn(() => {
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
  })()

  const scorchField = (instWorldXZ) => Fn(() => {
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
  })()

  let vScorch = null
  let vWorldNormal = null

  const displacedPosition = Fn((builder) => {
    const instanceMatrixNode = instanceMatrixNodeFor(builder.object)
    const instWorldXZ = instanceMatrixNode.mul(vec4(0.0, 0.0, 0.0, 1.0)).xz
    const transformed = positionGeometry.toVar()
    const gv = clamp(transformed.y, 0.0, 1.0)
    const gw = gv.mul(gv).mul(0.45)
    const gGust = grassNoise(instWorldXZ.mul(0.11).add(uGrassWindDir.mul(uGrassTime).mul(0.35)))
    const gFlow = sin(dot(instWorldXZ, vec2(0.06, 0.045)).add(gGust.mul(5.5)).add(uGrassTime.mul(1.4)))
      .add(sin(dot(instWorldXZ, vec2(-0.11, 0.09)).add(uGrassTime.mul(2.3))).mul(0.5))
    const gAmp = float(0.55).add(gFlow.mul(0.4)).mul(gw).mul(uGrassWind)
    const gph = uGrassTime.mul(2.2).add(windPhase)
    const gWdir = normalize(uGrassWindDir.add(1e-4))
    transformed.x.addAssign(gWdir.x.mul(gAmp).add(sin(gph).mul(gw).mul(0.25).mul(uGrassWind)))
    transformed.z.addAssign(gWdir.y.mul(gAmp).add(cos(gph.mul(0.7)).mul(gw).mul(0.25).mul(uGrassWind)))

    const bendXZ = bendField(instWorldXZ)
    transformed.x.addAssign(bendXZ.x.mul(gw))
    transformed.z.addAssign(bendXZ.y.mul(gw))
    transformed.y.subAssign(bendXZ.length().mul(gw).mul(0.35))

    const scorch = scorchField(instWorldXZ).toVar()
    const scorchScale = mix(1.0, uGrassScorchShrink, scorch)
    transformed.mulAssign(scorchScale)

    const gDist = instWorldXZ.sub(uCamPosXZ).length()
    const gFade = float(1.0).sub(smoothstep(uGrassRing.mul(0.7), uGrassRing, gDist))
    transformed.y.mulAssign(gFade)
    transformed.x.mulAssign(mix(0.5, 1.0, gFade))
    transformed.z.mulAssign(mix(0.5, 1.0, gFade))

    vScorch = varying(scorch, 'vScorch')
    vFieldXZ = varying(instWorldXZ, 'vFieldXZ')
    const flatNormalGeometry = normalize(mix(normalize(normalGeometry), vec3(0.0, 1.0, 0.0), 0.75))
    vWorldNormal = varying(normalize(modelWorldMatrix.mul(vec4(instanceMatrixNode.mul(vec4(flatNormalGeometry, 0.0)).xyz, 0.0)).xyz), 'vWorldNormal')

    return instanceMatrixNode.mul(vec4(transformed, 1.0)).xyz
  })

  const litColor = Fn(() => {
    const blade = clumpSample.r
    const fieldNoise = grassNoise(vFieldXZ.mul(0.085))
    const variation = clamp(fieldNoise.mul(0.65).add(vTint.mul(0.35)), 0.0, 1.0)
    const tip = mix(uGrassTip1, uGrassTip2, variation)
    const along = smoothstep(0.0, 0.95, vUv.y)
    const baseColor = mix(uGrassBase, tip, along).toVar()
    baseColor.mulAssign(mix(0.78, 1.1, smoothstep(0.55, 1.0, blade)))
    baseColor.mulAssign(float(0.62).add(smoothstep(0.0, 0.3, vUv.y).mul(0.38)))
    baseColor.assign(mix(baseColor, uGrassScorchColor, vScorch))
    const ndl = max(dot(normalize(vWorldNormal), uSunDir), 0.0)
    const wrap = float(0.4).add(ndl.mul(0.6))
    const viewDir = normalize(cameraPosition.sub(positionWorld))
    const backlit = pow(clamp(dot(viewDir, uSunDir.negate()), 0.0, 1.0), 3.0).mul(vUv.y)
    const lit = baseColor.mul(uAmbient.add(uSunColor.mul(wrap).mul(vInstShadow)))
      .add(baseColor.mul(uSunColor).mul(backlit).mul(0.55).mul(vInstShadow))
    return vec4(displayReferredToSceneLinear(clamp(lit, vec3(0.0), vec3(1.0))), 1.0)
  })

  const material = new MeshBasicNodeMaterial({ side: THREE.DoubleSide })
  material.opacityNode = clumpSample.r
  material.alphaTest = GRASS_ALPHA_CUTOFF
  material.positionNode = displacedPosition()
  material.colorNode = litColor()
  material.customProgramCacheKey = () => 'grassclump-fluffy-tsl'

  return {
    material,
    nodes: {
      uGrassTime, uGrassWind, uGrassWindDir, uCamPosXZ, uGrassRing,
      uSunDir, uSunColor, uAmbient, uGrassBendRadius, uGrassBendStrength,
      uGrassBase, uGrassTip1, uGrassTip2,
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
