import assert from 'node:assert/strict'
import { beltVelocity, surfaceVelocityAt } from '../src/physics/surfaceVelocity.js'
import { fromAxisAngle } from '../src/shared/quat.js'

assert.deepEqual(beltVelocity({ surfaceVelocity: [2, 0, 0] }), [2, 0, 0])
const rotated = beltVelocity({ surfaceVelocity: [1, 0, 0], surfaceQuaternion: fromAxisAngle([0, 1, 0], Math.PI / 2) })
assert.ok(Math.abs(rotated[0]) < 1e-12)
assert.ok(Math.abs(rotated[2] + 1) < 1e-12)
assert.deepEqual(beltVelocity({ contactPoint: [0, 1, 0], angularVelocity: [0, 0, 1] }), [-1, 0, 0])
const both = beltVelocity({ surfaceVelocity: [1, 0, 0], contactPoint: [0, 1, 0], angularVelocity: [0, 0, 1] })
assert.deepEqual(both, [0, 0, 0])
const slip = surfaceVelocityAt({ surfaceVelocity: [2, 0, 0], relativeVelocity: [3, 0, 0] })
assert.deepEqual(slip.belt, [2, 0, 0])
assert.deepEqual(slip.slip, [1, 0, 0])

assert.throws(() => beltVelocity({ surfaceVelocity: [1, 2] }), e => e.reasonCode === 'vec3-invalid')
assert.throws(() => beltVelocity({ surfaceQuaternion: [0, 0, 0] }), e => e.reasonCode === 'quat-invalid')
assert.throws(() => surfaceVelocityAt({ relativeVelocity: [1, 2] }), e => e.reasonCode === 'vec3-invalid')

console.log('RESULT: PASS conveyor surface velocity rotates into the body frame, adds angular tangential velocity, and reports slip')
