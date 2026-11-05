import assert from 'node:assert/strict'
import { routePress, createEventRouter } from '../src/interaction/pressRouter.js'

const objects = [
  { id: 'near', position: [0, 0, 2] },
  { id: 'behind', position: [0, 0, -2] },
  { id: 'far', position: [0, 0, 20] },
]
const found = routePress({ objects, origin: [0, 0, 0], forward: [0, 0, 1], label: 'Press E' })
assert.equal(found.ok, true)
assert.equal(found.target, 'near')
assert.equal(found.label, 'Press E')
assert.equal(routePress({ objects, origin: [0, 0, 0], forward: [0, 0, -1] }).target, 'behind')
assert.equal(routePress({ objects, origin: [0, 0, 0], forward: [1, 0, 0] }).reasonCode, 'press-no-target')

const router = createEventRouter()
const got = []
const off = router.subscribe('open', 'door-1', payload => { got.push(payload); return payload })
const presses = []
router.onPress(event => presses.push(event))
const result = router.emit('open', { by: 'alice' }, { to: 'door-1' })
assert.equal(result.delivered, 1)
assert.deepEqual(got, [{ by: 'alice' }])
assert.equal(presses.length, 1)
assert.equal(router.emit('open', { by: 'bob' }, { to: 'door-2' }).delivered, 0)
off()
assert.equal(router.emit('open', { by: 'carol' }, { to: 'door-1' }).delivered, 0)

for (const [call, code] of [
  [() => routePress({ objects: null, origin: [0, 0, 0], forward: [0, 0, 1] }), 'press-objects-invalid'],
  [() => routePress({ objects: [{ id: '' , position: [0,0,1] }], origin: [0, 0, 0], forward: [0, 0, 1] }), 'press-object-invalid'],
  [() => routePress({ objects, origin: [0, 0, 0], forward: [0, 0, 1], maxDistance: 0 }), 'press-distance-invalid'],
  [() => createEventRouter().onPress(null), 'press-hook-invalid'],
  [() => createEventRouter().subscribe('', null, () => {}), 'press-subscribe-invalid'],
]) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

console.log('RESULT: PASS press router selects the nearest camera-facing target and routes channel events by recipient')
