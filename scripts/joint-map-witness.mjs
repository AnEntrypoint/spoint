import assert from 'node:assert/strict'
import { createJointMap, JOINT_TYPES } from '../src/physics/jointMap.js'

const written = []
const removed = []
const joints = createJointMap({ setConstraint: (id, spec) => written.push([id, spec]), removeConstraint: id => removed.push(id) })
const shoulder = joints.set('shoulder', { to: 'upper-arm', anchor: [0, 1, 0], targetAnchor: [0, 0, 0], target: [0, 0, 0, 1], strength: 0.8, limits: { cone: 1 } })
assert.equal(shoulder.to, 'upper-arm')
assert.equal(shoulder.target[3], 1)
assert.equal(written.length, 1)
assert.deepEqual(joints.ids(), ['shoulder'])
assert.equal(Object.isFrozen(shoulder), true)

const retuned = joints.retuneLimits('shoulder', { cone: 2, twist: 0.5 })
assert.equal(retuned.target[3], 1, 'retuning limits must preserve the first pose')
assert.equal(retuned.limits.cone, 2)
assert.deepEqual(joints.remove('shoulder'), { ok: true, id: 'shoulder' })
assert.deepEqual(removed, ['shoulder'])
assert.equal(JOINT_TYPES.length, 5)

for (const [call, code] of [
  [() => createJointMap({ setConstraint: 1 }), 'joint-hook-invalid'],
  [() => joints.set('', { to: 'x' }), 'joint-id-invalid'],
  [() => joints.set('x', {}), 'joint-target-invalid'],
  [() => joints.set('x', { to: 'y', type: 'spring' }), 'joint-type-invalid'],
  [() => joints.set('x', { to: 'y', anchor: [0, 0] }), 'quat-vec-invalid'],
  [() => joints.set('x', { to: 'y', target: [0, 0, 0] }), 'quat-invalid'],
  [() => joints.set('x', { to: 'y', strength: -1 }), 'joint-strength-invalid'],
  [() => joints.retuneLimits('missing', {}), 'joint-unknown'],
  [() => joints.remove('missing'), 'joint-unknown'],
]) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

console.log('RESULT: PASS declarative joint handles carry anchors, targets and limits, preserve the first pose and refuse by code')
