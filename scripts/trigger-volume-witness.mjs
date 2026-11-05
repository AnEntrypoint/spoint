import assert from 'node:assert/strict'
import { createTriggerVolume } from '../src/behaviours/triggerVolume.js'

const BOUNDS = { min: [0, 0, 0], max: [10, 10, 10] }
const INSIDE_A = [1, 2, 3]
const INSIDE_B = [5, 5, 5]
const OUTSIDE = [20, 2, 3]
const enters = []
const exits = []
const writes = []
let clock = 0
const now = () => clock
const volume = createTriggerVolume({
  id: 'plate-1',
  bounds: BOUNDS,
  rearmMs: 1000,
  now,
  onEnter: (entityId, detail) => enters.push({ entityId, detail }),
  onExit: (entityId, detail) => exits.push({ entityId, detail }),
  linkedState: (record) => writes.push(record),
})

assert.equal(volume.id, 'plate-1')
assert.deepEqual(volume.bounds, BOUNDS)
assert.equal(volume.size, 0)
assert.equal(volume.down, false)
assert.equal(volume.up, true)
assert.equal(volume.state, 'up')
assert.equal(volume.armed, true)
assert.equal(volume.rearmUntilMs, 0)

const empty = volume.update([])
assert.deepEqual(empty.entered, [])
assert.deepEqual(empty.exited, [])
assert.equal(empty.down, false)
assert.equal(empty.up, true)
assert.equal(enters.length, 0)
assert.equal(writes.length, 0, 'an empty volume writes no linked state')

const first = volume.update([{ id: 'a', position: INSIDE_A }, { id: 'outside', position: OUTSIDE }])
assert.deepEqual(first.entered, ['a'])
assert.equal(first.down, true)
assert.equal(first.up, false)
assert.equal(volume.size, 1)
assert.deepEqual([...volume.overlapping].sort(), ['a'])
assert.equal(enters.length, 1)
assert.equal(enters[0].entityId, 'a')
assert.equal(enters[0].detail.id, 'plate-1')
assert.equal(enters[0].detail.atMs, 0)
assert.deepEqual(enters[0].detail.position, INSIDE_A)
assert.deepEqual(enters[0].detail.overlapping, ['a'])
assert.equal(writes.length, 1)
assert.equal(writes[0].id, 'plate-1')
assert.equal(writes[0].state, 'down')
assert.equal(writes[0].down, true)
assert.equal(writes[0].atMs, 0)
assert.deepEqual(writes[0].overlapping, ['a'])

const second = volume.update([{ id: 'a', position: INSIDE_A }, { id: 'b', position: INSIDE_B }])
assert.deepEqual(second.entered, ['b'])
assert.equal(second.down, true)
assert.equal(volume.size, 2)
assert.deepEqual([...volume.overlapping].sort(), ['a', 'b'])
assert.equal(enters.length, 2)
assert.equal(enters[1].entityId, 'b')
assert.equal(writes.length, 1, 'a second overlap must not rewrite the linked state')

const steady = volume.update([{ id: 'a', position: INSIDE_A }, { id: 'b', position: INSIDE_B }])
assert.deepEqual(steady.entered, [])
assert.deepEqual(steady.exited, [])
assert.equal(enters.length, 2, 'steady updates emit no extra onEnter')
assert.equal(exits.length, 0)
assert.equal(writes.length, 1)

const oneLeft = volume.update([{ id: 'b', position: INSIDE_B }])
assert.deepEqual(oneLeft.exited, ['a'])
assert.equal(oneLeft.down, true)
assert.equal(oneLeft.up, false)
assert.equal(exits.length, 1)
assert.equal(exits[0].entityId, 'a')
assert.equal(writes.length, 1, 'the plate stays down and writes no up while one entity overlaps')

const lastLeft = volume.update([])
assert.deepEqual(lastLeft.exited, ['b'])
assert.equal(lastLeft.down, false)
assert.equal(lastLeft.up, true)
assert.equal(exits.length, 2)
assert.equal(exits[1].entityId, 'b')
assert.equal(writes.length, 2)
assert.equal(writes[1].state, 'up')
assert.equal(writes[1].down, false)
assert.deepEqual(writes[1].overlapping, [])
assert.equal(volume.armed, false)
assert.equal(volume.rearmUntilMs, 1000)

clock = 400
const suppressed = volume.update([{ id: 'c', position: INSIDE_A }])
assert.deepEqual(suppressed.entered, ['c'])
assert.equal(suppressed.down, true)
assert.equal(suppressed.armed, false)
assert.equal(volume.state, 'down')
assert.equal(enters.length, 2, 'a re-arm window suppresses onEnter')
assert.equal(exits.length, 2)
assert.equal(writes.length, 2, 'a re-arm window suppresses the linked state write')

clock = 999
const stillSuppressed = volume.update([{ id: 'c', position: INSIDE_A }])
assert.deepEqual(stillSuppressed.entered, [])
assert.equal(stillSuppressed.armed, false)
assert.equal(enters.length, 2)
assert.equal(writes.length, 2)

clock = 1000
const rearmed = volume.update([{ id: 'c', position: INSIDE_A }])
assert.equal(rearmed.armed, true)
assert.equal(enters.length, 3, 'the re-arm releases the pending overlap')
assert.equal(enters[2].entityId, 'c')
assert.equal(enters[2].detail.atMs, 1000)
assert.equal(writes.length, 3)
assert.equal(writes[2].state, 'down')
assert.equal(writes[2].atMs, 1000)
assert.deepEqual(writes[2].overlapping, ['c'])

