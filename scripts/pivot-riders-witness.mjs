import assert from 'node:assert/strict'
import { pivotTransform, hingeAngle, riderReleaseVelocity } from '../src/physics/pivotTransform.js'
import { rotate } from '../src/shared/quat.js'

assert.deepEqual(pivotTransform({ position: [2, 0, 0] }), [2, 0, 0])
const hinged = hingeAngle({ openFraction: 1 })
assert.ok(Math.abs(hinged.angleRad - Math.PI / 2) < 1e-12)
const turned = pivotTransform({ position: [2, 0, 0], pivot: [1, 0, 0], quaternion: hinged.quaternion })
assert.ok(Math.abs(turned[0] - 1) < 1e-12, `x=${turned[0]}`)
assert.ok(Math.abs(turned[2] + 1) < 1e-12, `z=${turned[2]}`)
const scaled = pivotTransform({ position: [2, 0, 0], scale: [2, 1, 1] })
assert.deepEqual(scaled, [4, 0, 0])
assert.deepEqual(rotate(hingeAngle({ openFraction: 1, minAngleRad: 0, maxAngleRad: Math.PI }).quaternion, [1, 0, 0]).map(v => Math.abs(v) < 1e-12 ? 0 : v), [-1, 0, 0])

assert.deepEqual(riderReleaseVelocity({ platformVelocity: [3, 0, 0] }), [3, 0, 0])
assert.deepEqual(riderReleaseVelocity({ platformAngularVelocity: [0, 0, 2], riderOffset: [0, 1, 0] }), [-2, 0, 0])
assert.deepEqual(riderReleaseVelocity({ platformVelocity: [3, 0, 0], platformAngularVelocity: [0, 0, 2], riderOffset: [0, 1, 0] }), [1, 0, 0])

for (const [call, code] of [
  [() => pivotTransform({ position: [1, 2] }), 'vec3-invalid'],
  [() => hingeAngle({ openFraction: 2 }), 'pivot-open-invalid'],
  [() => hingeAngle({ openFraction: 0.5, minAngleRad: 2, maxAngleRad: 1 }), 'pivot-angle-invalid'],
]) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

console.log('RESULT: PASS hinge pivot transforms about an arbitrary point, angle bounds and rider release momentum are coded')
