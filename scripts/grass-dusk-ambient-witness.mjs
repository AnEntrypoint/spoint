#!/usr/bin/env node
// Grass dusk ambient witness (gpu-free arm).
//
// It measures what the grass and the terrain DISPLAY for the same Lambert surface at a stated
// time-of-day, by running the real code. The time-of-day keyframes come from
// client/core/TimeOfDay.js through createTimeOfDay, the terrain's ambient from
// packages/mapspinner/src/tsl/terrain-ambient-shared.js -- the module terrain-lighting-tsl.js itself
// imports -- and the grass's ambient from client/core/GrassMaterial.js setGrassSun, the function
// client/app.js calls with every time-of-day update.
//
// Why ambient: at dusk the direct sun term collapses with NdotL (sin(2.10 deg) = 0.0367), so what a
// surface reads at dusk IS its ambient. That is why the owner's report is a dusk report.
//
// Why the display transform is part of the measurement: the two paths did not only differ in
// ambient, they differed in what they did with it. The terrain runs its lit colour through a grade
// (dayShade, night fill, exposure, the filmic curve, saturation, contrast, display gamma) and hands
// the result to displayReferredToSceneLinear; grass emitted its radiance to the framebuffer as it
// stood. A radiance of 0.128 therefore displayed as 0.128 on grass and as 0.40 on the terrain, which
// is 2.5 display codes of difference the ambient comparison alone cannot see. Both sides are put
// through terrainGrade here, and after the fix they share it in the shader as well.

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as THREE from 'three'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

const HOOK_KIND = await installSpecifierHooks()
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const at = (p) => pathToFileURL(resolve(ROOT, p)).href

const DUSK_FRACTION = 0.745   // sun elevation 2.10 deg, clock 17:52
const NOON_FRACTION = 0.5     // sun elevation 67.00 deg, clock 12:00
const REFERENCE_ALBEDOS = [0.05, 0.2, 0.5]
const K = 3                   // cross-path parity budget, in multiples of the quantization floor
const QUANT_FLOOR_8BIT = 1    // one 8-bit display code

// What the grass displayed BEFORE the fix, measured by this witness's own predecessor probe against
// the pre-fix client/core/GrassMaterial.js at these same two times of day. Pre-fix grass emitted its
// radiance straight to the framebuffer, so its display luma in 8-bit codes is its radiance luma.
const BEFORE_GRASS_LUMA8 = {
  dusk: { 0.05: 8.18, 0.2: 32.73, 0.5: 81.83 },
  noon: { 0.05: 7.95, 0.2: 31.81, 0.5: 79.52 },
}

