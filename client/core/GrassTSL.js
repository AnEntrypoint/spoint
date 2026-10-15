import * as THREE from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import {
  Fn, Loop, If, Break, int, float, vec2, vec3, vec4,
  uniform, uniformArray, attribute, varying,
  positionGeometry, normalGeometry, modelWorldMatrix,
  clamp, mix, smoothstep, dot, normalize, max, min, sin, cos, texture, uv, fract, floor, pow,
  cameraPosition, positionWorld
} from 'three/tsl'

import { MAX_BENDERS, MAX_DECALS, UNUSED_BENDER_SLOT_XZ, GRASS_ALPHA_CUTOFF, GRASS_GROUND_TINT, GRASS_TIP_GROUND_MIX, GRASS_TIP_GROUND_GAIN, GRASS_BLADE_VARIATION, GRASS_LOCAL_VARIATION, GRASS_LOOK_SAT, GRASS_LUMA, makeWind } from './GrassMaterial.js'
import { instanceMatrixNodeFor } from './WebGPUInstancing.js'
import { GRASS_DENSITY } from '/src/terrain/GrassPlacement.js'
import { displayReferredToSceneLinear } from '/node_modules/mapspinner/src/tsl/display-referred-tsl.js'
import { ACES_FILMIC, DISPLAY_GAMMA_INV, LUMA } from '/node_modules/mapspinner/src/tsl/terrain-ambient-shared.js'

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

