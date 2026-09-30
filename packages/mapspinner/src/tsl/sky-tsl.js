import * as THREE from 'three/webgpu'
import {
  Fn, float, int, vec2, vec3, vec4, uniform, texture, select, positionLocal,
  normalize, dot, length, sqrt, max, min, clamp, mix, smoothstep, pow, floor, atanh,
} from 'three/tsl'
import { bakeTransmittanceLUT, ATM_BOTTOM, ATM_TOP, ATM_RAYLEIGH } from '../atmosphere-transmittance-lut.js'
import { bakeScatteringLUT, SCAT_LUT_LAYERS } from '../atmosphere-scattering-lut.js'
import { displayReferredToSceneLinear } from './display-referred-tsl.js'

const ATM_MIE_SCAT = 0.003996
const ATM_MIE_G = 0.8
const ATM_SOLAR_IRRADIANCE = [1.474, 1.8504, 1.91198]
const ATM_SUN_ANGULAR_RADIUS = 0.004675
const ATM_RHO_MAX = Math.sqrt(ATM_TOP * ATM_TOP - ATM_BOTTOM * ATM_BOTTOM)
const ATM_SCAT_K = 1.4
const ATM_HORIZON_BLEND_MU = 0.006
const MIE_K = (3 / (8 * Math.PI)) * (1 - ATM_MIE_G * ATM_MIE_G) / (2 + ATM_MIE_G * ATM_MIE_G)
const RAYLEIGH_PHASE_K = 3 / (16 * Math.PI)
const SKY_TINT = [0.82, 0.95, 1.22]
const SKY_EXPOSURE_HIGH_SUN = 14.0
const SKY_EXPOSURE_LOW_SUN = 48.0
const SKY_SATURATION = 1.3
const HALO_COLOR = [0.32, 0.55, 1.0]
const SKY_FADE_ALTITUDE_M = 100000.0

function halfFloatRGBA(src, texelCount, channels) {
  const out = new Uint16Array(texelCount * 4)
  for (let i = 0; i < texelCount; i++) {
    for (let c = 0; c < 4; c++) out[i * 4 + c] = THREE.DataUtils.toHalfFloat(c < channels ? src[i * channels + c] : 1)
  }
  return out
}

function lutTexture(tex) {
  tex.format = THREE.RGBAFormat
  tex.type = THREE.HalfFloatType
  tex.magFilter = tex.minFilter = THREE.LinearFilter
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  tex.generateMipmaps = false
  tex.needsUpdate = true
  return tex
}