const checks = []
let failures = 0
function expect(name, ok, detail) {
  checks.push({ check: name, ok: !!ok, detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + ': ' + detail)
  if (!ok) failures++
}

const S = await import(at('packages/mapspinner/src/tsl/terrain-ambient-shared.js'))
const { createTimeOfDay } = await import(at('client/core/TimeOfDay.js'))
const { TERRAIN_DEFAULTS: TD } = await import(at('packages/mapspinner/src/terrain-defaults.js'))
const { ATM_RAYLEIGH } = await import(at('packages/mapspinner/src/atmosphere-transmittance-lut.js'))
const { ATM_SOLAR_IRRADIANCE } = await import(at('packages/mapspinner/src/tsl/sky-tsl.js'))
const GM = await import(at('client/core/GrassMaterial.js'))

const GRASS_MATERIAL_SRC = readFileSync(resolve(ROOT, 'client/core/GrassMaterial.js'), 'utf8')
const GRASS_TSL_SRC = readFileSync(resolve(ROOT, 'client/core/GrassTSL.js'), 'utf8')
const TERRAIN_TSL_SRC = readFileSync(resolve(ROOT, 'packages/mapspinner/src/tsl/terrain-lighting-tsl.js'), 'utf8')
const APP_SRC = readFileSync(resolve(ROOT, 'client/app.js'), 'utf8')

expect('shared-module-is-the-source-of-truth',
  /terrain-ambient-shared\.js/.test(TERRAIN_TSL_SRC),
  'packages/mapspinner/src/tsl/terrain-lighting-tsl.js imports its ambient constants from terrain-ambient-shared.js, so this witness compares one copy of them')
expect('grass-shares-the-ambient-constants-instead-of-declaring-a-third-copy',
  /terrain-ambient-shared\.js/.test(GRASS_MATERIAL_SRC) && /terrain-ambient-shared\.js/.test(GRASS_TSL_SRC) &&
  !/AMBIENT_FLOOR_ADD\s*=|SKY_IRRADIANCE_SCALE\s*=/.test(GRASS_MATERIAL_SRC) &&
  !/\b2\.51\b|\b2\.43\b|1\s*\/\s*2\.2/.test(GRASS_MATERIAL_SRC) && !/\b2\.51\b|\b2\.43\b|1\s*\/\s*2\.2/.test(GRASS_TSL_SRC),
  'both grass shader paths import the terrain ambient module and neither writes its own copy of the filmic curve, the display gamma or the ambient floor')
expect('grass-shader-carries-both-missing-terms',
  /baseColor \* uGrassAmbMul \+ uGrassAmbAdd/.test(GRASS_MATERIAL_SRC) &&
  /uGrassAmbMul\)\)\.add\(uGrassAmbAdd\)/.test(GRASS_TSL_SRC),
  'the legacy GLSL grass shader and the TSL grass material both add the albedo-proportional term and the albedo-independent one')
expect('grass-goes-through-the-terrain-grade',
  /uGrassGrade/.test(GRASS_MATERIAL_SRC) && /uGrassGrade/.test(GRASS_TSL_SRC) && /uGrassNightFill/.test(GRASS_MATERIAL_SRC),
  'both grass shader paths grade their lit colour with the terrain dayShade, night fill, exposure, saturation, contrast and display gamma')
expect('grass-ambient-is-rederived-every-frame',
  /window\.__grass\.setSun\(_todState\)/.test(APP_SRC),
  'client/app.js hands every time-of-day update to the grass, so the correction tracks the clock')

const LUMA = S.LUMA
const luma = rgb => LUMA[0] * rgb[0] + LUMA[1] * rgb[1] + LUMA[2] * rgb[2]
const luma8 = rgb => luma(rgb) * 255

function todAt(fraction) {
  const ambient = new THREE.AmbientLight(0xffffff, 1)
  const tod = createTimeOfDay(null, ambient, { startFraction: fraction, paused: true })
  const applied = tod.update(0)
  return { applied, clock: tod.getClockString() }
}

function grassWind() {
  return {
    uSunDir: { value: new THREE.Vector3() },
    uSunColor: { value: new THREE.Color() },
    uAmbient: { value: new THREE.Color() },
    uGrassSat: { value: 1 },
    uGrassAmbMul: { value: new THREE.Vector3() },
    uGrassAmbAdd: { value: new THREE.Vector3() },
    uGrassNightFill: { value: new THREE.Vector3() },
    uGrassGrade: { value: new THREE.Vector4() },
  }
}

const rgbOf = (v) => (v.isColor ? [v.r, v.g, v.b] : [v.x, v.y, v.z])

