import assert from 'node:assert/strict'
import { createScriptedTerrain, ScriptedTerrainError } from '../src/terrain/scriptedTerrain.js'

let assertions = 0
const ok = (value, message) => { assertions += 1; assert.ok(value, message) }
const eq = (got, want, message) => { assertions += 1; assert.equal(got, want, message) }
const close = (got, want, message) => {
  assertions += 1
  assert.ok(Math.abs(got - want) < 1e-9, `${message}: got ${got}, want ${want}`)
}
const closeArray = (got, want, message) => {
  eq(got.length, want.length, `${message} length`)
  want.forEach((value, index) => close(got[index], value, `${message}[${index}]`))
}
const refuses = (call, code) => {
  assertions += 1
  assert.throws(call, (err) => err instanceof ScriptedTerrainError && err.reasonCode === code, `expected refusal ${code}`)
}

const plane = createScriptedTerrain({ heightAt: () => 0, minHeight: 0, maxHeight: 10 })
eq(typeof plane.sample, 'function', 'sample is exposed')
eq(typeof plane.getTerrainNormal, 'function', 'getTerrainNormal is exposed')
eq(typeof plane.materialAt, 'function', 'materialAt is exposed')
const flat = plane.sample(3, -4)
eq(flat.height, 0, 'plane raw height')
eq(flat.worldHeight, 0, 'plane world height')
eq(flat.height01, 0, 'plane height01')
closeArray(flat.slope, [0, 0], 'plane slope')
closeArray(flat.normal, [0, 1, 0], 'plane normal points up')
eq(flat.material, null, 'a missing material sampler yields null')
closeArray(plane.getTerrainNormal(8, 2), [0, 1, 0], 'getTerrainNormal on a plane')
eq(plane.materialAt(8, 2), null, 'materialAt without a sampler')

const levels = createScriptedTerrain({ heightAt: ({ x }) => x, minHeight: 0, maxHeight: 10 })
eq(levels.sample(2.5, 0).height01, 0.25, 'height01 is the normalised world height')
close(levels.sample(2.5, 0).slope[0], 1, 'height01 sample keeps its x gradient')
const above = levels.sample(12, 0)
eq(above.height, 12, 'raw height above the range is kept')
eq(above.worldHeight, 10, 'world height clamps to maxHeight')
eq(above.height01, 1, 'height01 clamps to 1')
const below = levels.sample(-3, 0)
eq(below.height, -3, 'raw height below the range is kept')
eq(below.worldHeight, 0, 'world height clamps to minHeight')
eq(below.height01, 0, 'height01 clamps to 0')

const ramp = createScriptedTerrain({
  heightAt: ({ x, z }) => 2 * x - 0.5 * z + 3,
  minHeight: -100,
  maxHeight: 100,
  normalStep: 1,
})
const incline = ramp.sample(4, 2)
eq(incline.height, 10, 'ramp height')
eq(incline.worldHeight, 10, 'ramp world height')
close(incline.height01, 0.55, 'ramp height01')
closeArray(incline.slope, [2, -0.5], 'ramp gradient')
const rampLength = Math.hypot(2, 1, 0.5)
closeArray(incline.normal, [-2 / rampLength, 1 / rampLength, 0.5 / rampLength], 'ramp normal tilts against the gradient')
closeArray(ramp.getTerrainNormal(4, 2), incline.normal, 'getTerrainNormal agrees with sample')
ok(incline.normal[1] > 0, 'a ramp normal still points up')

const curve = createScriptedTerrain({ heightAt: ({ x }) => x * x, minHeight: -1000, maxHeight: 1000, normalStep: 0.5 })
close(curve.sample(2, 0).slope[0], 4, 'central differences honour normalStep')
close(curve.sample(2, 0).slope[1], 0, 'central differences leave the flat axis flat')

const samplerContexts = []
const seeded = createScriptedTerrain({
  heightAt: (ctx) => {
    samplerContexts.push(ctx)
    return ctx.seedOffset + ctx.seedOffsetFor(3) + ctx.x
  },
  seedOffset: 7,
  minHeight: 0,
  maxHeight: 1000,
})
eq(seeded.sample(0, 0).height, 17, 'seedOffset and seedOffsetFor reach the height sampler')
eq(samplerContexts.length, 5, 'one sample reads the centre plus four gradient taps')
ok(samplerContexts.every((ctx) => Number.isFinite(ctx.x) && Number.isFinite(ctx.z) && ctx.seedOffset === 7 && typeof ctx.seedOffsetFor === 'function'), 'every sampler call carries the same boundary context')
const coordinateOnly = createScriptedTerrain({ heightAt: ({ x, z }) => x + z, seedOffset: 5, minHeight: -1000, maxHeight: 1000 })
eq(coordinateOnly.sample(2, 3).height, 5, 'seedOffset does not move the sampled column')
refuses(() => createScriptedTerrain({ heightAt: (ctx) => ctx.seedOffsetFor(NaN) }).sample(0, 0), 'seed-offset-index-non-finite')

