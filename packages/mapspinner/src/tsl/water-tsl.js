import * as THREE from 'three/webgpu'
import {
  Fn, Loop, If, Discard, float, int, vec2, vec3, vec4, uniform, attribute, varyingProperty, select,
  normalize, cross, dot, max, mix, smoothstep, clamp, length, abs, pow, exp, tan, reflect, step,
  screenUV, viewportSharedTexture,
} from 'three/tsl'
import { buildGridGeometry } from '../patch-grid-geometry.js'
import { seaHeightMean } from '../sea-waves.js'
import { TERRAIN_DEFAULTS as TD } from '../terrain-defaults.js'
import { displayReferredToSceneLinear, sceneLinearToDisplayReferred } from './display-referred-tsl.js'
import { SEA_OCTAVES, seaNoise, seaOctave, seaHeight, seaHeightLF } from './sea-waves-tsl.js'

const WATER_GRID = 4
const WATER_MAX_LEVEL = 11
const WATER_KEY_SPAN = 4096
const QUARTER_PI = 0.7853981634
const SLOPE_EPS_M = 0.25
const SLOPE_EPS_LF_M = 1.25
const MARCH_NEAR_M = 140.0
const MARCH_STEPS = 5
const BISECT_MAX = 5
const WAVE_TILE_M = 1024.0
const UNDERWATER_BELOW_M = 2.0
const LAND_ABOVE_SEA_DISCARD_M = 1.0
const DEFAULT_OCEAN = { amplitude: 1.0, choppiness: 0.5, foam: 0.5 }

const acesDisplay = (c) => pow(clamp(c.mul(c.mul(2.51).add(0.03)).div(c.mul(c.mul(2.43).add(0.59)).add(0.14)), 0.0, 1.0), vec3(1.0 / 2.2))

