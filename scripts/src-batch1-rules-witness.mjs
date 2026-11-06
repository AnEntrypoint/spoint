import assert from 'node:assert/strict'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { parsePlayerId, tryParsePlayerId } = await import('../src/game/playerId.js')
const { isRegisteredMessage, msgName, isUnreliable } = await import('../src/protocol/MessageTypes.js')

assert.equal(parsePlayerId(1), parsePlayerId('1'), 'the integer 1 and the string 1 parse to the same key')
assert.equal(tryParsePlayerId(''), null, 'an empty string is not a player id')
assert.equal(tryParsePlayerId(1.5), null, 'a non-integer number is not a player id')

const unknownId = 0xfe
assert.equal(isRegisteredMessage(unknownId), false, 'an unregistered id is not registered')
assert.equal(typeof msgName(unknownId), 'string', 'an unregistered id answers a named string, never null')
assert.equal(isUnreliable(unknownId), false, 'an unregistered id answers a strict false from isUnreliable')

console.log('RESULT: PASS player ids parse integers and strings to one key; an unregistered message id answers a string name and a strict false from isUnreliable')
