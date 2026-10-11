import { MessageHandler } from '../src/client/MessageHandler.js'
import { MSG } from '../src/protocol/MessageTypes.js'
import { WIRE_STRUCT_HASH } from '../src/protocol/msgpack.js'

const TAG = 'reconnect-ack-identity'

function reconnectPlayerId(payload) {
  const handler = new MessageHandler({ tickRate: 30 })
  handler.handleMessage(MSG.RECONNECT_ACK, {
    structHash: WIRE_STRUCT_HASH, tickRate: 30, position: [0, 5, 0], health: 100, sessionToken: null, ...payload
  })
  return handler.getPlayerId()
}

const checks = []

function expect(label, got, want) {
  const ok = got === want
  checks.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`)
}

console.log(`[${TAG}] module=src/client/MessageHandler.js`)
expect('reconnect: the client takes its id from localPlayerId', reconnectPlayerId({ localPlayerId: 7 }), 7)
expect('reconnect: a worker id of 0 survives, not dropped as falsy', reconnectPlayerId({ localPlayerId: 0 }), 0)
expect('reconnect: localPlayerId beats a legacy playerId in the same payload', reconnectPlayerId({ localPlayerId: 7, playerId: 9 }), 7)
expect('reconnect: a payload naming only the legacy playerId still resolves', reconnectPlayerId({ playerId: 9 }), 9)

const failed = checks.filter(ok => !ok).length
const verdict = failed === 0 ? 'PASS' : 'FAIL'
console.log(`RESULT: ${verdict} (${checks.length - failed}/${checks.length})`)
process.exitCode = failed === 0 ? 0 : 1