const materialContexts = []
const painted = createScriptedTerrain({
  heightAt: () => 4,
  minHeight: 0,
  maxHeight: 10,
  materialAt: (ctx) => {
    materialContexts.push(ctx)
    return { sand: ctx.worldHeight < 5 ? 1 : 0, rock: ctx.height01, flat: ctx.slope[0], up: ctx.normal[1] }
  },
})
const paintedSample = painted.sample(1, 1)
eq(paintedSample.material.sand, 1, 'material reads worldHeight')
close(paintedSample.material.rock, 0.4, 'material reads height01')
eq(paintedSample.material.flat, 0, 'material reads slope')
eq(paintedSample.material.up, 1, 'material reads normal')
const direct = painted.materialAt(1, 1)
eq(direct.sand, 1, 'materialAt returns the same material as sample')
close(direct.rock, 0.4, 'materialAt sees the same height01')
eq(materialContexts.length, 2, 'sample and materialAt each resolve material once')
eq(materialContexts[0].x, 1, 'material ctx carries x')
eq(materialContexts[0].z, 1, 'material ctx carries z')
eq(materialContexts[0].worldHeight, 4, 'material ctx carries worldHeight')
close(materialContexts[0].height01, 0.4, 'material ctx carries height01')
closeArray(materialContexts[0].slope, [0, 0], 'material ctx carries slope')
closeArray(materialContexts[0].normal, [0, 1, 0], 'material ctx carries normal')
eq(createScriptedTerrain({ heightAt: () => 1, materialAt: () => 'sand' }).materialAt(0, 0), 'sand', 'a named material is allowed')

for (const [call, code] of [
  [() => createScriptedTerrain(), 'height-at-invalid'],
  [() => createScriptedTerrain({ heightAt: 1 }), 'height-at-invalid'],
  [() => createScriptedTerrain({ heightAt: () => 0, materialAt: 1 }), 'material-at-invalid'],
  [() => createScriptedTerrain({ heightAt: () => 0, minHeight: NaN }), 'height-range-invalid'],
  [() => createScriptedTerrain({ heightAt: () => 0, maxHeight: Infinity }), 'height-range-invalid'],
  [() => createScriptedTerrain({ heightAt: () => 0, minHeight: 2, maxHeight: 2 }), 'height-range-invalid'],
  [() => createScriptedTerrain({ heightAt: () => 0, seedOffset: 'x' }), 'seed-offset-invalid'],
  [() => createScriptedTerrain({ heightAt: () => 0, normalStep: 0 }), 'normal-step-invalid'],
  [() => createScriptedTerrain({ heightAt: () => 0, normalStep: NaN }), 'normal-step-invalid'],
  [() => plane.sample(NaN, 0), 'input-non-finite'],
  [() => plane.sample(0, Infinity), 'input-non-finite'],
  [() => plane.sample('1', 0), 'input-non-finite'],
  [() => plane.getTerrainNormal(undefined, 0), 'input-non-finite'],
  [() => plane.materialAt(0, NaN), 'input-non-finite'],
  [() => createScriptedTerrain({ heightAt: () => NaN }).sample(0, 0), 'height-non-finite'],
  [() => createScriptedTerrain({ heightAt: () => Infinity }).sample(0, 0), 'height-non-finite'],
  [() => createScriptedTerrain({ heightAt: () => undefined }).sample(0, 0), 'height-non-finite'],
  [() => createScriptedTerrain({ heightAt: () => '3' }).sample(0, 0), 'height-non-finite'],
  [() => createScriptedTerrain({ heightAt: ({ x }) => x === 1 ? NaN : 0 }).sample(0, 0), 'height-non-finite'],
  [() => createScriptedTerrain({ heightAt: () => Number.MAX_VALUE, minHeight: -Number.MAX_VALUE, maxHeight: Number.MAX_VALUE }).sample(0, 0), 'height01-non-finite'],
  [() => createScriptedTerrain({ heightAt: ({ x }) => x > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE, minHeight: -Number.MAX_VALUE, maxHeight: Number.MAX_VALUE }).sample(0, 0), 'slope-non-finite'],
  [() => createScriptedTerrain({ heightAt: () => 0, materialAt: () => ({ sand: NaN }) }).materialAt(0, 0), 'material-non-finite'],
  [() => createScriptedTerrain({ heightAt: () => 0, materialAt: () => NaN }).materialAt(0, 0), 'material-non-finite'],
  [() => createScriptedTerrain({ heightAt: () => 0, materialAt: () => [1] }).sample(0, 0), 'material-shape-invalid'],
  [() => createScriptedTerrain({ heightAt: () => 0, materialAt: () => 1 }).sample(0, 0), 'material-shape-invalid'],
]) refuses(call, code)

console.log(`RESULT: PASS scripted terrain samples planes and ramps, clamps height01, carries seedOffset, resolves materials and refuses by code (${assertions} assertions)`)
