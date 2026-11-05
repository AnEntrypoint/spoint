import assert from 'node:assert/strict'
import {
  waterFresnel,
  waterRippleSlope,
  waterFoamCoverage,
  waterTransmittance,
  waterCausticsAt,
  waterRayBoxDistance,
  waterMedium,
} from '../src/shared/water.js'

const EPS = 1e-9
const WAVELENGTH = 4
const AMPLITUDE = 0.2
const GRID = 64
const BOX_MIN = [-1, -1, -1]
const BOX_MAX = [1, 1, 1]

const fresnel = []
for (let i = 0; i <= 20; i++) fresnel.push(waterFresnel(i / 20))
assert.equal(fresnel.length, 21)
assert.equal(fresnel[0], 1, 'grazing incidence reflects everything')
assert.ok(Math.abs(fresnel[20] - 0.02) < EPS, 'normal incidence returns f0')
for (let i = 0; i < 20; i++) assert.ok(fresnel[i] >= fresnel[i + 1], `fresnel rose between ${i / 20} and ${(i + 1) / 20}`)
assert.ok(fresnel[0] - fresnel[10] > 0.9, 'fresnel must actually change with angle')
assert.ok(fresnel.every((v) => v >= 0 && v <= 1), 'fresnel intensity must stay in [0,1]')
assert.equal(waterFresnel(1, 0.1), 0.1)
assert.equal(waterFresnel(0, 0.1), 1)

let rippleSamples = 0
let sumX = 0
let sumZ = 0
let maxSlope = 0
for (let i = 0; i < GRID; i++) {
  for (let j = 0; j < GRID; j++) {
    const [sx, sz] = waterRippleSlope(i * WAVELENGTH / GRID, j * WAVELENGTH / GRID, 0.7, AMPLITUDE, WAVELENGTH)
    assert.ok(Number.isFinite(sx) && Number.isFinite(sz), 'ripple slope must stay finite')
    sumX += sx
    sumZ += sz
    maxSlope = Math.max(maxSlope, Math.abs(sx), Math.abs(sz))
    rippleSamples++
  }
}
assert.equal(rippleSamples, GRID * GRID)
const steepness = AMPLITUDE * Math.PI * 2 / WAVELENGTH
assert.ok(Math.abs(sumX / rippleSamples) < 1e-9, `ripple slope x mean is ${sumX / rippleSamples}`)
assert.ok(Math.abs(sumZ / rippleSamples) < 1e-9, `ripple slope z mean is ${sumZ / rippleSamples}`)
assert.ok(maxSlope > steepness * 0.9 && maxSlope <= steepness + EPS, `ripple slope ${maxSlope} must oscillate within its steepness ${steepness}`)
const [atX] = waterRippleSlope(1, 2, 0.7, AMPLITUDE, WAVELENGTH)
const [atXPlusPeriod] = waterRippleSlope(1 + WAVELENGTH, 2, 0.7, AMPLITUDE, WAVELENGTH)
assert.ok(Math.abs(atX - atXPlusPeriod) < EPS, 'one wavelength must be a period')

const calm = waterFoamCoverage(0, 0, 2)
const shallow = waterFoamCoverage(0.9, 0, 2)
const mid = waterFoamCoverage(0.9, 1, 2)
const deep = waterFoamCoverage(0.9, 2, 2)
assert.ok(calm > 0 && calm <= 1, 'shallow water keeps shoreline foam without a steep slope')
assert.ok(shallow > calm, 'a steeper slope must raise foam coverage')
assert.ok(shallow > mid && mid > deep, 'foam coverage must fall as depth grows')
assert.equal(deep, 0, 'foam vanishes past its depth threshold')
for (const coverage of [calm, shallow, mid, deep]) assert.ok(coverage >= 0 && coverage <= 1)
const ripple = waterRippleSlope(0.5, 0.5, 0, 0.6, WAVELENGTH)
assert.ok(Math.abs(waterFoamCoverage(ripple, 0, 2) - waterFoamCoverage(Math.hypot(...ripple), 0, 2)) < EPS, 'a slope vector and its magnitude must agree')

const transmittance = []
for (let depth = 0; depth <= 10; depth++) transmittance.push(waterTransmittance(depth, 0.2))
assert.equal(transmittance[0], 1, 'zero depth transmits everything')
for (let i = 0; i < 10; i++) assert.ok(transmittance[i] > transmittance[i + 1], 'transmittance must decay with depth')
assert.ok(transmittance[10] < 0.2, 'ten metres at 0.2 extinction must attenuate strongly')
assert.ok(Math.abs(waterTransmittance(3, 0.2) * waterTransmittance(4, 0.2) - waterTransmittance(7, 0.2)) < EPS, 'Beer-Lambert transmittance must multiply over distance')
assert.equal(waterTransmittance(5, 0), 1)
assert.ok(transmittance.every((v) => v >= 0 && v <= 1), 'transmittance intensity must stay in [0,1]')

let causticSamples = 0
let causticMin = 1
let causticMax = 0
for (let i = 0; i < 24; i++) {
  for (let j = 0; j < 24; j++) {
    for (const time of [0, 0.3, 1.1]) {
      const intensity = waterCausticsAt(i * 0.37, j * 0.41, time, 0.25)
      assert.ok(Number.isFinite(intensity) && intensity >= 0 && intensity <= 1, `caustics intensity ${intensity} left [0,1]`)
      causticMin = Math.min(causticMin, intensity)
      causticMax = Math.max(causticMax, intensity)
      causticSamples++
    }
  }
}
assert.equal(causticSamples, 24 * 24 * 3)
assert.ok(causticMin < 0.05 && causticMax > 0.8, `caustics must span bright ridges and dark gaps, got ${causticMin}..${causticMax}`)
const animated = [0, 0.4, 0.8, 1.2].map((t) => waterCausticsAt(0.4, 0.9, t, 0.25))
assert.ok(Math.max(...animated) - Math.min(...animated) > 0.05, 'caustics must animate over time')