export function createWaterTSL({ spec, terrainUniforms: tu, faceU, faceV, faceC }) {
  const u = {
    camMod: uniform(new THREE.Vector3()),
    sunDir: uniform(new THREE.Vector3(0, 1, 0)),
    time: uniform(0),
    amp: uniform(DEFAULT_OCEAN.amplitude),
    choppy: uniform(DEFAULT_OCEAN.choppiness),
    foam: uniform(DEFAULT_OCEAN.foam),
    seaMean: uniform(seaHeightMean(DEFAULT_OCEAN.choppiness, DEFAULT_OCEAN.amplitude)),
    underwater: uniform(0),
    hazeMul: uniform(TD.hazeMul),
  }
  const vH = varyingProperty('float', 'vWaterH')
  const vDir = varyingProperty('vec3', 'vWaterDir')
  const vRelP = varyingProperty('vec3', 'vWaterRel')
  const toLocal = (p) => vec3(dot(p, tu.east), dot(p, tu.up), dot(p, tu.north))

  const positionNode = Fn(() => {
    const grid = attribute('position', 'vec3')
    const off = attribute('iOffset', 'vec4')
    const face = int(attribute('iFace', 'float').add(0.5))
    const R = tu.defRadius
    const fl = tan(off.xy.add(grid.xy.mul(off.z)).div(R).mul(QUARTER_PI)).mul(R)
    const d0 = normalize(faceU.element(face).mul(fl.x).add(faceV.element(face).mul(fl.y)).add(faceC.element(face).mul(R))).toVar()
    const vRel = d0.sub(tu.camDir).mul(R).sub(tu.camDir.mul(tu.camAlt)).toVar()
    vH.assign(spec.composeHeight(d0))
    vDir.assign(d0)
    vRelP.assign(vRel)
    return tu.camRender.add(toLocal(vRel))
  })()

  const colorNode = Fn(() => {
    If(vH.greaterThan(LAND_ABOVE_SEA_DISCARD_M), () => { Discard() })
    const R = tu.defRadius
    const t = u.time
    const sun = u.sunDir
    const uz = normalize(vDir).toVar()
    const ux = normalize(cross(select(abs(uz.y).lessThan(0.99), vec3(0, 1, 0), vec3(1, 0, 0)), uz)).toVar()
    const uy = cross(uz, ux).toVar()
    const tangent = (q) => vec2(dot(q, ux), dot(q, uy))
    const flatDist = length(vRelP).toVar()
    const rayDir = vRelP.div(max(flatDist, 1e-4)).toVar()
    const viewW = rayDir.negate()
    const wpFlat = tangent(vRelP.add(u.camMod)).toVar()
    const slopeAt = (p, o0, o1) => {
      const h = seaHeight(p, t, o0, o1, u.amp, u.choppy)
      return vec2(seaHeight(p.add(vec2(SLOPE_EPS_M, 0)), t, o0, o1, u.amp, u.choppy).sub(h), seaHeight(p.add(vec2(0, SLOPE_EPS_M)), t, o0, o1, u.amp, u.choppy).sub(h)).div(SLOPE_EPS_M)
    }
    const color = vec3(0).toVar()

    If(u.underwater.greaterThan(0.5), () => {
      const slopeW = slopeAt(wpFlat, int(0), int(SEA_OCTAVES))
      const wn = normalize(uz.sub(ux.mul(slopeW.x)).sub(uy.mul(slopeW.y)))
      const ndl = max(dot(wn, sun), 0.0)
      const depthAtten = exp(max(0.0, tu.camAlt.negate()).mul(-0.0005))
      const wcol = vec3(0.005, 0.06, 0.18).add(vec3(1.0, 0.6, 0.3).mul(depthAtten.mul(ndl).mul(0.4))).add(vec3(0.0, 0.02, 0.06).mul(length(slopeW))).toVar()
      const snell = smoothstep(0.50, 0.82, abs(dot(viewW, wn)))
      wcol.assign(mix(wcol, vec3(0.40, 0.60, 0.85).mul(ndl.mul(0.9).add(0.5)), snell.mul(0.85)))
      wcol.addAssign(vec3(1.0, 0.92, 0.70).mul(pow(max(dot(viewW, sun), 0.0), 180.0)).mul(snell.mul(0.6).add(0.4)))
      color.assign(acesDisplay(wcol))
    }).Else(() => {
      const camUz = dot(tu.camDir, uz)
      const dc = tu.camDir.sub(uz)
      const rayH0 = tu.camAlt.mul(camUz).sub(R.mul(0.5).mul(dot(dc, dc))).toVar()
      const rayDirUz = dot(rayDir, uz).toVar()
      const surfaceGap = (ti) => rayH0.add(ti.mul(rayDirUz)).sub(seaHeight(tangent(u.camMod.add(rayDir.mul(ti))), t, int(0), int(SEA_OCTAVES), u.amp, u.choppy).sub(u.seaMean))
      const tHit = flatDist.toVar()
      const wpW = wpFlat.toVar()
      If(flatDist.lessThanEqual(MARCH_NEAR_M), () => {
        const tMin = float(0).toVar(), tMax = flatDist.mul(1.5).toVar()
        const stepT = tMax.div(MARCH_STEPS)
        const found = float(0).toVar()
        Loop({ start: int(1), end: int(MARCH_STEPS + 1), type: 'int', condition: '<' }, ({ i }) => {
          const ti = stepT.mul(float(i))
          If(found.lessThan(0.5).and(surfaceGap(ti).lessThan(0.0)), () => { tMin.assign(ti.sub(stepT)); tMax.assign(ti); found.assign(1.0) })
        })
        const bisectN = int(clamp(float(5.0).sub(flatDist.sub(30.0).div(36.0)), 2.0, 5.0))
        Loop({ start: int(0), end: int(BISECT_MAX), type: 'int', condition: '<' }, ({ i }) => {
          If(i.lessThan(bisectN), () => {
            const tMid = tMin.add(tMax).mul(0.5).toVar()
            If(surfaceGap(tMid).lessThan(0.0), () => { tMax.assign(tMid) }).Else(() => { tMin.assign(tMid) })
          })
        })
        tHit.assign(tMin.add(tMax).mul(0.5))
        wpW.assign(tangent(u.camMod.add(rayDir.mul(tHit))))
      })
      const nearFade = clamp(float(1.0).sub(tHit.div(120.0)), 0.0, 1.0)
      const farFade = clamp(tHit.sub(30.0).div(60.0), 0.0, 1.0).mul(clamp(float(1.0).sub(tHit.div(300.0)), 0.0, 1.0))
      const nearStart = int(clamp(float(2.0).sub(tHit.div(40.0)), 0.0, 2.0))
      const nearEnd = int(clamp(float(8.0).sub(tHit.div(60.0)), 6.0, 8.0))
      const lf = seaHeightLF(wpFlat, t, u.amp, u.choppy)
      const slopeFar = vec2(seaHeightLF(wpFlat.add(vec2(SLOPE_EPS_LF_M, 0)), t, u.amp, u.choppy).sub(lf), seaHeightLF(wpFlat.add(vec2(0, SLOPE_EPS_LF_M)), t, u.amp, u.choppy).sub(lf)).div(SLOPE_EPS_LF_M)
      const slopeW = slopeAt(wpW, nearStart, nearEnd).mul(nearFade).mul(clamp(vH.negate().div(6.0), 0.0, 1.0)).add(slopeFar.mul(farFade)).toVar()
      const wn = normalize(uz.sub(ux.mul(slopeW.x)).sub(uy.mul(slopeW.y))).toVar()
      const skyZenith = vec3(0.15, 0.45, 0.95), skyHorizon = vec3(0.55, 0.75, 1.00)
      const reflDir = reflect(rayDir, wn)
      const reflSun = max(dot(reflDir, sun), 0.0)
      const skyRefl = mix(skyZenith, skyHorizon, pow(float(1.0).sub(max(dot(reflDir, uz), 0.0)), 3.0))
        .add(vec3(1.0, 0.9, 0.7).mul(pow(reflSun, 8.0).mul(0.8))).add(vec3(1.0, 0.85, 0.55).mul(pow(reflSun, 16.0).mul(0.4)))
      const NoV = max(dot(wn, viewW), 0.0)
      const NoL = max(dot(wn, sun), 0.0)
      const deepColor = vec3(0.04, 0.34, 0.52)
      const refrW = float(1.0).sub(smoothstep(250.0, 350.0, tHit))
      const refrUV = clamp(screenUV.add(vec2(slopeW.x, slopeW.y.negate()).mul(refrW.mul(NoV).mul(0.36))), vec2(0.001), vec2(0.999))
      const refrScene = sceneLinearToDisplayReferred(viewportSharedTexture(refrUV, float(0)).rgb)
      const refrCol = mix(refrScene, deepColor, step(dot(refrScene, vec3(1.0)), 0.01))
      const absorb = exp(vec3(0.09, 0.028, 0.012).negate().mul(max(vH.negate(), 0.0).div(max(NoV, 0.10)))).toVar()
      const waterBody = refrCol.mul(absorb).mul(0.40).add(deepColor.mul(vec3(1.0).sub(absorb)))
      const fresnel = pow(float(1.0).sub(NoV), 5.0).mul(0.98).add(0.02)
      const reflW = fresnel.mul(float(1.0).sub(dot(absorb, vec3(1.0 / 3.0))))
      const wcol = mix(waterBody, mix(deepColor, skyRefl, 0.7), reflW).add(pow(reflSun, 64.0).mul(0.5)).toVar()
      const foamNoise = seaNoise(wpW.mul(0.7).add(vec2(t.mul(0.02), t.mul(-0.03))))
      const foamUV = wpW.mul(4.0).add(vec2(t.mul(1.4), t.mul(0.9)))
      const patchMask = mix(foamNoise, mix(seaOctave(foamUV, u.choppy), seaOctave(foamUV.mul(0.5).add(vec2(1.3, 2.7)), u.choppy.mul(0.7)), 0.4), 0.6)
      const crest = clamp(length(slopeW).sub(0.45).mul(2.0), 0.0, 1.0)
      const foamAmt = clamp(crest.mul(patchMask.mul(0.6).add(0.4)).mul(u.foam), 0.0, 1.0)
      wcol.assign(mix(wcol, vec3(0.95, 0.98, 1.0), foamAmt.mul(NoL.mul(0.35).add(0.15))))
      const fogW = tHit.div(tHit.add(max(R, 1.0)))
      wcol.assign(mix(wcol, mix(skyHorizon, skyZenith, max(dot(viewW, uz), 0.0)).mul(0.5), fogW.mul(u.hazeMul)))
      color.assign(acesDisplay(wcol))
    })
    return vec4(displayReferredToSceneLinear(color), 1.0)
  })()

  const material = new THREE.MeshBasicNodeMaterial()
  material.name = 'mapspinner-water-tsl'
  material.positionNode = positionNode
  material.colorNode = colorNode
  material.transparent = true
  material.forceSinglePass = true
  material.depthWrite = true
  material.side = THREE.DoubleSide

  const grid = buildGridGeometry(WATER_GRID)
  let geo = null, offsets = null, faces = null, capacity = 0
  const mesh = new THREE.Mesh(undefined, material)
  mesh.name = 'mapspinner-water-tsl'
  mesh.frustumCulled = false
  mesh.matrixAutoUpdate = false
  mesh.castShadow = false
  mesh.receiveShadow = false

  function ensureCapacity(n) {
    if (n <= capacity) return
    capacity = Math.max(64, capacity * 2, n)
    if (geo) geo.dispose()
    geo = new THREE.InstancedBufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(grid.vertices, 3))
    geo.setIndex(new THREE.BufferAttribute(grid.indices, 1))
    offsets = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
    faces = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1)
    geo.setAttribute('iOffset', offsets)
    geo.setAttribute('iFace', faces)
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity)
    geo.instanceCount = 0
    mesh.geometry = geo
  }
  ensureCapacity(256)

  const seen = new Set()
  function setQuads(srcOffsets, srcFaces, n) {
    ensureCapacity(n)
    seen.clear()
    const o = offsets.array, f = faces.array
    let wc = 0
    for (let i = 0; i < n; i++) {
      let ox = srcOffsets[i * 4], oy = srcOffsets[i * 4 + 1], l = srcOffsets[i * 4 + 2], lv = srcOffsets[i * 4 + 3]
      if (lv > WATER_MAX_LEVEL) {
        const A = l * (1 << (lv - WATER_MAX_LEVEL))
        ox = Math.floor(ox / A) * A; oy = Math.floor(oy / A) * A; l = A; lv = WATER_MAX_LEVEL
      }
      const face = srcFaces[i]
      const key = ((face * WATER_KEY_SPAN + Math.round(oy / l) + WATER_KEY_SPAN / 2) * WATER_KEY_SPAN + Math.round(ox / l) + WATER_KEY_SPAN / 2) * (WATER_MAX_LEVEL + 1) + lv
      if (seen.has(key)) continue
      seen.add(key)
      o[wc * 4] = ox; o[wc * 4 + 1] = oy; o[wc * 4 + 2] = l; o[wc * 4 + 3] = lv
      f[wc] = face
      wc++
    }
    geo.instanceCount = wc
    offsets.clearUpdateRanges(); offsets.addUpdateRange(0, wc * 4); offsets.needsUpdate = true
    faces.clearUpdateRanges(); faces.addUpdateRange(0, wc); faces.needsUpdate = true
    return wc
  }

  function update({ camWorldPos, camDist, R, sunDir, time, ocean }) {
    const m = (v) => v - Math.floor(v / WAVE_TILE_M) * WAVE_TILE_M
    u.camMod.value.set(m(camWorldPos[0]), m(camWorldPos[1]), m(camWorldPos[2]))
    u.sunDir.value.set(sunDir[0], sunDir[1], sunDir[2]).normalize()
    u.time.value = time || 0
    const amp = ocean && ocean.oceanAmplitude != null ? ocean.oceanAmplitude : DEFAULT_OCEAN.amplitude
    const choppy = ocean && ocean.oceanChoppiness != null ? ocean.oceanChoppiness : DEFAULT_OCEAN.choppiness
    u.amp.value = amp
    u.choppy.value = choppy
    u.foam.value = ocean && ocean.oceanFoam != null ? ocean.oceanFoam : DEFAULT_OCEAN.foam
    u.seaMean.value = seaHeightMean(choppy, amp)
    u.underwater.value = camDist < R - UNDERWATER_BELOW_M ? 1 : 0
    const w = typeof window !== 'undefined' ? window : null
    u.hazeMul.value = w && Number.isFinite(w.__hazeMul) ? w.__hazeMul : TD.hazeMul
    mesh.visible = !(w && w.__waterSurface === false)
  }

  function dispose() { if (geo) geo.dispose(); material.dispose() }

  return { mesh, material, uniforms: u, setQuads, update, dispose }
}
