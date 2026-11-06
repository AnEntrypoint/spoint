import assert from 'node:assert/strict'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { defineCheckpoint } = await import('../src/behaviours/checkpoint.js')
const stub = { players: { getAll: () => [] } }
const goodSpawn = [0, 0, 0]

for (const radius of [-3, 0, NaN, Infinity, 'wide', null]) {
  const spec = { spawn: goodSpawn, checkpoints: [{ position: [1, 0, 1], radius }] }
  assert.throws(() => defineCheckpoint(spec, stub), e => e.reasonCode === 'define-spec-invalid-field' && e.field === 'checkpoints', `nested radius ${String(radius)} must be refused`)
}
assert.throws(() => defineCheckpoint({ spawn: goodSpawn, checkpoints: [null] }, stub), e => e.reasonCode === 'define-spec-invalid-field' && e.field === 'checkpoints')

assert.ok(defineCheckpoint({ spawn: goodSpawn, checkpoints: [{ position: [1, 0, 1], radius: 5 }] }, stub))
assert.ok(defineCheckpoint({ spawn: goodSpawn, checkpoints: [{ position: [1, 0, 1] }] }, stub))
assert.ok(defineCheckpoint({ spawn: goodSpawn }, stub))

console.log('RESULT: PASS nested checkpoints[].radius is validated at the boundary; negative, zero, non-finite, wrong-type and null radii refuse by code')
