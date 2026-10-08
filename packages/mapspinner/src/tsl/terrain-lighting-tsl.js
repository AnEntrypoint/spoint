import * as THREE from 'three/webgpu'
import {
  float, vec3, vec4, uniform, normalize, dot, max, clamp, mix, smoothstep, pow, length, select, luminance,
  normalView, diffuseColor, If,
} from 'three/tsl'
import { TERRAIN_DEFAULTS as TD } from '../terrain-defaults.js'
import { displayReferredToSceneLinear } from './display-referred-tsl.js'
import { ATM_RAYLEIGH } from '../atmosphere-transmittance-lut.js'

const INV_PI = 1 / Math.PI
const SUN_IRRADIANCE_GAIN = 1.25
const SKY_BALANCE_TO_GREY = 0.35
const SKY_FILL_TINT = [0.85, 0.92, 1.10]
const SKY_HAZE_TINT = [0.40, 0.55, 0.78]
const TERMINATOR_TINT = [1.0, 0.55, 0.34]
const NIGHT_FILL = [0.06, 0.075, 0.11]
const AMBIENT_FLOOR_ALBEDO = 0.14
const AMBIENT_FLOOR_ADD = [0.020, 0.026, 0.038]
const AP_GATE_KM = [3.0, 120.0]
const SUN_DARK_LUMINANCE = 1e-4
const SHADOW_CASCADE_NAME_PREFIX = 'shadowCascade'
const RAYLEIGH_SKY_TINT = 0.4
const SKY_DAY_MU = [-0.10, 0.25]

