import assert from 'node:assert/strict'
import { createTesterFleet, RENDER_MODES } from './lib/tester-body.mjs'

let clock = 0
const fleet = createTesterFleet({ now: () => clock, maxBodies: 2 })
const body = fleet.join({ tester: 1, room: 'gallery', render: 'none', latencyMs: 40, ttlS: 10 })
assert.equal(body.render, 'none')
assert.equal(body.expiresAtMs, 10000)
assert.equal(fleet.active().length, 1)
fleet.join({ tester: 2, room: 'gallery', render: 'cpu', ttlS: 20 })
assert.equal(fleet.active().length, 2)

clock = 10000
assert.deepEqual(fleet.prune(), [1])
assert.equal(fleet.active().length, 1)
assert.deepEqual(fleet.leave(2), { ok: true, tester: 2 })
assert.equal(fleet.active().length, 0)

assert.deepEqual([...RENDER_MODES], ['cpu', 'gpu', 'none'])

for (const [call, code] of [
  [() => createTesterFleet({ now: null }), 'tester-clock-invalid'],
  [() => createTesterFleet({ now: () => 0, maxBodies: 0 }), 'tester-cap-invalid'],
  [() => fleet.join({ tester: -1, room: 'x' }), 'tester-id-invalid'],
  [() => fleet.join({ tester: 0, room: '' }), 'tester-room-invalid'],
  [() => fleet.join({ tester: 0, room: 'x', render: 'software' }), 'tester-render-invalid'],
  [() => fleet.join({ tester: 0, room: 'x', latencyMs: -1 }), 'tester-latency-invalid'],
  [() => fleet.join({ tester: 0, room: 'x', ttlS: 0 }), 'tester-ttl-invalid'],
  [() => fleet.leave(99), 'tester-unknown'],
]) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

const capped = createTesterFleet({ now: () => 0, maxBodies: 1 })
capped.join({ tester: 1, room: 'x' })
assert.throws(() => capped.join({ tester: 2, room: 'x' }), e => e.reasonCode === 'tester-cap-reached')
assert.throws(() => capped.join({ tester: 1, room: 'x' }), e => e.reasonCode === 'tester-duplicate')

console.log('RESULT: PASS tester bodies join with render/latency/TTL, leave by tester id, expire and refuse by code')