export function createSkyTSL({ radius }) {
  const trans = bakeTransmittanceLUT()
  const scat = bakeScatteringLUT(undefined, undefined, undefined, undefined, trans)
  const transTex = lutTexture(new THREE.DataTexture(halfFloatRGBA(trans.data, trans.width * trans.height, 3), trans.width, trans.height))
  const scatTex = lutTexture(new THREE.DataArrayTexture(halfFloatRGBA(scat.data, scat.width * scat.height * scat.layers, 4), scat.width, scat.height, scat.layers))

  const u = {
    camAtm: uniform(new THREE.Vector3(0, ATM_BOTTOM + 0.01, 0)),
    sunDir: uniform(new THREE.Vector3(0, 1, 0)),
    east: uniform(new THREE.Vector3(1, 0, 0)),
    up: uniform(new THREE.Vector3(0, 1, 0)),
    north: uniform(new THREE.Vector3(0, 0, 1)),
    fade: uniform(1.0),
  }
  const rayleigh = vec3(...ATM_RAYLEIGH)
  const solar = vec3(...ATM_SOLAR_IRRADIANCE)

  const distToTop = (r, mu) => {
    const disc = r.mul(r).mul(mu.mul(mu).sub(1.0)).add(ATM_TOP * ATM_TOP)
    return select(disc.lessThan(0.0), float(-1.0), max(r.negate().mul(mu).add(sqrt(max(disc, 0.0))), 0.0))
  }
  const distToGround = (r, mu) => r.negate().mul(mu).sub(sqrt(max(r.mul(r).mul(mu.mul(mu).sub(1.0)).add(ATM_BOTTOM * ATM_BOTTOM), 0.0)))
  const lutUV = (r, mu) => {
    const rho = sqrt(max(r.mul(r).sub(ATM_BOTTOM * ATM_BOTTOM), 0.0))
    const dMin = float(ATM_TOP).sub(r)
    const dMax = rho.add(ATM_RHO_MAX)
    const v = select(dMax.greaterThan(dMin), clamp(distToTop(r, mu).sub(dMin).div(dMax.sub(dMin)), 0.0, 1.0), float(0.0))
    return vec2(clamp(rho.div(ATM_RHO_MAX), 0.0, 1.0), v)
  }
  const transmittance = (r, mu) => texture(transTex, lutUV(r, mu)).level(0).rgb
  const scattering = (r, mu, muS) => {
    const t = atanh(clamp(muS.mul(Math.tanh(ATM_SCAT_K)), -0.999999, 0.999999)).div(ATM_SCAT_K)
    const lf = clamp(clamp(t.add(1.0).mul(0.5), 0.0, 1.0).mul(SCAT_LUT_LAYERS).sub(0.5), 0.0, SCAT_LUT_LAYERS - 1)
    const l0 = floor(lf)
    const l1 = min(l0.add(1.0), SCAT_LUT_LAYERS - 1)
    const uv = lutUV(r, mu)
    return mix(texture(scatTex, uv).depth(int(l0)).level(0), texture(scatTex, uv).depth(int(l1)).level(0), lf.sub(l0))
  }
  const rayleighPhase = (nu) => nu.mul(nu).add(1.0).mul(RAYLEIGH_PHASE_K)
  const miePhase = (nu) => {
    const base = max(nu.mul(-2 * ATM_MIE_G).add(1 + ATM_MIE_G * ATM_MIE_G), 1e-4)
    return nu.mul(nu).add(1.0).mul(MIE_K).div(base.mul(sqrt(base)))
  }

  const marchRadiance = (camera, ray, sun, dEnd) => {
    const r = length(camera)
    const mu = dot(camera, ray).div(r)
    const muS = dot(camera, sun).div(r)
    const nu = dot(ray, sun)
    const dTop = distToTop(r, mu)
    const full = scattering(r, mu, muS).toVar()
    const tFull = transmittance(r, mu).toVar()
    const pEnd = camera.add(ray.mul(dEnd)).toVar()
    const rEnd = length(pEnd).toVar()
    const muEnd = dot(pEnd, ray).div(rEnd).toVar()
    const tail = scattering(rEnd, muEnd, dot(pEnd, sun).div(rEnd)).toVar()
    const tToEnd = tFull.div(max(transmittance(rEnd, muEnd), vec3(1e-6))).toVar()
    const hasTail = dEnd.lessThan(dTop.sub(1e-4))
    const inscatR = select(hasTail, max(full.rgb.sub(tToEnd.mul(tail.rgb)), vec3(0.0)), full.rgb)
    const inscatM = select(hasTail, max(full.a.sub(dot(tToEnd, vec3(1 / 3)).mul(tail.a)), 0.0), full.a)
    const trans = select(hasTail, tToEnd, tFull)
    const radiance = solar.mul(inscatR.mul(rayleigh).mul(rayleighPhase(nu)).add(vec3(inscatM.mul(ATM_MIE_SCAT).mul(miePhase(nu)))))
    return { radiance: select(dTop.greaterThan(0.0), radiance, vec3(0.0)), trans: select(dTop.greaterThan(0.0), trans, vec3(1.0)) }
  }

  const node = Fn(() => {
    const v = normalize(positionLocal)
    const ray = normalize(u.east.mul(v.x).add(u.up.mul(v.y)).add(u.north.mul(v.z))).toVar()
    const sun = u.sunDir
    const camIn = u.camAtm
    const rIn = length(camIn)
    const dtIn = distToTop(rIn, dot(camIn, ray).div(rIn))
    const camera = select(rIn.greaterThan(ATM_TOP).and(dtIn.greaterThan(0.0)), camIn.add(ray.mul(dtIn)), camIn).toVar()
    const r = length(camera)
    const mu = dot(camera, ray).div(r)
    const muTangent = sqrt(max(float(1.0).sub(float(ATM_BOTTOM * ATM_BOTTOM).div(r.mul(r))), 0.0)).negate()
    const wSky = smoothstep(muTangent.sub(ATM_HORIZON_BLEND_MU), muTangent.add(ATM_HORIZON_BLEND_MU), mu)
    const sky = marchRadiance(camera, ray, sun, distToTop(r, mu))
    const ground = marchRadiance(camera, ray, sun, max(distToGround(r, mu), 1e-3))
    const skyVisible = distToTop(r, mu).greaterThan(0.0).and(rIn.lessThanEqual(ATM_TOP).or(dtIn.greaterThanEqual(0.0)))
    const radianceBase = select(skyVisible, mix(ground.radiance, sky.radiance, wSky), vec3(0.0))
    const trans = select(skyVisible, mix(vec3(0.0), sky.trans, wSky), vec3(1.0))

    const rc = length(camIn)
    const muc = dot(camIn, ray).div(rc)
    const b = rc.mul(sqrt(max(float(1.0).sub(muc.mul(muc)), 0.0)))
    const t0 = b.sub(ATM_BOTTOM).div(ATM_TOP - ATM_BOTTOM)
    const halo = select(muc.lessThan(0.0), smoothstep(0.0, 0.06, t0).mul(float(1.0).sub(smoothstep(0.25, 1.6, t0))), float(0.0))
    const limbDir = normalize(camIn.add(ray.mul(rc.negate().mul(muc))))
    const lit = smoothstep(-0.5, 0.6, dot(limbDir, sun)).mul(0.75).add(0.25)
    const sunDisc = select(dot(ray, sun).greaterThan(Math.cos(ATM_SUN_ANGULAR_RADIUS)), trans.mul(solar).mul(6.0), vec3(0.0))
    const radiance = radianceBase.add(vec3(...HALO_COLOR).mul(halo.mul(lit).mul(0.03))).add(sunDisc)

    const sunElevDot = clamp(dot(sun, normalize(camIn)), 0.0, 1.0)
    const c = radiance.mul(vec3(...SKY_TINT)).mul(mix(SKY_EXPOSURE_LOW_SUN, SKY_EXPOSURE_HIGH_SUN, sunElevDot))
    const aces = clamp(c.mul(c.mul(2.51).add(0.03)).div(c.mul(c.mul(2.43).add(0.59)).add(0.14)), 0.0, 1.0)
    const mapped = clamp(mix(vec3(dot(aces, vec3(0.2126, 0.7152, 0.0722))), aces, SKY_SATURATION), 0.0, 1.0)
    return vec4(displayReferredToSceneLinear(pow(mapped, vec3(1 / 2.2)).mul(u.fade)), 1.0)
  })()

  function update({ camWorldPos, sunDir, view }) {
    const s = ATM_BOTTOM / radius
    u.camAtm.value.set(camWorldPos[0] * s, camWorldPos[1] * s, camWorldPos[2] * s)
    u.sunDir.value.set(sunDir[0], sunDir[1], sunDir[2]).normalize()
    u.east.value.set(view.east[0], view.east[1], view.east[2])
    u.up.value.set(view.up[0], view.up[1], view.up[2])
    u.north.value.set(view.north[0], view.north[1], view.north[2])
    u.fade.value = Math.max(0.0, 1.0 - (Math.hypot(camWorldPos[0], camWorldPos[1], camWorldPos[2]) - radius) / SKY_FADE_ALTITUDE_M)
  }

  function dispose() { transTex.dispose(); scatTex.dispose() }

  return { node, update, dispose, uniforms: u }
}
