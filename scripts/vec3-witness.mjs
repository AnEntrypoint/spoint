import assert from 'node:assert/strict'
import { add, sub, scale, dot, cross, length, distance, normalize, lerp, clampLength, reflect, angleTo } from '../src/shared/vec3.js'

const a = Object.freeze([1, 2, 3])
const b = Object.freeze([4, 5, 6])

assert.deepEqual(add(a, b), [5, 7, 9])
assert.deepEqual(sub(b, a), [3, 3, 3])
assert.deepEqual(scale(a, 2), [2, 4, 6])
assert.equal(dot(a, b), 32)
assert.deepEqual(cross([1, 0, 0], [0, 1, 0]), [0, 0, 1])
assert.ok(Math.abs(length([3, 4, 0]) - 5) < 1e-12)
assert.ok(Math.abs(distance([0, 0, 0], [3, 4, 0]) - 5) < 1e-12)
assert.deepEqual(normalize([3, 0, 0]), [1, 0, 0])
assert.deepEqual(lerp([0, 0, 0], [10, 20, 30], 0.5), [5, 10, 15])
assert.ok(Math.abs(length(clampLength([10, 0, 0], 3)) - 3) < 1e-12)
assert.deepEqual(clampLength([1, 0, 0], 3), [1, 0, 0])
assert.deepEqual(reflect([1, -1, 0], [0, 1, 0]), [1, 1, 0])
assert.ok(Math.abs(angleTo([1, 0, 0], [0, 1, 0]) - Math.PI / 2) < 1e-12)
assert.deepEqual(a, [1, 2, 3], 'inputs must not be mutated')

for (const [call, code] of [
  [() => add([1, 2], b), 'vec3-invalid'],
  [() => scale(a, Infinity), 'vec3-scale-invalid'],
  [() => normalize([0, 0, 0]), 'vec3-zero-length'],
  [() => lerp(a, b, 2), 'vec3-t-invalid'],
  [() => clampLength(a, -1), 'vec3-max-invalid'],
  [() => angleTo([0, 0, 0], b), 'vec3-zero-length'],
]) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

console.log('RESULT: PASS vec3 array law is pure, covers the Spawn builtin/vec3 operations, and refuses by code')
