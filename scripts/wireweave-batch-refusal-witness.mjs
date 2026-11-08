import { SEND_ACCEPTED } from '../src/transport/TransportWrapper.js'
import { WireweaveTransport } from '../src/transport/WireweaveTransport.js'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

const PEER = 'peer-pubkey'
const BATCH_PREFIX = 0xbe

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

class RefusingSession extends EventTarget {
  constructor() {
    super()
    this.peers = new Map([[PEER, { dc: { readyState: 'open' } }]])
    this.frames = []
  }

  send(peer, frame) {
    this.frames.push(frame)
    return false
  }
}

const session = new RefusingSession()
const transport = new WireweaveTransport({ session, peerPubkey: PEER })
const errors = []
transport.on('error', (error) => errors.push(error))

const first = new Uint8Array(3).fill(0x11)
const second = new Uint8Array(6).fill(0x22)
const answers = [transport.send(first), transport.send(second)]

check('each item queued into the send queue answers SEND_ACCEPTED', answers.every((answer) => answer === SEND_ACCEPTED), answers.map(String).join(','))
check('the refusal is not reported synchronously, before the batch is flushed', errors.length === 0, `errors=${errors.length}`)

await tick()

check('one refused batch frame emits exactly one send-refused event', errors.length === 1 && errors[0].reason === 'send-refused', JSON.stringify(errors))
check('the session is asked once, with the whole batch, not once per item', session.frames.length === 1, `frames=${session.frames.length}`)
const batchBytes = 1 + (4 + first.byteLength) + (4 + second.byteLength)
check('the send-refused event names the size of the batch frame', errors[0]?.byteLength === batchBytes, `byteLength=${errors[0]?.byteLength} expected=${batchBytes}`)
check('the refused frame is a spoint batch frame with the 0xBE prefix', session.frames.length === 1 && new Uint8Array(session.frames[0])[0] === BATCH_PREFIX)

const failed = checks.filter((c) => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`)
  await exitAfterQuiesce(1)
} else {
  console.log('RESULT: PASS a refused batch frame emits one send-refused event after the queued sends answered SEND_ACCEPTED, naming the batch frame size')
  await exitAfterQuiesce(0)
}
