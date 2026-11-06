import assert from 'node:assert/strict'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { PlayerManager } = await import('../src/netcode/PlayerManager.js')

const manager = new PlayerManager()
const socket = { send() {}, close() {}, readyState: 1 }
const id = manager.addPlayer(socket, {})
const playerId = typeof id === 'string' || typeof id === 'number' ? id : [...manager.players.keys()][0]
manager.players.get(playerId).ackSequence = 5
assert.equal(manager.ackSequenceOf(playerId), 5, 'ackSequenceOf publishes the sequence addInput compares against')
manager.addInput(playerId, {}, 5)
assert.equal(manager.getInputs(playerId).length, 0, 'an input at the acked sequence is dropped by the same comparison')
manager.addInput(playerId, {}, 6)
assert.equal(manager.getInputs(playerId).length, 1, 'an input past the acked sequence is buffered')

console.log('RESULT: PASS ackSequenceOf returns the sequence addInput compares against: an input at or below it is dropped and one above it is buffered')