clock = 1100
const releasedExit = volume.update([])
assert.deepEqual(releasedExit.exited, ['c'])
assert.equal(exits.length, 3)
assert.equal(exits[2].entityId, 'c')
assert.equal(writes.length, 4)
assert.equal(writes[3].state, 'up')
assert.equal(volume.armed, false)
assert.equal(volume.rearmUntilMs, 2100)

clock = 2100
const fresh = volume.update([{ id: 'd', position: INSIDE_A }])
assert.equal(fresh.armed, true)
assert.equal(enters.length, 4)
assert.equal(enters[3].entityId, 'd')
assert.equal(writes.length, 5)
assert.equal(writes[4].state, 'down')

clock = 2200
const freshExit = volume.update([])
assert.deepEqual(freshExit.exited, ['d'])
assert.equal(exits.length, 4)
assert.equal(writes.length, 6)
assert.equal(writes[5].state, 'up')
assert.equal(volume.armed, false)
assert.equal(volume.rearmUntilMs, 3200)

clock = 2500
const suppressedEnter = volume.update([{ id: 'e', position: INSIDE_A }])
assert.deepEqual(suppressedEnter.entered, ['e'])
assert.equal(suppressedEnter.armed, false)
assert.equal(enters.length, 4)
assert.equal(writes.length, 6)

clock = 2600
const suppressedExit = volume.update([])
assert.deepEqual(suppressedExit.exited, ['e'])
assert.equal(exits.length, 4, 'a suppressed overlap emits no onExit')
assert.equal(writes.length, 6)
assert.equal(volume.rearmUntilMs, 3200, 'a suppressed release must not restart the re-arm timer')

clock = 3200
const settled = volume.update([])
assert.equal(settled.armed, true)
assert.equal(enters.length, 4)
assert.equal(exits.length, 4)
assert.equal(writes.length, 6)
assert.equal(volume.size, 0)

const overlapCopy = volume.overlapping
overlapCopy.add('ghost')
assert.equal(volume.size, 0, 'overlapping exposes a copy, not the internal Set')

const plainEnters = []
const plainWrites = []
const plain = createTriggerVolume({
  id: 'plain',
  bounds: BOUNDS,
  onEnter: (entityId) => plainEnters.push(entityId),
  linkedState: (record) => plainWrites.push(record.state),
})
plain.update([{ id: 1, position: INSIDE_A }])
plain.update([])
plain.update([{ id: 2, position: INSIDE_B }])
assert.deepEqual(plainEnters, [1, 2])
assert.deepEqual(plainWrites, ['down', 'up', 'down'])
assert.equal(plain.armed, true)

const edge = createTriggerVolume({ id: 'edge', bounds: BOUNDS })
const edgeResult = edge.update([
  { id: 'min', position: [0, 0, 0] },
  { id: 'max', position: [10, 10, 10] },
  { id: 'out', position: [-0.001, 5, 5] },
])
assert.deepEqual(edgeResult.overlapping.sort(), ['max', 'min'])
assert.equal(edge.size, 2)

const refusals = [
  [() => createTriggerVolume({ id: 'x', bounds: null }), 'trigger-bounds-invalid'],
  [() => createTriggerVolume({ id: 'x', bounds: { min: [0, 0, 0], max: [0, 0, -1] } }), 'trigger-bounds-invalid'],
  [() => createTriggerVolume({ id: 'x', bounds: { min: [0, 0, 0], max: [1, Number.NaN, 2] } }), 'trigger-bounds-invalid'],
  [() => createTriggerVolume({ id: 'x', bounds: { min: [0, 0], max: [1, 2, 3] } }), 'trigger-bounds-invalid'],
  [() => createTriggerVolume({ id: '', bounds: BOUNDS }), 'trigger-id-invalid'],
  [() => createTriggerVolume({ id: 'x', bounds: BOUNDS, onEnter: 7 }), 'trigger-hooks-invalid'],
  [() => createTriggerVolume({ id: 'x', bounds: BOUNDS, linkedState: 'down' }), 'trigger-hooks-invalid'],
  [() => createTriggerVolume({ id: 'x', bounds: BOUNDS, rearmMs: -1 }), 'trigger-rearm-invalid'],
  [() => createTriggerVolume({ id: 'x', bounds: BOUNDS, rearmMs: Number.POSITIVE_INFINITY }), 'trigger-rearm-invalid'],
  [() => createTriggerVolume({ id: 'x', bounds: BOUNDS, now: 0 }), 'trigger-clock-invalid'],
  [() => createTriggerVolume({ id: 'x', bounds: BOUNDS, now: () => Number.NaN }).update([]), 'trigger-clock-invalid'],
  [() => volume.update(null), 'trigger-entities-invalid'],
  [() => volume.update([null]), 'trigger-entity-invalid'],
  [() => volume.update([{ id: 'x' }]), 'trigger-entity-invalid'],
  [() => volume.update([{ id: 'x', position: [1, 2] }]), 'trigger-entity-invalid'],
  [() => volume.update([{ id: 'x', position: [1, Infinity, 3] }]), 'trigger-entity-invalid'],
  [() => volume.update([{ id: '', position: INSIDE_A }]), 'trigger-entity-invalid'],
  [() => volume.update([{ id: 'x', position: INSIDE_A }, { id: 'x', position: OUTSIDE }]), 'trigger-duplicate-id'],
]
for (const [call, code] of refusals) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}
assert.equal(volume.size, 0, 'a refusal must not mutate the overlap set')
assert.equal(volume.armed, true)
assert.equal(enters.length, 4)
assert.equal(exits.length, 4)
assert.equal(writes.length, 6)

console.log(`RESULT: PASS trigger volume ${enters.length} enter(s), ${exits.length} exit(s), ${writes.length} linked-state write(s), ${refusals.length} coded refusal(s), re-arm suppression, last-exit up and inclusive bounds`)
