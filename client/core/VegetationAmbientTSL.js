import * as THREE from 'three'
import { Fn, uniform, vec3, vec4, float, clamp, mix, dot, pow, output, materialColor } from 'three/tsl'
import { displayReferredToSceneLinear } from '/node_modules/mapspinner/src/tsl/display-referred-tsl.js'
import { ATM_RAYLEIGH } from '/node_modules/mapspinner/src/atmosphere-transmittance-lut.js'
import { ATM_SOLAR_IRRADIANCE } from '/node_modules/mapspinner/src/tsl/sky-tsl.js'
import { TERRAIN_DEFAULTS as TD } from '/node_modules/mapspinner/src/terrain-defaults.js'
import { vegetationAmbientDelta, NIGHT_FILL, INV_PI } from '/node_modules/mapspinner/src/tsl/terrain-ambient-shared.js'


export const vegAmbientUniforms = {
  uVegAmbMul: uniform(new THREE.Vector3(0, 0, 0)),
  uVegAmbAdd: uniform(new THREE.Vector3(0, 0, 0)),
  uVegNightFill: uniform(new THREE.Vector3(0, 0, 0)),
  uVegDayShade: uniform(1.0),
  uVegExposure: uniform(TD.exposure),
  uVegLookSat: uniform(TD.lookSat),
  uVegLookContrast: uniform(TD.lookContrast),
}

const LUMA_W = vec3(0.2126, 0.7152, 0.0722)

function gradeNode(litNode) {
  return Fn(() => {
    const c = litNode.rgb.mul(vegAmbientUniforms.uVegDayShade).add(vegAmbientUniforms.uVegNightFill).mul(vegAmbientUniforms.uVegExposure)
    const aces = clamp(c.mul(c.mul(2.51).add(0.03)).div(c.mul(c.mul(2.43).add(0.59)).add(0.14)), 0.0, 1.0)
    const sat = mix(vec3(dot(aces, LUMA_W)), aces, vegAmbientUniforms.uVegLookSat)
    const graded = clamp(sat.sub(0.5).mul(vegAmbientUniforms.uVegLookContrast).add(0.5), 0.0, 1.0)
    return vec4(displayReferredToSceneLinear(pow(graded, vec3(1.0 / 2.2))), litNode.a)
  })()
}

export function applyVegetationTerrainAmbientTSL(material) {
  const albedo = material.colorNode ? material.colorNode.rgb : materialColor.rgb
  const base = material.outputNode || output
  const corrected = Fn(() => {
    const rgb = base.rgb.add(albedo.mul(vegAmbientUniforms.uVegAmbMul)).add(vegAmbientUniforms.uVegAmbAdd)
    return gradeNode(vec4(rgb, base.a))
  })()
  material.outputNode = corrected
  material.customProgramCacheKey = () => 'veg-terrain-ambient-tsl-v1'
  material.needsUpdate = true
  return material
}

const _c = new THREE.Color()
const _ambIrr = [0.14, 0.14, 0.14]
const _ambDeltaOpts = { muS: 1, skyFill: 0, solar: ATM_SOLAR_IRRADIANCE, rayleigh: ATM_RAYLEIGH, ambIrr: _ambIrr, termWidth: 0, nightFloor: 0 }
const WINDOW_KEYS = { skyFill: '__skyFill', termWidth: '__termWidth', nightFloor: '__nightFloor', nightLights: '__nightLights', exposure: '__exposure', lookSat: '__lookSat', lookContrast: '__lookContrast' }

function windowNum(name, fallback) {
  if (typeof window === 'undefined') return fallback
  const v = window[WINDOW_KEYS[name]]
  return Number.isFinite(v) ? v : fallback
}

export function updateVegetationTerrainAmbient(tod, u = vegAmbientUniforms) {
  const muS = Number.isFinite(tod && tod.elevationDeg) ? Math.sin(tod.elevationDeg * Math.PI / 180) : 1
  const skyFill = windowNum('skyFill', TD.skyFill)
  const termWidth = windowNum('termWidth', TD.termWidth)
  const nightFloor = windowNum('nightFloor', TD.nightFloor)
  const nightLights = windowNum('nightLights', TD.nightLights)

  if (tod && Number.isFinite(tod.ambientIntensity) && Number.isFinite(tod.ambientColor)) {
    _c.setHex(tod.ambientColor)
    _ambIrr[0] = _c.r * tod.ambientIntensity * INV_PI
    _ambIrr[1] = _c.g * tod.ambientIntensity * INV_PI
    _ambIrr[2] = _c.b * tod.ambientIntensity * INV_PI
  } else {
    _ambIrr[0] = _ambIrr[1] = _ambIrr[2] = 0.14
  }

  _ambDeltaOpts.muS = muS
  _ambDeltaOpts.skyFill = skyFill
  _ambDeltaOpts.termWidth = termWidth
  _ambDeltaOpts.nightFloor = nightFloor
  const d = vegetationAmbientDelta(_ambDeltaOpts)
  u.uVegAmbMul.value.set(d.albedoMul[0], d.albedoMul[1], d.albedoMul[2])
  u.uVegAmbAdd.value.set(d.add[0], d.add[1], d.add[2])
  u.uVegDayShade.value = d.dayShade
  const nightAmt = d.nightAmt
  u.uVegNightFill.value.set(
    NIGHT_FILL[0] * nightLights * (1 - d.dayShade) * (1 - nightAmt),
    NIGHT_FILL[1] * nightLights * (1 - d.dayShade) * (1 - nightAmt),
    NIGHT_FILL[2] * nightLights * (1 - d.dayShade) * (1 - nightAmt),
  )
  u.uVegExposure.value = windowNum('exposure', TD.exposure)
  u.uVegLookSat.value = windowNum('lookSat', TD.lookSat)
  u.uVegLookContrast.value = windowNum('lookContrast', TD.lookContrast)
  return d
}