export function makeGrassMaterialTSL(wind, density) {
  const d = density || GRASS_DENSITY
  const uGrassTime = uniform(wind.uGrassTime.value)
  const uGrassWind = uniform(wind.uGrassWind.value)
  const uGrassWindDir = uniform(wind.uGrassWindDir.value)
  const uCamPosXZ = uniform(wind.uCamPosXZ.value)
  const uGrassRing = uniform(wind.uGrassRing.value)
  const uGrassSat = uniform(wind.uGrassSat.value)
  const uSunDir = uniform(wind.uSunDir.value)
  const uSunColor = uniform(wind.uSunColor.value)
  const uAmbient = uniform(wind.uAmbient.value)
  const uGrassBendRadius = uniform(wind.uGrassBendRadius.value)
  const uGrassBendStrength = uniform(wind.uGrassBendStrength.value)
  const uBenderCount = uniform(wind.uBenderCount.value)
  const uDecalCount = uniform(wind.uDecalCount.value)
  const uGrassScorchShrink = uniform(wind.uGrassScorchShrink.value)
  const uGrassScorchColor = uniform(wind.uGrassScorchColor.value)
  const uGrassAmbMul = uniform(wind.uGrassAmbMul.value)
  const uGrassAmbAdd = uniform(wind.uGrassAmbAdd.value)
  const uGrassNightFill = uniform(wind.uGrassNightFill.value)
  const uGrassGrade = uniform(wind.uGrassGrade.value)
  // The shared gust field. Sampling it is the whole wind term now: one bilinear fetch at level 0
  // (the vertex stage has no implicit derivatives, so the level is stated) returning the lateral
  // displacement of every blade in this neighbourhood, per unit of the card-height envelope gw.
  const uFieldOrigin = uniform(wind.grassWindField.uniforms.uFieldOrigin.value)
  const uFieldInvExtent = uniform(wind.grassWindField.uniforms.uFieldInvExtent.value)
  const uGrassWindField = wind.grassWindField.texture
  const gustField = (instWorldXZ) => texture(uGrassWindField, instWorldXZ.sub(uFieldOrigin).mul(uFieldInvExtent), float(0))
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

  const windShadow = attribute('windShadow', 'vec2')
  const groundTintAttr = attribute('groundTint', 'vec4')
  const clumpRank = attribute('clumpRank', 'float')

  const vUv = varying(uv(), 'vUv')
  let vFieldXZ = null
  const vTint = varying(groundTintAttr.w, 'vTint')
  const vInstShadow = varying(windShadow.y, 'vInstShadow')
  const vGround = varying(groundTintAttr.xyz, 'vGround')
  const lumaWeights = vec3(GRASS_LUMA[0], GRASS_LUMA[1], GRASS_LUMA[2])

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
  let vLocalNoise = null
  let vWorldNormal = null

  const displacedPosition = Fn((builder) => {
    const instanceMatrixNode = instanceMatrixNodeFor(builder.object)
    const instWorldXZ = instanceMatrixNode.mul(vec4(0.0, 0.0, 0.0, 1.0)).xz
    const transformed = positionGeometry.toVar()
    const gv = clamp(transformed.y, 0.0, 1.0)
    const gw = gv.mul(gv).mul(0.45)
    const gGust = gustField(instWorldXZ)
    transformed.x.addAssign(gGust.x.mul(gw))
    transformed.z.addAssign(gGust.y.mul(gw))

    const bendXZ = bendField(instWorldXZ)
    transformed.x.addAssign(bendXZ.x.mul(gw))
    transformed.z.addAssign(bendXZ.y.mul(gw))
    transformed.y.subAssign(bendXZ.length().mul(gw).mul(0.12))

    const scorch = scorchField(instWorldXZ).toVar()
    const scorchScale = mix(1.0, uGrassScorchShrink, scorch)
    transformed.mulAssign(scorchScale)

    const gDist = instWorldXZ.sub(uCamPosXZ).length()
    // The law in the vertex stage, where it costs nothing per frame: a blade owns the radius at
    // which it stops being drawn and grows across FADE_M metres of the approach. Far blades are
    // also grown and turned to face the camera, which pays for the density they no longer have.
    const gEdge = min(float(d.fullR).div(clumpRank).add(float(d.fadeM)), uGrassRing)
    const gIn = clamp(gEdge.sub(gDist).div(float(d.fadeM)), 0.0, 1.0)
    const gGrow = min(float(d.growMax), float(1.0).add(float(d.growK).mul(max(gDist.sub(float(d.fullR)), 0.0))))
    // The distance enlargement stays uniform: a blade covering for the density its neighbours no
    // longer have has to be bigger across, not just taller.
    transformed.mulAssign(gGrow)
    // The fade takes a blade's HEIGHT to zero over its own last FADE_M metres, the way the ring
    // fade it replaced did. Scaling the card's WIDTH with it is what turned a field of full-width
    // blades into a field of narrow ones: measured in the browser, mid and far blades then carry
    // 0.72-0.77 of their width as well as of their height.
    transformed.y.mulAssign(gIn)
    const gFace = smoothstep(float(d.faceStart), float(d.faceEnd), gDist)
    const gAxis = normalize(instanceMatrixNode.mul(vec4(1.0, 0.0, 0.0, 0.0)).xz)
    const gToCam = normalize(uCamPosXZ.sub(instWorldXZ))
    // A card's face is a quarter turn from its in-plane axis, so turning the clump's AXIS onto the
    // direction to the camera turns the card EDGE-ON: measured, that clump reads 1.732 of
    // silhouette where the same clump never turned reads 1.910 and a clump turned face-on reads
    // 2.000, and not one of its cards is ever face-on. Turn the normal to the camera instead.
    const gPerp = vec2(gToCam.y.negate(), gToCam.x)
    // The clump is drawn double-sided, so either sign of the camera direction faces it; picking
    // the nearer sign keeps the blend away from the antipode where a normalised lerp has no
    // length to normalise.
    const gTarget = gPerp.mul(dot(gAxis, gPerp).greaterThanEqual(0.0).select(float(1.0), float(-1.0)))
    const gDir = normalize(mix(gAxis, gTarget, gFace))
    const gCos = dot(gAxis, gDir), gSin = gAxis.x.mul(gDir.y).sub(gAxis.y.mul(gDir.x))
    const gRx = transformed.x.mul(gCos).sub(transformed.z.mul(gSin))
    transformed.z.assign(transformed.x.mul(gSin).add(transformed.z.mul(gCos)))
    transformed.x.assign(gRx)

    vScorch = varying(scorch, 'vScorch')
    vLocalNoise = varying(grassNoise(instWorldXZ.mul(1.0)), 'vLocalNoise')
    vFieldXZ = varying(instWorldXZ, 'vFieldXZ')
    vWorldNormal = varying(normalize(modelWorldMatrix.mul(vec4(instanceMatrixNode.mul(vec4(0.0, 1.0, 0.0, 0.0)).xyz, 0.0)).xyz), 'vWorldNormal')

    return instanceMatrixNode.mul(vec4(transformed, 1.0)).xyz
  })

  const litColor = Fn(() => {
    const blade = clumpSample.r
    const fieldNoise = grassNoise(vFieldXZ.mul(0.085))
    const variation = clamp(fieldNoise.mul(0.65).add(vTint.mul(0.35)), 0.0, 1.0)
    const tip = mix(uGrassTip1, uGrassTip2, variation)
    const along = smoothstep(0.0, 0.95, vUv.y)
    const baseRoot = mix(uGrassBase, vGround, float(GRASS_GROUND_TINT))
    const bladeJitter = clamp(float(1.0).add(float(GRASS_BLADE_VARIATION).mul(vTint.mul(2.0).sub(1.0))).add(float(GRASS_LOCAL_VARIATION).mul(vLocalNoise.mul(2.0).sub(1.0))), float(0.2), float(1.25))
    const tipGround = mix(tip, vGround.mul(float(GRASS_TIP_GROUND_GAIN)).mul(bladeJitter), float(GRASS_TIP_GROUND_MIX))
    const baseColor = mix(baseRoot, tipGround, along).toVar()
    baseColor.mulAssign(mix(0.78, 1.1, smoothstep(0.55, 1.0, blade)))
    baseColor.mulAssign(float(0.62).add(smoothstep(0.0, 0.3, vUv.y).mul(0.38)))
    baseColor.assign(mix(baseColor, uGrassScorchColor, vScorch))
    const ndl = max(dot(vWorldNormal, uSunDir), 0.0)
    const wrap = ndl
    const viewDir = normalize(cameraPosition.sub(positionWorld))
    const backlitCos = clamp(dot(viewDir, uSunDir.negate()), 0.0, 1.0)
    const backlit = backlitCos.mul(backlitCos).mul(backlitCos).mul(vUv.y)
    const lit = baseColor.mul(uAmbient.add(uSunColor.mul(wrap).mul(vInstShadow)))
      .add(baseColor.mul(uSunColor).mul(backlit).mul(0.55).mul(vInstShadow))
      .add(baseColor.mul(uGrassAmbMul)).add(uGrassAmbAdd)
    const litSat = mix(vec3(dot(lit, lumaWeights)), lit, uGrassSat)
    const litGraded = litSat.mul(uGrassGrade.x).add(uGrassNightFill).mul(uGrassGrade.y)
    const aces = clamp(litGraded.mul(litGraded.mul(ACES_FILMIC[0]).add(ACES_FILMIC[1]))
      .div(litGraded.mul(litGraded.mul(ACES_FILMIC[2]).add(ACES_FILMIC[3])).add(ACES_FILMIC[4])), vec3(0.0), vec3(1.0))
    const sat = mix(vec3(dot(aces, vec3(LUMA[0], LUMA[1], LUMA[2]))), aces, uGrassGrade.z)
    const graded = clamp(sat.sub(0.5).mul(uGrassGrade.w).add(0.5), vec3(0.0), vec3(1.0))
    return vec4(displayReferredToSceneLinear(pow(graded, vec3(DISPLAY_GAMMA_INV))), 1.0)
  })

  const material = new MeshBasicNodeMaterial({ side: THREE.DoubleSide })
  material.opacityNode = clumpSample.r.mul(1.25).clamp(0.0, 1.0).mul(0.92)
  material.transparent = true
  material.alphaTest = GRASS_ALPHA_CUTOFF
  material.positionNode = displacedPosition()
  material.colorNode = litColor()
  material.customProgramCacheKey = () => 'grassclump-fluffy-tsl'

  return {
    material,
    nodes: {
      uGrassTime, uGrassWind, uGrassWindDir, uCamPosXZ, uGrassRing, uGrassSat,
      uSunDir, uSunColor, uAmbient, uGrassBendRadius, uGrassBendStrength,
      uGrassBase, uGrassTip1, uGrassTip2,
      uBenderCount, uDecalCount, uGrassScorchShrink, uGrassScorchColor,
      uFieldOrigin, uFieldInvExtent,
      benderSlots, decalSlots
    }
  }
}