export function createLegacyTerrainLighting({ sky, planetNormal, up, wetPool, viewDirPlanet, relAtm, rayleigh = ATM_RAYLEIGH }) {
  const u = {
    sunPlanet: sky.uniforms.sunDir,
    sunLum: uniform(1.0),
    skyFill: uniform(TD.skyFill),
    hazeMul: uniform(TD.hazeMul),
    terminatorGlow: uniform(TD.terminatorGlow),
    nightLights: uniform(TD.nightLights),
    nightFloor: uniform(TD.nightFloor),
    termWidth: uniform(TD.termWidth),
    exposure: uniform(TD.exposure),
    lookSat: uniform(TD.lookSat),
    lookContrast: uniform(TD.lookContrast),
  }
  const solar = sky.solarIrradiance
  const sunIrrBase = solar.mul(sky.transmittanceToSunAtGround(up, u.sunPlanet))
  const muS = dot(up, u.sunPlanet)
  const skyTint = mix(vec3(1.0), vec3(rayleigh[0] / rayleigh[0], rayleigh[1] / rayleigh[0], rayleigh[2] / rayleigh[0]), RAYLEIGH_SKY_TINT)
  const skyIrr = solar.mul(0.075).mul(smoothstep(SKY_DAY_MU[0], SKY_DAY_MU[1], muS)).mul(skyTint).mul(dot(planetNormal, up).add(1.0).mul(0.5))
  const skyBalanced = mix(vec3(luminance(skyIrr)), skyIrr, SKY_BALANCE_TO_GREY).mul(u.skyFill).mul(vec3(...SKY_FILL_TINT))
  const sunRef = { light: null }
  const sunFlags = new WeakMap()
  const sunFlagFor = (light) => {
    let flag = sunFlags.get(light)
    if (!flag) { flag = uniform(0).onRenderUpdate(() => (light === sunRef.light ? 1 : 0)); sunFlags.set(light, flag) }
    return flag
  }
  const poolFresnel = pow(float(1.0).sub(max(dot(planetNormal, viewDirPlanet), 0.0)), 5.0).mul(0.98).add(0.02)
  const poolWeight = poolFresnel.mul(wetPool.pool)
  const poolKeep = float(1.0).sub(poolWeight)

  class LegacyTerrainLightingModel extends THREE.LightingModel {
    direct({ lightDirection, lightColor, lightNode, reflectedLight }) {
      const light = lightNode && lightNode.light
      if (light && light.isDirectionalLight) {
        if (light.name.startsWith(SHADOW_CASCADE_NAME_PREFIX)) return
        const shadowK = select(u.sunLum.greaterThan(SUN_DARK_LUMINANCE), clamp(luminance(lightColor).div(u.sunLum), 0.0, 1.0), float(1.0))
        const sunIrr = sunIrrBase.mul(dot(planetNormal, u.sunPlanet).clamp()).mul(shadowK)
        const halfPlanet = normalize(u.sunPlanet.add(viewDirPlanet))
        const spec = pow(max(dot(planetNormal, halfPlanet), 0.0), wetPool.specExp).mul(wetPool.specExp.add(8.0)).mul(1 / (8 * Math.PI))
        reflectedLight.directDiffuse.addAssign(diffuseColor.rgb.mul(sunIrr).mul(SUN_IRRADIANCE_GAIN * INV_PI).mul(poolKeep).add(sunIrr.mul(spec).mul(poolWeight)).mul(sunFlagFor(light)))
        return
      }
      reflectedLight.directDiffuse.addAssign(diffuseColor.rgb.mul(lightColor).mul(normalView.dot(lightDirection).clamp()).mul(INV_PI))
    }

    indirect({ context }) {
      const floor = diffuseColor.rgb.mul(AMBIENT_FLOOR_ALBEDO).add(vec3(...AMBIENT_FLOOR_ADD))
      const skyLit = diffuseColor.rgb.mul(skyBalanced).mul(INV_PI).add(floor).mul(poolKeep).add(skyIrr.mul(INV_PI).mul(poolWeight))
      context.reflectedLight.indirectDiffuse.addAssign(skyLit)
    }
  }

  function gradeOutput(outputNode) {
    const lit = outputNode.rgb
    const dKm = length(relAtm)
    const apGate = smoothstep(AP_GATE_KM[0], AP_GATE_KM[1], dKm)
    const apTrans = vec3(1.0).toVar()
    const apRad = vec3(0.0).toVar()
    If(apGate.greaterThan(0.0), () => {
      const ray = relAtm.div(max(dKm, 1e-4))
      const ap = sky.marchRadiance(sky.uniforms.camAtm, ray, u.sunPlanet, max(dKm, 1e-3))
      apTrans.assign(ap.trans)
      apRad.assign(ap.radiance)
    })
    const apInscat = max(apRad, u.skyFill.mul(vec3(...SKY_HAZE_TINT)).mul(vec3(1.0).sub(apTrans)))
    const nwSun = dot(up, u.sunPlanet)
    const graze = smoothstep(0.55, 1.0, float(1.0).sub(nwSun.abs()))
    const glow = u.terminatorGlow.mul(graze.mul(graze)).mul(smoothstep(-0.02, 0.18, nwSun)).mul(apGate)
    const hazed = lit.mul(apTrans).add(apInscat).add(vec3(...TERMINATOR_TINT).mul(glow))
    const color = mix(lit, hazed, apGate.mul(u.hazeMul))
    const dayShade = mix(u.nightFloor, 1.0, smoothstep(u.termWidth.negate(), u.termWidth, nwSun))
    const c = color.mul(dayShade).add(vec3(...NIGHT_FILL).mul(u.nightLights).mul(float(1.0).sub(dayShade))).mul(u.exposure)
    const aces = clamp(c.mul(c.mul(2.51).add(0.03)).div(c.mul(c.mul(2.43).add(0.59)).add(0.14)), 0.0, 1.0)
    const sat = mix(vec3(dot(aces, vec3(0.2126, 0.7152, 0.0722))), aces, u.lookSat)
    const graded = clamp(sat.sub(0.5).mul(u.lookContrast).add(0.5), 0.0, 1.0)
    return vec4(displayReferredToSceneLinear(pow(graded, vec3(1.0 / 2.2))), outputNode.a)
  }

  function update({ sunLight }) {
    const w = typeof window !== 'undefined' ? window : null
    const g = (name, fallback) => (w && Number.isFinite(w['__' + name]) ? w['__' + name] : fallback)
    u.skyFill.value = g('skyFill', TD.skyFill)
    u.hazeMul.value = g('hazeMul', TD.hazeMul)
    u.terminatorGlow.value = g('terminatorGlow', TD.terminatorGlow)
    u.nightLights.value = g('nightLights', TD.nightLights)
    u.nightFloor.value = g('nightFloor', TD.nightFloor)
    u.termWidth.value = g('termWidth', TD.termWidth)
    u.exposure.value = g('exposure', TD.exposure)
    u.lookSat.value = g('lookSat', TD.lookSat)
    u.lookContrast.value = g('lookContrast', TD.lookContrast)
    const light = sunLight && sunLight.isDirectionalLight ? sunLight : null
    sunRef.light = light
    u.sunLum.value = light ? light.intensity * (0.2126 * light.color.r + 0.7152 * light.color.g + 0.0722 * light.color.b) : 0
  }

  return { LightingModel: LegacyTerrainLightingModel, gradeOutput, update, uniforms: u }
}
