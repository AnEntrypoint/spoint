import assert from 'node:assert/strict'
import { assetName, uploadPlan } from './lib/asset-registry.mjs'

const name = assetName('rock', 'glb', 'model bytes')
assert.match(name, /^rock\.[0-9a-f]{64}\.glb$/)
assert.equal(assetName('rock', 'glb', 'model bytes'), name, 'the same content must produce the same name')
assert.notEqual(assetName('rock', 'glb', 'other bytes'), name)
assert.equal(assetName('rock', 'glb', new Uint8Array([1, 2, 3])), assetName('rock', 'glb', new Uint8Array([1, 2, 3])))

assert.deepEqual(uploadPlan({ name, sizeBytes: 1024 }), { mode: 'inline', path: `/assets/${name}`, sizeBytes: 1024 })
const large = uploadPlan({ name, sizeBytes: 5 * 1024 * 1024 })
assert.equal(large.mode, 'upload-target')
assert.equal(large.reason, 'exceeds-inline-threshold')
assert.equal(uploadPlan({ name, sizeBytes: 100, maxInlineBytes: 100 }).mode, 'inline')
assert.equal(uploadPlan({ name, sizeBytes: 101, maxInlineBytes: 100 }).mode, 'upload-target')

for (const [call, code] of [
  [() => assetName('bad name', 'glb', 'x'), 'asset-value-invalid'],
  [() => assetName('rock', '../glb', 'x'), 'asset-ext-invalid'],
  [() => assetName('rock', 'glb', null), 'asset-content-invalid'],
  [() => uploadPlan({ name: '', sizeBytes: 1 }), 'asset-name-invalid'],
  [() => uploadPlan({ name, sizeBytes: -1 }), 'asset-size-invalid'],
  [() => uploadPlan({ name, sizeBytes: 1, maxInlineBytes: 0 }), 'asset-threshold-invalid'],
]) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

console.log('RESULT: PASS content-addressed asset names are stable, upload plans respect the inline threshold, and refusals carry codes')
