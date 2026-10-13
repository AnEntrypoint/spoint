import * as THREE from 'three'
import { Fn, uniform, vec3, vec4, float, clamp, mix, dot, pow, output, materialColor } from 'three/tsl'
import { displayReferredToSceneLinear } from '/node_modules/mapspinner/src/tsl/display-referred-tsl.js'
import { ATM_RAYLEIGH } from '/node_modules/mapspinner/src/atmosphere-transmittance-lut.js'
import { ATM_SOLAR_IRRADIANCE } from '/node_modules/mapspinner/src/tsl/sky-tsl.js'
import { TERRAIN_DEFAULTS as TD } from '/node_modules/mapspinner/src/terrain-defaults.js'
import { vegetationAmbientDelta, NIGHT_FILL, INV_PI } from '/node_modules/mapspinner/src/tsl/terrain-ambient-shared.js'

// Trees and every other standard-lit surface on this planet are lit by three's own lights, while
// the terrain is lit by terrain-lighting-tsl.js. At noon the sun term dominates and the two agree;
// at dusk the direct term collapses (NdotL falls with the sun) and what is left is the ambient, and
// the two paths' ambient differs -- so the vegetation reads darker than the ground it stands on.
//
// This module closes that gap at the vegetation layer: it adds the terrain's sky irradiance and its
// albedo-independent ambient floor to the vegetation's lit colour, and then puts the vegetation
// through the terrain's own grade (dayShade, exposure, saturation, contrast). Nothing here dims the
// terrain, and every number comes from terrain-ambient-shared.js, the module the terrain model
// itself reads.

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

function windowNum(name, fallback) {
  if (typeof window === 'undefined') return fallback
  const v = window['__' + name]
  return Number.isFinite(v) ? v : fallback
}

// Called once per frame with the same time-of-day state terrain-lighting-tsl.js reads.
export function updateVegetationTerrainAmbient(tod, u = vegAmbientUniforms) {
  const muS = Number.isFinite(tod && tod.elevationDeg) ? Math.sin(tod.elevationDeg * Math.PI / 180) : 1
  const skyFill = windowNum('skyFill', TD.skyFill)
  const termWidth = windowNum('termWidth', TD.termWidth)
  const nightFloor = windowNum('nightFloor', TD.nightFloor)
  const nightLights = windowNum('nightLights', TD.nightLights)

  let ambIrr = [0.14, 0.14, 0.14]
  if (tod && Number.isFinite(tod.ambientIntensity) && Number.isFinite(tod.ambientColor)) {
    _c.setHex(tod.ambientColor)
    ambIrr = [_c.r * tod.ambientIntensity * INV_PI, _c.g * tod.ambientIntensity * INV_PI, _c.b * tod.ambientIntensity * INV_PI]
  }

  const d = vegetationAmbientDelta({ muS, skyFill, solar: ATM_SOLAR_IRRADIANCE, rayleigh: ATM_RAYLEIGH, ambIrr, termWidth, nightFloor })
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
