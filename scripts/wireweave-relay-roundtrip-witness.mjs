import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools'
import { WireweaveTransport } from '../src/transport/WireweaveTransport.js'
import { SEND_ACCEPTED, SEND_REJECTED } from '../src/transport/TransportWrapper.js'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

const SELF = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SELF), '..')
const JAYZEE = path.resolve(process.env.JAYZEE_ROOT ?? path.join(ROOT, '..', 'jayzee'))
const ROOM = 'spoint-wireweave-roundtrip'
const MTU = 16000
const BATCH_PREFIX = 0xbe

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (test, label, timeoutMs = 8000) => {
  const started = Date.now()
  while (!test()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await sleep(10)
  }
}

let relayModule, loopbackModule
try {
  relayModule = await import(pathToFileURL(path.join(JAYZEE, 'src/transport/wireweaveRelay.js')).href)
  loopbackModule = await import(pathToFileURL(path.join(JAYZEE, 'scripts/lib/loopbackNostrRelay.mjs')).href)
} catch (error) {
  console.log(`check jayzee checkout resolves at ${JAYZEE}: FAIL (${error.message})`)
  console.log(`RESULT: FAIL jayzee checkout not loadable at ${JAYZEE}; set JAYZEE_ROOT`)
  process.exit(1)
}
const { createWireweaveRelay } = relayModule
const { startLoopbackRelay } = loopbackModule
check('jayzee wireweave relay and loopback Nostr helper load from the jayzee checkout', typeof createWireweaveRelay === 'function' && typeof startLoopbackRelay === 'function')

const hex = (bytes) => Buffer.from(ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes)).toString('hex')

const concat = (parts) => {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(new Uint8Array(part.buffer ?? part, part.byteOffset ?? 0, part.byteLength), offset)
    offset += part.byteLength
  }
  return out
}

const batchOf = (items) => {
  const parts = [Uint8Array.of(BATCH_PREFIX)]
  for (const item of items) {
    const length = new Uint8Array(4)
    new DataView(length.buffer).setUint32(0, item.byteLength, false)
    parts.push(length, item)
  }
  return concat(parts)
}

const itemOf = (length, first, salt = 0) => {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = (i * 37 + salt) & 0xff
  if (length > 0) out[0] = first
  return out
}

class RelaySession extends EventTarget {
  constructor({ relay, peerPubkey, open = true }) {
    super()
    this.relay = relay
    this.peers = new Map(open ? [[peerPubkey, { dc: { readyState: 'open' } }]] : [])
    this.sent = []
    this.results = []
    this.received = []
    relay.onMessage((payload, from) => {
      this.received.push(Uint8Array.from(payload))
      this.dispatchEvent(new CustomEvent('data', { detail: { peerPubkey: from, data: payload } }))
    })
  }

  send(peer, frame) {
    const result = this.relay.send(frame)
    this.results.push(result)
    if (!result.ok) return false
    this.sent.push(Uint8Array.from(new Uint8Array(frame.buffer ?? frame, frame.byteOffset ?? 0, frame.byteLength)))
    return result.published === result.fragments
  }
}

const relay = await startLoopbackRelay()
const keys = [generateSecretKey(), generateSecretKey()]
const pubkeys = keys.map((sk) => getPublicKey(sk))
const sides = keys.map((sk, index) => {
  const peer = pubkeys[1 - index]
  const wire = createWireweaveRelay({
    relays: [relay.url],
    WebSocketImpl: WebSocket,
    verifyEvent,
    sign: (template) => finalizeEvent(template, sk),
    pubkey: pubkeys[index],
    room: ROOM,
  })
  const session = new RelaySession({ relay: wire, peerPubkey: peer })
  const transport = new WireweaveTransport({ session, peerPubkey: peer })
  const inbox = []
  transport.on('message', (item) => inbox.push(Uint8Array.from(new Uint8Array(item.buffer ?? item, item.byteOffset ?? 0, item.byteLength))))
  return { wire, session, transport, inbox }
})
const [alice, bob] = sides

