import { SEND_ACCEPTED, SEND_REJECTED } from '../src/transport/TransportWrapper.js'
import { WireweaveTransport } from '../src/transport/WireweaveTransport.js'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

const PEER = 'peer-pubkey'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

class FakeSession extends EventTarget {
  constructor({ open = true, accept = true } = {}) {
    super()
    this.peers = new Map(open ? [[PEER, { dc: { readyState: 'open' } }]] : [])
    this.accept = accept
    this.frames = []
  }

  send(peer, frame) {
    this.frames.push(frame)
    return typeof this.accept === 'function' ? this.accept(frame) : this.accept
  }
}

const transportOver = (session) => {
  const transport = new WireweaveTransport({ session, peerPubkey: PEER })
  const errors = []
  transport.on('error', (error) => errors.push(error))
  return { transport, errors }
}

const answers = []
const answered = (value) => {
  answers.push(value)
  return value
}

const small = new Uint8Array(5).fill(0x01)
const large = new Uint8Array(200).fill(0x41)
const prefixed = new Uint8Array(150).fill(0xbe)

{
  const session = new FakeSession({ open: false })
  const { transport } = transportOver(session)
  const answer = answered(transport.send(small))
  check('a transport whose peer is not open answers SEND_REJECTED', answer === SEND_REJECTED, `answer=${String(answer)}`)
  check('a transport whose peer is not open puts no frame on the wire', session.frames.length === 0)
}

{
  const session = new FakeSession({ accept: true })
  const { transport, errors } = transportOver(session)
  const answer = answered(transport.send(small))
  check('a small item on the batch path answers SEND_ACCEPTED', answer === SEND_ACCEPTED, `answer=${String(answer)}`)
  await tick()
  check('the batch path sends the queued item on the next tick', session.frames.length === 1 && errors.length === 0, `frames=${session.frames.length}`)
}

{
  const session = new FakeSession({ accept: true })
  const { transport } = transportOver(session)
  const answer = answered(transport.send(large))
  check('a large item on the large path answers SEND_ACCEPTED when the session accepts it', answer === SEND_ACCEPTED, `answer=${String(answer)}`)
}

{
  const session = new FakeSession({ accept: true })
  const { transport } = transportOver(session)
  const answer = answered(transport.send(prefixed))
  check('a large item that begins with the batch prefix byte answers SEND_ACCEPTED', answer === SEND_ACCEPTED, `answer=${String(answer)}`)
}

{
  const session = new FakeSession({ accept: true })
  const { transport } = transportOver(session)
  const first = answered(transport.send(small))
  const second = answered(transport.send(large))
  check('a small item queued before a large item answers SEND_ACCEPTED for both', first === SEND_ACCEPTED && second === SEND_ACCEPTED, `first=${String(first)} second=${String(second)}`)
  check('the small item is flushed before the large item, so two frames reach the wire', session.frames.length === 2 && session.frames[0].byteLength === small.byteLength, `frames=${session.frames.length}`)
}

{
  const session = new FakeSession({ accept: false })
  const { transport, errors } = transportOver(session)
  const answer = answered(transport.send(large))
  check('a large item the session refuses answers SEND_REJECTED', answer === SEND_REJECTED, `answer=${String(answer)}`)
  check('the large path reports the refused frame as a send-refused error', errors.length === 1 && errors[0].reason === 'send-refused', JSON.stringify(errors))
}

{
  const session = new FakeSession({ accept: false })
  const { transport, errors } = transportOver(session)
  const answer = answered(transport.send(small))
  check('a small item on the batch path answers SEND_ACCEPTED because it is queued for the batch', answer === SEND_ACCEPTED, `answer=${String(answer)}`)
  await tick()
  check('a refused batch frame is reported as a send-refused error on the next tick', errors.length === 1 && errors[0].reason === 'send-refused', JSON.stringify(errors))
}

{
  const session = new FakeSession({ accept: (frame) => frame.byteLength <= 16000 })
  const { transport, errors } = transportOver(session)
  const answer = answered(transport.send(new Uint8Array(40000).fill(0x07)))
  check('a fragmented-size item the session cannot publish whole answers SEND_REJECTED', answer === SEND_REJECTED, `answer=${String(answer)}`)
  check('the partial publish is reported as a send-refused error', errors.length === 1 && errors[0].reason === 'send-refused', JSON.stringify(errors))
}

{
  const session = new FakeSession({ accept: true })
  const { transport } = transportOver(session)
  const answer = answered(transport.sendUnreliable(large))
  check('sendUnreliable on the large path answers SEND_ACCEPTED', answer === SEND_ACCEPTED, `answer=${String(answer)}`)
}

check('every answer from every send path is exactly SEND_ACCEPTED or SEND_REJECTED', answers.every((answer) => answer === SEND_ACCEPTED || answer === SEND_REJECTED), answers.map((answer) => String(answer)).join(','))

const failed = checks.filter((c) => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`)
  await exitAfterQuiesce(1)
} else {
  console.log('RESULT: PASS WireweaveTransport.send answers SEND_ACCEPTED or SEND_REJECTED on every path: not-open, batch, large, prefixed, refused, and sendUnreliable')
  await exitAfterQuiesce(0)
}