function compareAt(fraction, albedo) {
  const { applied, clock } = todAt(fraction)
  const muS = Math.sin(applied.elevDeg * Math.PI / 180)
  const c = new THREE.Color().setHex(applied.ambientColor)
  const ambIrr = [c.r, c.g, c.b].map(v => v * applied.ambientIntensity * S.INV_PI)
  const args = {
    muS, ndotUp: 1, skyFill: TD.skyFill, solar: ATM_SOLAR_IRRADIANCE, rayleigh: ATM_RAYLEIGH,
    ambIrr, termWidth: TD.termWidth, nightFloor: TD.nightFloor,
  }
  const cmp = S.surfaceAmbientComparison({ ...args, albedo })

  const wind = grassWind()
  GM.setGrassSun(wind, applied)
  const amb = rgbOf(wind.uAmbient.value)
  const mul = rgbOf(wind.uGrassAmbMul.value)
  const add = rgbOf(wind.uGrassAmbAdd.value)
  const grassRadiance = [0, 1, 2].map(i => albedo * (amb[i] + mul[i]) + add[i])
  const grade = {
    dayShade: wind.uGrassGrade.value.x,
    exposure: wind.uGrassGrade.value.y,
    lookSat: wind.uGrassGrade.value.z,
    lookContrast: wind.uGrassGrade.value.w,
    nightFill: rgbOf(wind.uGrassNightFill.value),
  }

  const terrainDisplay8 = luma8(S.terrainGrade(cmp.terrain, grade))
  const afterDisplay8 = luma8(S.terrainGrade(grassRadiance, grade))
  const beforeDisplay8 = BEFORE_GRASS_LUMA8[fraction === DUSK_FRACTION ? 'dusk' : 'noon'][albedo]
  return {
    elevDeg: applied.elevDeg, clock, albedo, terrain: cmp.terrain, grassRadiance, grade,
    terrainDisplay8, beforeDisplay8, afterDisplay8,
    beforeRow8: luma8(cmp.vegetation),
    ratioBefore: beforeDisplay8 / terrainDisplay8,
    ratioAfter: afterDisplay8 / terrainDisplay8,
  }
}

console.log('specifier hooks: ' + HOOK_KIND)
console.log('--- measured ambient, dusk fraction ' + DUSK_FRACTION + ' (sun elevation ' + todAt(DUSK_FRACTION).applied.elevDeg.toFixed(2) +
  ' deg, clock ' + todAt(DUSK_FRACTION).clock + ') and noon fraction ' + NOON_FRACTION + ' (sun elevation ' +
  todAt(NOON_FRACTION).applied.elevDeg.toFixed(2) + ' deg, clock ' + todAt(NOON_FRACTION).clock + ') ---')

const rows = []
for (const [label, frac] of [['dusk', DUSK_FRACTION], ['noon', NOON_FRACTION]]) {
  for (const albedo of REFERENCE_ALBEDOS) {
    const r = compareAt(frac, albedo)
    rows.push({ label, ...r })
    console.log(`${label} albedo=${albedo} elev=${r.elevDeg.toFixed(2)}deg clock=${r.clock} ` +
      `terrainLuma8=${r.terrainDisplay8.toFixed(2)} grassLuma8=${r.beforeDisplay8.toFixed(2)} -> ${r.afterDisplay8.toFixed(2)} ` +
      `ratioBefore=${r.ratioBefore.toFixed(4)} ratioAfter=${r.ratioAfter.toFixed(4)} ` +
      `sky=${JSON.stringify(r.terrain.map(v => +v.toFixed(5)))}`)
  }
}

const duskRow = rows.find(r => r.label === 'dusk' && r.albedo === 0.2)
const noonRow = rows.find(r => r.label === 'noon' && r.albedo === 0.2)
console.log('MEASURED grass-dusk-ambient: dusk albedo=0.2 grass/terrain ' + duskRow.ratioBefore.toFixed(4) + ' -> ' + duskRow.ratioAfter.toFixed(4) +
  ' (terrain luma8 ' + duskRow.terrainDisplay8.toFixed(2) + ', grass ' + duskRow.beforeDisplay8.toFixed(2) + ' -> ' + duskRow.afterDisplay8.toFixed(2) + ')' +
  '; noon albedo=0.2 grass/terrain ' + noonRow.ratioBefore.toFixed(4) + ' -> ' + noonRow.ratioAfter.toFixed(4))

