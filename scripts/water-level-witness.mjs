import assert from 'node:assert/strict'
import { createWaterLevel } from '../src/terrain/waterLevel.js'

const water = createWaterLevel({
  seaLevel: 0,
  lakes: [{ x: 10, z: 10, radius: 5, level: 3 }],
  ponds: [{ x: -10, z: -10, radius: 2, level: 1 }],
  sampleAt: (x, z, place) => place === 'painted' && x === 0 && z === 0 ? 4 : null,
})

assert.equal(water.getWaterLevelAt(0, 0), 0)
assert.equal(water.getWaterLevelAt(0, 0, 'painted'), 4)
assert.equal(water.getWaterLevelAt(10, 10), 3)
assert.equal(water.getWaterLevelAt(-10, -10), 1)
assert.equal(water.getWaterLevelAt(14, 10), 3)
assert.equal(water.getWaterLevelAt(16, 10), 0)
assert.equal(water.setSeaLevel(2), 2)
assert.equal(water.getWaterLevelAt(0, 0), 2)
assert.equal(water.getWaterLevelAt(10, 10), 3)

assert.deepEqual(water.liquidStateAt(0, 0, 5), { inWater: false, level: 2, depth: 0, density: 'air' })
assert.deepEqual(water.liquidStateAt(0, 0, 1), { inWater: true, level: 2, depth: 1, density: 'floating' })
assert.deepEqual(water.liquidStateAt(10, 10, 0), { inWater: true, level: 3, depth: 3, density: 'diving' })

for (const [call, code] of [
  [() => createWaterLevel({ seaLevel: NaN }), 'water-sea-invalid'],
  [() => createWaterLevel({ lakes: null }), 'water-bodies-invalid'],
  [() => createWaterLevel({ lakes: [{ x: 0, z: 0, radius: 0, level: 1 }] }), 'water-body-invalid'],
  [() => createWaterLevel({ sampleAt: 3 }), 'water-sampler-invalid'],
  [() => water.getWaterLevelAt(NaN, 0), 'water-position-invalid'],
  [() => water.setSeaLevel(Infinity), 'water-sea-invalid'],
]) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

const badSampler = createWaterLevel({ sampleAt: () => NaN })
assert.throws(() => badSampler.getWaterLevelAt(0, 0), e => e.reasonCode === 'water-painted-invalid')

console.log('RESULT: PASS composable water level takes the max of sea, painted, lake and pond levels and reports liquid state by code')
