import assert from 'node:assert/strict'
import { stepProjectile, sweepProjectileGravity } from '../src/behaviours/projectileGravity.js'

const start = { position: [0, 0, 0], velocity: [10, 0, 0], dt: 1 }
const stepped = stepProjectile(start)
assert.deepEqual(stepped.position, [10, -4.905, 0])
assert.deepEqual(stepped.velocity, [10, -9.81, 0])
assert.deepEqual(stepProjectile({ ...start, gravity: 0 }).position, [10, 0, 0])

const sweep = sweepProjectileGravity({ from: [0, 0, 0], velocity: [10, 5, 0], dt: 1, steps: 4 })
assert.equal(sweep.ok, true)
assert.equal(sweep.hit, null)
assert.equal(sweep.points.length, 5)
assert.ok(sweep.position[1] > 0, 'the upward launch should still be above the ground')
assert.ok(sweep.position[1] < 5, 'gravity must bend the arc')

let calls = 0
const hit = sweepProjectileGravity({
  from: [0, 0, 0], velocity: [1, 0, 0], dt: 1, steps: 4,
  raycast: (a, b) => { calls++; return calls === 3 ? { at: b, id: 'wall' } : null },
})
assert.deepEqual(hit.hit.id, 'wall')
assert.equal(calls, 3)

for (const [call, code] of [
  [() => stepProjectile({ position: [0, 0], velocity: [1, 0, 0], dt: 1 }), 'vec3-invalid'],
  [() => stepProjectile({ position: [0, 0, 0], velocity: [1, 0, 0], dt: 0 }), 'projectile-dt-invalid'],
  [() => stepProjectile({ position: [0, 0, 0], velocity: [1, 0, 0], dt: 1, gravity: NaN }), 'projectile-gravity-invalid'],
  [() => sweepProjectileGravity({ from: [0, 0, 0], velocity: [1, 0, 0], dt: 1, steps: 0 }), 'projectile-steps-invalid'],
  [() => sweepProjectileGravity({ from: [0, 0, 0], velocity: [1, 0, 0], dt: 1, raycast: 1 }), 'projectile-raycast-invalid'],
]) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

console.log('RESULT: PASS projectile integration applies gravity per substep, sweeps substep rays and refuses by code')