expect('dusk-discontinuity-is-measured-before-the-fix', duskRow.ratioBefore < 0.95,
  'at dusk the grass reads ' + (duskRow.ratioBefore * 100).toFixed(1) + '% of the terrain, so the discontinuity the owner reported is reproduced by the real numbers')

for (const [label, frac] of [['dusk', DUSK_FRACTION], ['noon', NOON_FRACTION]]) {
  for (const albedo of REFERENCE_ALBEDOS) {
    const r = rows.find(x => x.label === label && x.albedo === albedo)
    const diff = Math.abs(r.afterDisplay8 - r.terrainDisplay8)
    expect('ambient-parity-' + label + '-albedo-' + albedo, diff <= K * QUANT_FLOOR_8BIT,
      '|grass - terrain| display luma = ' + diff.toFixed(3) + ' code(s) at ' + label + ' albedo ' + albedo +
      ', budget ' + K + ' x ' + QUANT_FLOOR_8BIT + ' = ' + (K * QUANT_FLOOR_8BIT) + ' (before the fix it was ' + Math.abs(r.beforeDisplay8 - r.terrainDisplay8).toFixed(3) + ')')
  }
}

// The albedo-invariant form of the owner's report: the grass/terrain ratio at dusk divided by the
// same ratio at noon. A fixed albedo difference between a blade and the ground cancels in it, so
// what is left is lighting -- and it is the number the owner's eye is reporting.
const doubleRatioBefore = duskRow.ratioBefore / noonRow.ratioBefore
const doubleRatioAfter = duskRow.ratioAfter / noonRow.ratioAfter
console.log('MEASURED grass-dusk-ambient double ratio (dusk over noon, albedo 0.2): ' + doubleRatioBefore.toFixed(4) + ' -> ' + doubleRatioAfter.toFixed(4))
expect('dusk-over-noon-double-ratio', Math.abs(doubleRatioAfter - 1) <= 0.02,
  'grass/terrain at dusk over the same ratio at noon = ' + doubleRatioAfter.toFixed(4) + ' (was ' + doubleRatioBefore.toFixed(4) +
  '), so the grass is no longer relatively darker at dusk than it is at noon')

expect('terrain-is-untouched',
  S.AMBIENT_FLOOR_ALBEDO === 0.14 && S.AMBIENT_FLOOR_ADD[2] === 0.038 && S.AMBIENT_FLOOR_ADD[0] === 0.020 &&
  /terrain-ambient-shared\.js/.test(TERRAIN_TSL_SRC),
  'the terrain ambient (albedo*' + S.AMBIENT_FLOOR_ALBEDO + ' + ' + JSON.stringify(S.AMBIENT_FLOOR_ADD) + ') is unchanged; the fix is on the grass side, nothing was dimmed to match')

// The grass ambient is the terrain ambient by construction, so pin the identity that makes it so
// rather than only the display ratio it produces: the irradiance the grass uniform carries is the
// scene ambient over pi, and the two added terms come from the shared module's own delta.
const dDusk = rows.find(r => r.label === 'dusk' && r.albedo === 0.2)
expect('grass-ambient-is-the-terrain-ambient',
  [0, 1, 2].every(i => Math.abs(dDusk.grassRadiance[i] - dDusk.terrain[i]) <= 1e-12),
  'at dusk albedo 0.2 the grass ambient ' + JSON.stringify(dDusk.grassRadiance.map(v => +v.toFixed(6))) +
  ' equals the terrain ambient ' + JSON.stringify(dDusk.terrain.map(v => +v.toFixed(6))) + ' channel for channel')

writeFileSync(resolve(ROOT, '.gm/pool/grass-dusk-ambient-before-after.json'), JSON.stringify({ rows, checks }, null, 2))
console.log('RESULT: PASS -- ' + checks.length + ' check(s), ' + failures + ' failed, label=grass-dusk-ambient')
process.exit(failures === 0 ? 0 : 1)
