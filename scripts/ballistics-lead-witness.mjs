import assert from 'node:assert/strict'
import { solveShot, elevation } from '../src/shared/ballistics.js'

const FROM = [0, 0, 0]
const TO = [20, 0, 0]

const staticShot = solveShot(FROM, TO, 20, 9.81)
assert.ok(staticShot, 'a reachable static shot must solve')
assert.ok(Number.isFinite(staticShot.time) && staticShot.time > 0)
assert.ok(Math.abs(staticShot.aim.z) < 1e-9, 'an unled shot aims at the target')
assert.ok(Math.abs(staticShot.vel.x) > 0 && Math.abs(staticShot.vel.y) > 0)

const objectShot = solveShot({ x: 0, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }, 20, 9.81)
assert.ok(Math.abs(objectShot.time - staticShot.time) < 1e-9, 'array and object points must agree')

const ledShot = solveShot(FROM, TO, 20, 9.81, [0, 0, 10])
assert.ok(ledShot, 'a reachable led shot must solve')
assert.ok(ledShot.aim.z > 1, `a moving target must be led, aim.z=${ledShot.aim.z}`)
assert.ok(Math.abs(ledShot.vel.z) > 0.5, 'the led shot must carry lateral velocity')
assert.ok(Math.abs(ledShot.time - staticShot.time) > 1e-6, 'leading must change the flight time')

const sameLead = solveShot(FROM, TO, 20, 9.81, [0, 0, 0])
assert.ok(Math.abs(sameLead.aim.z) < 1e-9, 'zero lead must match the static aim')

assert.equal(elevation(20, 9.81, 0, 0), null)
assert.equal(solveShot(FROM, FROM, 20, 9.81), null)

for (const [call, code] of [
  [() => solveShot([0, 0], TO, 20, 9.81), 'ballistics-point-invalid'],
  [() => solveShot(FROM, { x: NaN, y: 0, z: 0 }, 20, 9.81), 'ballistics-point-invalid'],
  [() => solveShot(FROM, TO, 0, 9.81), 'ballistics-positive-invalid'],
  [() => solveShot(FROM, TO, 20, 9.81, [0, 0]), 'ballistics-point-invalid'],
  [() => elevation(20, 9.81, -1, 0), 'ballistics-distance-invalid'],
]) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

console.log('RESULT: PASS ballistics accepts array and object points, leads a moving target by its flight time, and refuses by code')
