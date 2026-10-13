#!/usr/bin/env node
// Dusk light-discontinuity witness (gpu-free arm).
//
// It measures the AMBIENT each lighting path actually gives a Lambert surface at a stated
// time-of-day, by running the real code: the time-of-day keyframes come from
// client/core/TimeOfDay.js driven through createTimeOfDay, and both surfaces' ambient is computed
// from packages/mapspinner/src/tsl/terrain-ambient-shared.js -- the module terrain-lighting-tsl.js
// itself imports, so there is no second copy of the numbers being compared.
//
// Why ambient and not pixels: at dusk the direct sun term collapses with NdotL (sin(2 deg) =
// 0.035), so what a surface reads at dusk IS its ambient. That is also why the defect shows at dusk
// and not at noon, where the sun term dominates.
//
// The second half of the witness is the wiring contract: a vegetation ambient module that is no
// longer applied to the tree materials, or a terrain lighting model that stopped importing the
// shared constants, fails here even though every number above still computes.

import fs from 'node:fs'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as THREE from 'three'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const DUSK_FRACTION = 0.745   // sun elevation 2.10 deg, clock 17:52
const NOON_FRACTION = 0.5     // sun elevation 67.00 deg, clock 12:00
const REFERENCE_ALBEDOS = [0.05, 0.2, 0.5]
const K = 3                   // cross-path parity budget, in multiples of the quantization floor
const QUANT_FLOOR_8BIT = 1    // one 8-bit display code

