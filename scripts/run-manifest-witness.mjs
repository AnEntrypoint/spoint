import assert from 'node:assert/strict'
import { createRunManifest, manifestPath, manifestDigest } from './lib/run-manifest.mjs'

const manifest = createRunManifest({ id: '2026-11-06-0900', task: 'implement features', createdAt: '2026-11-06T09:00:00.000Z', workspace: '/workspace/spoint' })
assert.equal(Object.isFrozen(manifest), true)
assert.equal(manifest.maxInflight, 8)
assert.equal(manifest.maxSteps, 50)
assert.equal(manifestPath('/workspace/spoint', '2026-11-06-0900'), '/workspace/spoint/runs/2026-11-06-0900/task.json')
assert.equal(manifestPath('/workspace/spoint/', 'a'), '/workspace/spoint/runs/a/task.json')
assert.match(manifestDigest(manifest), /^[0-9a-f]{64}$/)
assert.equal(manifestDigest(manifest), manifestDigest({ ...manifest }))
assert.notEqual(manifestDigest(manifest), manifestDigest({ ...manifest, task: 'other' }))

for (const [call, code] of [
  [() => createRunManifest({ id: '', task: 'x', createdAt: 't' }), 'manifest-id-invalid'],
  [() => createRunManifest({ id: 'a', task: '', createdAt: 't' }), 'manifest-task-invalid'],
  [() => createRunManifest({ id: 'a', task: 'x', createdAt: 't', maxInflight: 0 }), 'manifest-inflight-invalid'],
  [() => createRunManifest({ id: 'a', task: 'x', createdAt: 't', maxSteps: -1 }), 'manifest-steps-invalid'],
  [() => createRunManifest({ id: 'a', task: 'x' }), 'manifest-time-invalid'],
  [() => createRunManifest({ id: 'a', task: 'x', createdAt: 't', workspace: 3 }), 'manifest-workspace-invalid'],
  [() => manifestPath(null, 'a'), 'manifest-path-invalid'],
  [() => manifestDigest(null), 'manifest-invalid'],
]) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

console.log('RESULT: PASS run manifest factory bounds inflight and steps, names the run path and refuses by code')
