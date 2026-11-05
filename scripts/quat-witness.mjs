import assert from 'node:assert/strict'
import { normalize, conjugate, multiply, rotate, fromAxisAngle } from '../src/shared/quat.js'

const identity = [0, 0, 0, 1]
assert.deepEqual(rotate(identity, [1, 2, 3]), [1, 2, 3])
const aroundY = fromAxisAngle([0, 1, 0], Math.PI / 2)
const rotated = rotate(aroundY, [1, 0, 0])
assert.ok(Math.abs(rotated[0]) < 1e-12, `x=${rotated[0]}`)
assert.ok(Math.abs(rotated[2] + 1) < 1e-12, `z=${rotated[2]}`)
assert.deepEqual(multiply(identity, aroundY), aroundY)
assert.deepEqual(multiply(aroundY, conjugate(aroundY)).map(v => Math.abs(v) < 1e-12 ? 0 : v), identity)
assert.ok(Math.abs(Math.hypot(...normalize([1, 1, 1, 1])) - 1) < 1e-12)

for (const [call, code] of [
  [() => rotate([0, 0], [1, 2, 3]), 'quat-invalid'],
  [() => rotate(identity, [1, 2]), 'quat-vec-invalid'],
  [() => normalize([0, 0, 0, 0]), 'quat-zero-length'],
  [() => fromAxisAngle([0, 0, 0], 1), 'quat-axis-zero'],
  [() => fromAxisAngle([1, 0, 0], NaN), 'quat-angle-invalid'],
]) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

console.log('RESULT: PASS quaternion law rotates, composes and inverts, and refuses malformed input by code')
