import assert from 'node:assert/strict'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { compileTerrainMarks, wrapHeightWithMarks } = await import('../src/terrain/TerrainMarks.js')
const { createWaterLevel } = await import('../src/terrain/waterLevel.js')

const base = () => 10
const marked = wrapHeightWithMarks([
  { kind: 'grade', center: [0, 0], radius: 10, falloff: 0, level: 0, slope: 0, maxGrade: 0.5 },
  { kind: 'clear', center: [0, 0], radius: 3 },
], base)
assert.equal(marked(0, 0, 0), 10, 'a clear mark cancels the grade effect inside its footprint')
assert.equal(marked(5, 0, 0), 0, 'the grade still applies outside the clear footprint')
assert.equal(marked(50, 0, 0), 10, 'outside every mark the base height is kept')

const clearOnly = compileTerrainMarks([{ kind: 'clear', center: [0, 0], radius: 3 }])
assert.equal(clearOnly.clearsAt(1, 1), true, 'clearsAt is true inside the clear footprint')
assert.equal(clearOnly.clearsAt(9, 9), false, 'clearsAt is false outside it')

const liquid = compileTerrainMarks([{ kind: 'liquid', center: [0, 0], radius: 5, level: 3 }])
let liquidCalls = 0
const water = createWaterLevel({ seaLevel: 1, liquidAt: (x, z) => { liquidCalls += 1; return liquid.liquidLevelAt(x, z) } })
assert.equal(water.getWaterLevelAt(1, 1), 3, 'the water path reads the liquid mark level inside its footprint')
assert.equal(water.getWaterLevelAt(20, 20), 1, 'outside the liquid footprint the sea level is kept')
assert.ok(liquidCalls >= 2, 'the water path calls the liquid reader on every query')
assert.throws(() => createWaterLevel({ liquidAt: 'nope' }), e => e.reasonCode === 'water-liquid-invalid')
assert.throws(() => createWaterLevel({ liquidAt: () => NaN }).getWaterLevelAt(0, 0), e => e.reasonCode === 'water-liquid-invalid')

console.log('RESULT: PASS a clear mark cancels the grade effect in its footprint, clearsAt reports the footprint, and the water path reads a liquid mark level through liquidAt, with its refusals coded')