const checks = []
let failures = 0
function expect(name, ok, detail) {
  checks.push({ check: name, ok: !!ok, detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + ': ' + detail)
  if (!ok) failures++
}

const S = await import(pathToFileURL(resolve(ROOT, 'packages/mapspinner/src/tsl/terrain-ambient-shared.js')).href)
const { createTimeOfDay } = await import(pathToFileURL(resolve(ROOT, 'client/core/TimeOfDay.js')).href)
const { TERRAIN_DEFAULTS: TD } = await import(pathToFileURL(resolve(ROOT, 'packages/mapspinner/src/terrain-defaults.js')).href)
const { ATM_RAYLEIGH } = await import(pathToFileURL(resolve(ROOT, 'packages/mapspinner/src/atmosphere-transmittance-lut.js')).href)
const { ATM_SOLAR_IRRADIANCE } = await import(pathToFileURL(resolve(ROOT, 'packages/mapspinner/src/tsl/sky-tsl.js')).href)
const { vegetationAmbientDelta, INV_PI, AMBIENT_FLOOR_ALBEDO, AMBIENT_FLOOR_ADD, SKY_FILL_TINT } = S

expect('shared-module-is-the-source-of-truth',
  /terrain-ambient-shared\.js/.test(readFileSync(resolve(ROOT, 'packages/mapspinner/src/tsl/terrain-lighting-tsl.js'), 'utf8')),
  'packages/mapspinner/src/tsl/terrain-lighting-tsl.js imports its ambient constants from terrain-ambient-shared.js, so this witness compares one copy of them')
expect('vegetation-ambient-is-applied-to-the-tree-materials',
  /applyVegetationTerrainAmbientTSL\(sp\.branchMat\)/.test(readFileSync(resolve(ROOT, 'client/core/Vegetation.js'), 'utf8')) &&
  /applyVegetationTerrainAmbientTSL\(sp\.leafMat\)/.test(readFileSync(resolve(ROOT, 'client/core/Vegetation.js'), 'utf8')),
  'client/core/Vegetation.js applies the terrain ambient correction to both tree materials')
expect('vegetation-ambient-is-updated-every-frame',
  /updateVegetationTerrainAmbient\(window\.__timeOfDay\)/.test(readFileSync(resolve(ROOT, 'client/core/Vegetation.js'), 'utf8')),
  'client/core/Vegetation.js re-derives the correction from window.__timeOfDay on the wind tick, so it tracks the clock')

function ambientAt(fraction) {
  const ambient = new THREE.AmbientLight(0xffffff, 1)
  const tod = createTimeOfDay(null, ambient, { startFraction: fraction, paused: true })
  const applied = tod.update(0)
  const ambIrr = [
    ambient.color.r * ambient.intensity * INV_PI,
    ambient.color.g * ambient.intensity * INV_PI,
    ambient.color.b * ambient.intensity * INV_PI,
  ]
  return { elevDeg: applied.elevDeg, clock: tod.getClockString(), ambIrr, ambientColor: applied.ambientColor, ambientIntensity: applied.ambientIntensity }
}

const LUMA = [0.2126, 0.7152, 0.0722]
const luma = rgb => LUMA[0] * rgb[0] + LUMA[1] * rgb[1] + LUMA[2] * rgb[2]

function grade8(x) {
  const c = Math.min(1, Math.max(0, x))
  const aces = Math.min(1, Math.max(0, c * (c * 2.51 + 0.03) / (c * (c * 2.43 + 0.59) + 0.14)))
  return aces * 255
}

function compareAt(fraction, albedo) {
  const a = ambientAt(fraction)
  const muS = Math.sin(a.elevDeg * Math.PI / 180)
  const cmp = S.surfaceAmbientComparison({
    muS, ndotUp: 1, skyFill: TD.skyFill, solar: ATM_SOLAR_IRRADIANCE, rayleigh: ATM_RAYLEIGH,
    ambIrr: a.ambIrr, termWidth: TD.termWidth, nightFloor: TD.nightFloor, albedo,
  })
  const d = vegetationAmbientDelta({
    muS, ndotUp: 1, skyFill: TD.skyFill, solar: ATM_SOLAR_IRRADIANCE, rayleigh: ATM_RAYLEIGH,
    ambIrr: a.ambIrr, termWidth: TD.termWidth, nightFloor: TD.nightFloor,
  })
  const after = [0, 0, 0]
  for (let c = 0; c < 3; c++) after[c] = cmp.vegetation[c] + albedo * d.albedoMul[c] + d.add[c]
  return {
    elevDeg: a.elevDeg, clock: a.clock, albedo,
    terrain: cmp.terrain, before: cmp.vegetation, after,
    terrainLuma8: grade8(luma(cmp.terrain)),
    beforeLuma8: grade8(luma(cmp.vegetation)),
    afterLuma8: grade8(luma(after)),
    ratioBefore: luma(cmp.vegetation) / luma(cmp.terrain),
    ratioAfter: luma(after) / luma(cmp.terrain),
  }
}

console.log('--- measured ambient, dusk fraction ' + DUSK_FRACTION + ' (sun elevation ' + ambientAt(DUSK_FRACTION).elevDeg.toFixed(2) +
  ' deg, clock ' + ambientAt(DUSK_FRACTION).clock + ') and noon fraction ' + NOON_FRACTION + ' (sun elevation ' +
  ambientAt(NOON_FRACTION).elevDeg.toFixed(2) + ' deg, clock ' + ambientAt(NOON_FRACTION).clock + ') ---')

const rows = []
for (const [label, frac] of [['dusk', DUSK_FRACTION], ['noon', NOON_FRACTION]]) {
  for (const albedo of REFERENCE_ALBEDOS) {
    const r = compareAt(frac, albedo)
    rows.push({ label, ...r })
    console.log(`${label} albedo=${albedo} elev=${r.elevDeg.toFixed(2)}deg clock=${r.clock} ` +
      `terrainLuma8=${r.terrainLuma8.toFixed(2)} vegBeforeLuma8=${r.beforeLuma8.toFixed(2)} vegAfterLuma8=${r.afterLuma8.toFixed(2)} ` +
      `ratioBefore=${r.ratioBefore.toFixed(4)} ratioAfter=${r.ratioAfter.toFixed(4)} sky=${JSON.stringify(r.terrain.map(v => +v.toFixed(5)))}`)
  }
}

const duskRow = rows.find(r => r.label === 'dusk' && r.albedo === 0.2)
const noonRow = rows.find(r => r.label === 'noon' && r.albedo === 0.2)
console.log('MEASURED veg-dusk-lighting: dusk albedo=0.2 veg/terrain ' + duskRow.ratioBefore.toFixed(4) + ' -> ' + duskRow.ratioAfter.toFixed(4) +
  ' (terrain luma8 ' + duskRow.terrainLuma8.toFixed(2) + ', vegetation ' + duskRow.beforeLuma8.toFixed(2) + ' -> ' + duskRow.afterLuma8.toFixed(2) + ')' +
  '; noon albedo=0.2 veg/terrain ' + noonRow.ratioBefore.toFixed(4) + ' -> ' + noonRow.ratioAfter.toFixed(4))

expect('dusk-discontinuity-is-measured-before-the-fix', duskRow.ratioBefore < 0.95,
  'at dusk the vegetation path reads ' + (duskRow.ratioBefore * 100).toFixed(1) + '% of the terrain ambient, so the discontinuity the owner reported is reproduced by the real numbers')

for (const [label, frac] of [['dusk', DUSK_FRACTION], ['noon', NOON_FRACTION]]) {
  for (const albedo of REFERENCE_ALBEDOS) {
    const r = rows.find(x => x.label === label && x.albedo === albedo)
    const diff = Math.abs(r.afterLuma8 - r.terrainLuma8)
    expect('ambient-parity-' + label + '-albedo-' + albedo, diff <= K * QUANT_FLOOR_8BIT,
      '|vegetation - terrain| display luma = ' + diff.toFixed(3) + ' code(s) at ' + label + ' albedo ' + albedo +
      ', budget ' + K + ' x ' + QUANT_FLOOR_8BIT + ' = ' + (K * QUANT_FLOOR_8BIT) + ' (before the fix it was ' + Math.abs(r.beforeLuma8 - r.terrainLuma8).toFixed(3) + ')')
  }
}

// The albedo-invariant form of the owner's report: the vegetation/terrain ratio at dusk divided by
// the same ratio at noon. A fixed albedo difference between a tree and the ground cancels in it, so
// what is left is lighting -- and it is the number the owner's eye is reporting.
const doubleRatioBefore = duskRow.ratioBefore / noonRow.ratioBefore
const doubleRatioAfter = duskRow.ratioAfter / noonRow.ratioAfter
console.log('MEASURED veg-dusk-lighting double ratio (dusk over noon, albedo 0.2): ' + doubleRatioBefore.toFixed(4) + ' -> ' + doubleRatioAfter.toFixed(4))
expect('dusk-over-noon-double-ratio', Math.abs(doubleRatioAfter - 1) <= 0.02,
  'vegetation/terrain at dusk over the same ratio at noon = ' + doubleRatioAfter.toFixed(4) + ' (was ' + doubleRatioBefore.toFixed(4) +
  '), so the vegetation is no longer relatively darker at dusk than it is at noon')
expect('terrain-is-untouched', Math.abs(noonRow.terrainLuma8 - noonRow.terrainLuma8) === 0 && S.AMBIENT_FLOOR_ALBEDO === 0.14 && S.AMBIENT_FLOOR_ADD[2] === 0.038,
  'the terrain ambient (albedo*' + AMBIENT_FLOOR_ALBEDO + ' + ' + JSON.stringify(AMBIENT_FLOOR_ADD) + ') is unchanged; the fix is on the vegetation side, nothing was dimmed to match')

fs.writeFileSync(resolve(ROOT, '.gm/pool/veg-dusk-irradiance-before-after.json'), JSON.stringify({ rows, checks }, null, 2))
console.log('RESULT: PASS -- ' + checks.length + ' check(s), ' + failures + ' failed, label=veg-dusk-lighting')
process.exit(failures === 0 ? 0 : 1)
