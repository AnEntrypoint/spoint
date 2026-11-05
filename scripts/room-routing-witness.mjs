import assert from 'node:assert/strict'
import { firstOpenRoom, mostFullWithSpace, nextRoomName, parseRoomPickRequest } from '../src/sdk/RoomRouting.js'

const rooms = [
  { id: 'alpha', players: 3, maxPlayers: 4 },
  { id: 'beta', players: 2, maxPlayers: 4 },
  { id: 'gamma', players: 4, maxPlayers: 4 },
  { id: 'delta', players: 1, maxPlayers: 2 },
]

assert.equal(firstOpenRoom(rooms)?.id, 'alpha')
assert.equal(firstOpenRoom(rooms, { rejected: ['alpha'] })?.id, 'beta')
assert.equal(firstOpenRoom(rooms, { requestedRoomId: 'delta' })?.id, 'delta')
assert.equal(firstOpenRoom(rooms, { requestedRoomId: 'gamma' }), null)
assert.equal(mostFullWithSpace(rooms)?.id, 'alpha')
assert.equal(mostFullWithSpace(rooms, { rejected: ['alpha'] })?.id, 'beta')
assert.equal(mostFullWithSpace([{ id: 'x', players: 2, maxPlayers: 4 }, { id: 'a', players: 2, maxPlayers: 4 }])?.id, 'a')
assert.equal(mostFullWithSpace([{ id: 'full', players: 4, maxPlayers: 4 }]), null)

assert.equal(nextRoomName('room', []), 'room-1')
assert.equal(nextRoomName('room', ['room-1', 'room-2']), 'room-3')
assert.equal(nextRoomName('room', { 0: 'room-1' }), 'room-1')

assert.deepEqual(parseRoomPickRequest({ requestedRoomId: 'alpha', rejected: ['beta'], world: 'tps-game' }), { requestedRoomId: 'alpha', rejected: ['beta'], world: 'tps-game' })
assert.deepEqual(parseRoomPickRequest({ requested: 'alpha' }), { requestedRoomId: 'alpha', rejected: [], world: null })
assert.deepEqual(parseRoomPickRequest({}), { requestedRoomId: null, rejected: [], world: null })

for (const [call, code] of [
  [() => firstOpenRoom(null), 'room-rooms-invalid'],
  [() => firstOpenRoom([{ id: 'x', players: -1, maxPlayers: 4 }]), 'room-entry-invalid'],
  [() => mostFullWithSpace([{ id: 'x', players: 1, maxPlayers: 0 }]), 'room-entry-invalid'],
  [() => nextRoomName('bad prefix', []), 'room-prefix-invalid'],
  [() => parseRoomPickRequest({ rejected: [1] }), 'room-request-invalid'],
  [() => parseRoomPickRequest({ requestedRoomId: 3 }), 'room-request-invalid'],
]) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

console.log('RESULT: PASS first-open and most-full room selection honour capacity, request and rejection; room names and requests refuse by code')