export function syncGrassMaterialTSL(nodes, wind) {
  nodes.uGrassTime.value = wind.uGrassTime.value
  nodes.uGrassWind.value = wind.uGrassWind.value
  nodes.uGrassRing.value = wind.uGrassRing.value
  nodes.uGrassSat.value = wind.uGrassSat.value
  nodes.uGrassBendRadius.value = wind.uGrassBendRadius.value
  nodes.uGrassBendStrength.value = wind.uGrassBendStrength.value
  nodes.uBenderCount.value = wind.uBenderCount.value
  nodes.uDecalCount.value = wind.uDecalCount.value
  nodes.uGrassScorchShrink.value = wind.uGrassScorchShrink.value
  nodes.uFieldOrigin.value.copy(wind.grassWindField.uniforms.uFieldOrigin.value)
  nodes.uFieldInvExtent.value = wind.grassWindField.uniforms.uFieldInvExtent.value
  const benderArr = wind.uBenderPosXZ.value
  for (let i = 0; i < MAX_BENDERS; i++) nodes.benderSlots[i].set(benderArr[i * 2], benderArr[i * 2 + 1])
  const decalArr = wind.uDecalPosXZRS.value
  for (let i = 0; i < MAX_DECALS; i++) nodes.decalSlots[i].set(decalArr[i * 4], decalArr[i * 4 + 1], decalArr[i * 4 + 2], decalArr[i * 4 + 3])
}
