import assert from 'node:assert/strict'
import { createLeafSprayTexture, LEAF_SPECIES } from '../src/vegetation/leafSprayTexture.js'

const spec = { size: 64, species: 'broad', seed: 3, coverageTarget: 0.4 }
const texture = createLeafSprayTexture(spec)
assert.equal(texture.alpha.length, 64 * 64)
assert.ok(texture.coverage >= 0.4, `coverage=${texture.coverage}`)
assert.ok(texture.alpha.every(v => v === 0 || v === 255), 'alpha is binary')
let outside = 0
for (let y = 0; y < 64; y++) for (let x = 32; x < 64; x++) if (texture.alpha[y * 64 + x] > 128) outside++
assert.equal(outside, 0, 'packing stays in the upper corner')
assert.deepEqual(createLeafSprayTexture(spec).alpha, texture.alpha, 'the texture is deterministic')
const needle = createLeafSprayTexture({ ...spec, species: 'needle' })
assert.notDeepEqual(needle.alpha, texture.alpha)
assert.ok(needle.coverage >= 0.4)
assert.equal(LEAF_SPECIES.length, 2)

for (const [call, code] of [
  [() => createLeafSprayTexture({ size: 30 }), 'leaf-size-invalid'],
  [() => createLeafSprayTexture({ species: 'palm' }), 'leaf-species-invalid'],
  [() => createLeafSprayTexture({ seed: 1.5 }), 'leaf-seed-invalid'],
  [() => createLeafSprayTexture({ coverageTarget: 0 }), 'leaf-coverage-invalid'],
  [() => createLeafSprayTexture({ maxSprigs: 0 }), 'leaf-sprigs-invalid'],
]) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

console.log('RESULT: PASS leaf spray texture reaches its coverage target in the upper corner, is deterministic and refuses by code')