const hit = waterRayBoxDistance([0, 0, -5], [0, 0, 1], BOX_MIN, BOX_MAX)
assert.ok(Math.abs(hit - 4) < EPS, `ray from z=-5 must enter the box at 4 m, got ${hit}`)
assert.equal(waterRayBoxDistance([0, 0, 0], [0, 0, 1], BOX_MIN, BOX_MAX), 0, 'an origin inside the box is already at distance 0')
assert.ok(Math.abs(waterRayBoxDistance([0, 0, -5], [0, 0, 3], BOX_MIN, BOX_MAX) - 4) < EPS, 'direction magnitude must not change the geometric distance')
assert.ok(Math.abs(waterRayBoxDistance({ x: 0, y: 0, z: -5 }, { x: 0, y: 0, z: 2 }, BOX_MIN, BOX_MAX) - 4) < EPS, 'object vectors must agree with arrays')
const miss = waterRayBoxDistance([0, 3, -5], [0, 0, 1], BOX_MIN, BOX_MAX)
assert.equal(miss, Infinity, 'a ray outside the y slab must miss')
assert.equal(waterRayBoxDistance([0, 0, 5], [0, 0, 1], BOX_MIN, BOX_MAX), Infinity, 'a ray pointing away from the box must miss')
assert.equal(Math.min(10, miss), 10, 'a miss must not clamp a scene distance to zero')

const mediumKeys = ['depth01', 'transmittance', 'absorption', 'scatter', 'tint']
let previousTransmittance = Infinity
for (const depth of [0, 1, 8, 64, 1000]) {
  const medium = waterMedium(depth)
  assert.ok(Object.isFrozen(medium), 'the medium descriptor must be frozen')
  assert.deepEqual(Object.keys(medium).sort(), [...mediumKeys].sort())
  assert.equal(medium.tint.length, 3)
  for (const value of [medium.depth01, medium.transmittance, medium.absorption, medium.scatter, ...medium.tint]) {
    assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `medium field ${value} left [0,1]`)
  }
  assert.ok(Math.abs(medium.transmittance + medium.absorption - 1) < EPS, 'absorption must complement transmittance')
  assert.ok(medium.transmittance < previousTransmittance, 'a deeper medium must transmit less')
  previousTransmittance = medium.transmittance
}
assert.equal(waterMedium(0).transmittance, 1)
assert.equal(waterMedium(0).absorption, 0)

const refusals = [
  [() => waterFresnel(NaN, 0.02), 'water-cosTheta-invalid'],
  [() => waterFresnel(0.5, Infinity), 'water-f0-invalid'],
  [() => waterFresnel(1.5, 0.02), 'water-cosTheta-invalid'],
  [() => waterRippleSlope(NaN, 0, 0, 0.2, WAVELENGTH), 'water-x-invalid'],
  [() => waterRippleSlope(0, 0, Infinity, 0.2, WAVELENGTH), 'water-time-invalid'],
  [() => waterRippleSlope(0, 0, 0, 0.2, 0), 'water-wavelength-invalid'],
  [() => waterFoamCoverage(Infinity, 0.1, 2), 'water-slope-invalid'],
  [() => waterFoamCoverage([0.2, NaN], 0.1, 2), 'water-slope-invalid'],
  [() => waterFoamCoverage(0.2, NaN, 2), 'water-depth-invalid'],
  [() => waterFoamCoverage(0.2, 0.1, 0), 'water-threshold-invalid'],
  [() => waterTransmittance(1, NaN), 'water-extinction-invalid'],
  [() => waterTransmittance(-1, 0.2), 'water-depth-invalid'],
  [() => waterCausticsAt(0, 0, NaN, 0.25), 'water-time-invalid'],
  [() => waterCausticsAt(0, 0, 0, Infinity), 'water-scale-invalid'],
  [() => waterRayBoxDistance([NaN, 0, 0], [0, 0, 1], BOX_MIN, BOX_MAX), 'water-origin-invalid'],
  [() => waterRayBoxDistance([0, 0, -5], [0, 0, 0], BOX_MIN, BOX_MAX), 'water-direction-invalid'],
  [() => waterRayBoxDistance([0, 0, -5], [0, 0, 1], [1, -1, -1], BOX_MAX), 'water-box-invalid'],
  [() => waterRayBoxDistance([0, 0, -5], [0, 0, 1], [-1, -1, Infinity], BOX_MAX), 'water-box-min-invalid'],
  [() => waterMedium(NaN), 'water-depth-invalid'],
  [() => waterMedium(-Infinity), 'water-depth-invalid'],
]
for (const [call, code] of refusals) {
  assert.throws(call, (err) => err instanceof TypeError && err.reasonCode === code, `expected refusal code ${code}`)
}
assert.equal(refusals.length, 20)

console.log(`RESULT: PASS ${fresnel.length} fresnel angles, ${rippleSamples} zero-mean ripple slopes, shallow foam, ${transmittance.length} transmittance depths, ${causticSamples} bounded caustics, ray-box hit/miss, ${mediumKeys.length} bounded medium fields and ${refusals.length} coded refusals`)