const results = {}
try {
  alice.wire.connect()
  bob.wire.connect()
  await waitFor(() => alice.wire.isConnected() && bob.wire.isConnected(), 'both relay sockets')
  check('both peers connect their relay sockets to the jayzee loopback relay', true)

  const phase = async (items, expectedMessages = items.length) => {
    const sentMark = alice.session.sent.length
    const resultMark = alice.session.results.length
    const receivedMark = bob.session.received.length
    const inboxMark = bob.inbox.length
    const answers = items.map((item) => alice.transport.send(item))
    await waitFor(() => bob.inbox.length >= inboxMark + expectedMessages, 'delivery through the relay')
    return {
      answers,
      frames: alice.session.sent.slice(sentMark),
      results: alice.session.results.slice(resultMark),
      wireReceived: bob.session.received.slice(receivedMark),
      delivered: bob.inbox.slice(inboxMark),
    }
  }

  const small = [itemOf(5, 0x01, 1), itemOf(40, 0x02, 2), itemOf(100, 0x03, 3)]
  results.batch = await phase(small)
  check('three items under the threshold cross as one spoint batch frame, byte for byte', results.batch.frames.length === 1 && hex(results.batch.frames[0]) === hex(batchOf(small)), `frames=${results.batch.frames.length}`)
  check('the batch frame arrives at the peer exactly as it was sent', results.batch.wireReceived.length === 1 && hex(results.batch.wireReceived[0]) === hex(results.batch.frames[0]))
  check('the peer delivers the three items in order, each byte for byte', results.batch.delivered.length === 3 && results.batch.delivered.every((item, i) => hex(item) === hex(small[i])))
  check('every batch-path send answers SEND_ACCEPTED', results.batch.answers.every((answer) => answer === SEND_ACCEPTED), results.batch.answers.map(String).join(','))

  const raw = itemOf(200, 0x41, 4)
  results.raw = await phase([raw])
  check('a 200-byte item at the threshold or above crosses as its own unwrapped frame', results.raw.frames.length === 1 && hex(results.raw.frames[0]) === hex(raw))
  check('the peer delivers the 200-byte item unchanged', results.raw.delivered.length === 1 && hex(results.raw.delivered[0]) === hex(raw))
  check('the large-item send answers SEND_ACCEPTED', results.raw.answers[0] === SEND_ACCEPTED, `answer=${String(results.raw.answers[0])}`)

  const lead = itemOf(5, 0x42, 10)
  const mixedBig = itemOf(200, 0x43, 11)
  results.mixed = await phase([lead, mixedBig])
  check('a small item queued before a 200-byte item is flushed alone, so the large item is never batched with it', results.mixed.frames.length === 2 && hex(results.mixed.frames[0]) === hex(lead) && hex(results.mixed.frames[1]) === hex(mixedBig), `frames=${results.mixed.frames.length}`)
  check('the peer delivers both items in order', results.mixed.delivered.length === 2 && hex(results.mixed.delivered[0]) === hex(lead) && hex(results.mixed.delivered[1]) === hex(mixedBig))
  check('the queued small item and the large item both answer SEND_ACCEPTED', results.mixed.answers.every((answer) => answer === SEND_ACCEPTED), results.mixed.answers.map(String).join(','))

  const prefixed = itemOf(150, BATCH_PREFIX, 5)
  results.prefixed = await phase([prefixed])
  check('a large item that begins with the batch prefix byte is wrapped as a batch of one', results.prefixed.frames.length === 1 && hex(results.prefixed.frames[0]) === hex(batchOf([prefixed])))
  check('the peer unwraps that batch of one back to the original item', results.prefixed.delivered.length === 1 && hex(results.prefixed.delivered[0]) === hex(prefixed))
  check('the prefixed large-item send answers SEND_ACCEPTED', results.prefixed.answers[0] === SEND_ACCEPTED, `answer=${String(results.prefixed.answers[0])}`)

  const oversize = itemOf(3 * MTU + 17, 0x01, 6)
  results.fragmented = await phase([oversize])
  check('an item of three MTUs and a tail is fragmented by jayzee into four wireweave frames', results.fragmented.results.length === 1 && results.fragmented.results[0].ok === true && results.fragmented.results[0].fragments === 4, JSON.stringify(results.fragmented.results[0] ?? null))
  check('the reassembled item reaches the peer byte for byte', results.fragmented.delivered.length === 1 && hex(results.fragmented.delivered[0]) === hex(oversize))
  check('the fragmented send answers SEND_ACCEPTED once every fragment is published', results.fragmented.answers[0] === SEND_ACCEPTED, `answer=${String(results.fragmented.answers[0])}`)

  const many = Array.from({ length: 300 }, (_, i) => itemOf(100, 0x10 + (i % 200), 100 + i))
  results.many = await phase(many)
  check('300 small items queued in one tick form one batch that spans more than one MTU', results.many.frames.length === 1 && results.many.results[0].fragments > 1 && hex(results.many.frames[0]) === hex(batchOf(many)), `fragments=${results.many.results[0]?.fragments}`)
  check('the peer delivers all 300 items in order', results.many.delivered.length === 300 && results.many.delivered.every((item, i) => hex(item) === hex(many[i])))
  check('every send in the 300-item batch answers SEND_ACCEPTED', results.many.answers.every((answer) => answer === SEND_ACCEPTED), `sends=${results.many.answers.length}`)

  const echoed = [itemOf(7, 0x20, 7), itemOf(130, 0x21, 8), itemOf(60, 0x22, 9)]
  const echoAnswers = []
  bob.transport.on('message', (item) => echoAnswers.push(bob.transport.send(item)))
  const aliceMark = alice.inbox.length
  const outbound = echoed.map((item) => alice.transport.send(item))
  await waitFor(() => alice.inbox.length >= aliceMark + echoed.length, 'the echoed round trip')
  const returned = alice.inbox.slice(aliceMark)
  check('a round trip returns the same items in the same order, byte for byte', returned.length === echoed.length && returned.every((item, i) => hex(item) === hex(echoed[i])))
  check('every send in the round trip, outbound and echoed back, answers SEND_ACCEPTED', [...outbound, ...echoAnswers].every((answer) => answer === SEND_ACCEPTED), [...outbound, ...echoAnswers].map(String).join(','))
} catch (error) {
  console.log(`check phases completed without error: FAIL (${error.message})`)
  check('phases completed without error', false, error.message)
}

const cold = new RelaySession({ relay: alice.wire, peerPubkey: pubkeys[1], open: false })
const coldTransport = new WireweaveTransport({ session: cold, peerPubkey: pubkeys[1] })
const coldMark = alice.session.sent.length
const coldAnswer = coldTransport.send(itemOf(4, 0x30))
check('a transport whose peer is not open answers SEND_REJECTED and puts nothing on the wire', coldAnswer === SEND_REJECTED && coldTransport.ready === false && alice.session.sent.length === coldMark, `answer=${String(coldAnswer)}`)

alice.transport.close()
bob.transport.close()
alice.wire.close()
bob.wire.close()
await relay.close()

const failed = checks.filter((c) => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`)
  await exitAfterQuiesce(1)
} else {
  console.log('RESULT: PASS spoint WireweaveTransport round-trips batch, raw, prefixed, fragmented and echoed items through jayzee wireweaveRelay on a loopback Nostr relay, byte for byte')
  await exitAfterQuiesce(0)
}
