import assert from 'node:assert/strict'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { parsePlayerId, tryParsePlayerId } = await import('../src/game/playerId.js')
const { MSG, isRegisteredMessage, msgName, isUnreliable, UNRELIABLE_MSGS } = await import('../src/protocol/MessageTypes.js')

assert.equal(typeof parsePlayerId(1), 'string', 'an integer player id parses to a string key, not a number')
assert.equal(parsePlayerId(1), parsePlayerId('1'), 'the integer 1 and the string 1 parse to the same key')
assert.equal(tryParsePlayerId(''), null, 'an empty string is not a player id')
assert.equal(tryParsePlayerId(1.5), null, 'a non-integer number is not a player id')

const unreliableId = MSG.HEARTBEAT
assert.ok(UNRELIABLE_MSGS.has(unreliableId), 'the fixture id is in the unreliable set')
assert.equal(isRegisteredMessage(unreliableId), true)
assert.equal(isUnreliable(unreliableId), true, 'a registered unreliable id answers true')

const reliableId = Object.values(MSG).find(id => !UNRELIABLE_MSGS.has(id))
assert.notEqual(reliableId, undefined, 'the fixture set has a registered reliable id')
assert.equal(isUnreliable(reliableId), false, 'a registered reliable id answers false')

const unknownId = 0xfe
assert.equal(isRegisteredMessage(unknownId), false, 'an unregistered id is not registered')
assert.equal(typeof msgName(unknownId), 'string', 'an unregistered id answers a named string, never null')
assert.equal(isUnreliable(unknownId), false, 'an unregistered id answers a strict false from isUnreliable')

console.log('RESULT: PASS player ids parse integers and strings to one string key; a registered unreliable id answers true, a registered reliable id answers false, and an unregistered message id answers a string name and a strict false Removing the unregistration guard in isUnreliable is not detectable here, because UNRELIABLE_MSGS holds only registered ids.')
