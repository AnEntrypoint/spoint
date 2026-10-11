import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MODULE = process.env.INPUT_CODEC_MODULE
  ? resolve(process.env.INPUT_CODEC_MODULE)
  : resolve(REPO, 'src/protocol/InputCodec.js')
const { createInputSchema, encodeInputPacket, decodeInputPacket, quantizeInput } = await import(pathToFileURL(MODULE).href)

let failures = 0

function expect(claim, ok, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${claim}`)
  if (!ok && detail) console.log(`     ${detail}`)
}

const schema = createInputSchema({ inputAxes: ['throttle'] })
const EPOCH = 7
const TOTAL = 10
const entries = Array.from({ length: TOTAL }, (_, i) => ({
  sequence: 100 + i,
  data: {
    forward: i % 2 === 0,
    jump: i % 3 === 0,
    shoot: i === TOTAL - 1,
    yaw: (i * 0.37) % (2 * Math.PI),
    pitch: -0.5 + i * 0.1,
    expr: 40 + i,
    analogForward: 0.5 - i * 0.1,
    analogRight: -0.25 + i * 0.05,
    throttle: 0.75 - i * 0.02,
  },
}))

const tagged = encodeInputPacket(schema, entries, EPOCH)
const taggedDecoded = decodeInputPacket(schema, tagged)
expect('epoch-tagged packet decodes accepted', taggedDecoded.accepted === true, JSON.stringify(taggedDecoded.reason))
expect('epoch-tagged packet carries chartEpoch 7', taggedDecoded.chartEpoch === EPOCH, `got ${taggedDecoded.chartEpoch}`)
expect('epoch-tagged packet keeps the newest 8 of 10 entries', taggedDecoded.entries?.length === 8, `got ${taggedDecoded.entries?.length}`)
const newest = entries.slice(TOTAL - 8)
const seqsOk = taggedDecoded.entries?.every((e, i) => e.sequence === newest[i].sequence)
expect('decoded sequences are the last 8 in order', seqsOk === true, `got ${taggedDecoded.entries?.map(e => e.sequence).join(',')}`)
const dataOk = taggedDecoded.entries?.every((e, i) => isDeepStrictEqual(e.data, quantizeInput(schema, newest[i].data)))
expect('decoded data equals quantizeInput of the sent data for every record', dataOk === true)
expect('epoch tag sets bit 0x80 on the count byte', (tagged[0] & 0x80) === 0x80, `byte0=0x${tagged[0].toString(16)}`)

const untagged = encodeInputPacket(schema, entries, 0)
const untaggedDecoded = decodeInputPacket(schema, untagged)
expect('chartEpoch 0 packet decodes accepted', untaggedDecoded.accepted === true, JSON.stringify(untaggedDecoded.reason))
expect('chartEpoch 0 packet decodes chartEpoch 0', untaggedDecoded.chartEpoch === 0, `got ${untaggedDecoded.chartEpoch}`)
expect('chartEpoch 0 packet clears the epoch flag bit 0x80', (untagged[0] & 0x80) === 0, `byte0=0x${untagged[0].toString(16)}`)
expect('chartEpoch 0 packet keeps the newest 8 entries', untaggedDecoded.entries?.length === 8 && untaggedDecoded.entries[0].sequence === 102)

const refusals = [
  ['empty record count byte [0] is refused', new Uint8Array([0])],
  ['record count 9 (one above MAX_INPUTS_PER_PACKET) is refused', new Uint8Array([0x09, ...new Array(13).fill(0)])],
  ['valid packet with one appended trailing byte is refused', new Uint8Array([...untagged, 0xAB])],
  ['truncated chart epoch (flag set, 2 epoch bytes) is refused', new Uint8Array([0x80 | 1, 1, 2])],
  ['truncated record (count 1, header short) is refused', new Uint8Array([1, 0, 0])],
  ['flagged packet with count 0 is refused', new Uint8Array([0x80])],
  ['plain array instead of Uint8Array is refused', [1, 0, 0]],
]
for (const [claim, bytes] of refusals) {
  const r = decodeInputPacket(schema, bytes)
  expect(claim, r.accepted === false && typeof r.reason === 'string' && r.reason.length > 0, JSON.stringify(r))
}

function thrownOf(fn) {
  try {
    fn()
  } catch (err) {
    return `${err.constructor.name}: ${err.message}`
  }
  return 'no throw'
}
const encode = (data) => encodeInputPacket(schema, [{ sequence: 1, data }], 0)

expect('a NaN yaw is refused at the producer instead of encoding as yaw 0',
  thrownOf(() => encode({ yaw: NaN })),
  'RangeError: [InputCodec] input record field "yaw" is not a finite number (got number NaN)')
expect('an infinite pitch is refused at the producer instead of encoding as level',
  thrownOf(() => encode({ pitch: Infinity })),
  'RangeError: [InputCodec] input record field "pitch" is not a finite number (got number Infinity)')
expect('a NaN analog axis is refused at the producer instead of encoding as centred',
  thrownOf(() => encode({ analogForward: NaN })),
  'RangeError: [InputCodec] input record field "analogForward" is not a finite number (got number NaN)')
expect('a NaN extra axis is refused at the producer instead of encoding as 0.0f',
  thrownOf(() => encode({ throttle: NaN })),
  'RangeError: [InputCodec] input record field "throttle" is not a finite number (got number NaN)')
expect('a NaN expr is refused at the producer instead of encoding as expression 0',
  thrownOf(() => encode({ expr: NaN })),
  'RangeError: [InputCodec] input record field "expr" is not a finite number (got number NaN)')
expect('an omitted yaw is absent, not out of domain, and still encodes',
  decodeInputPacket(schema, encode({ forward: true })).accepted === true)
expect('an omitted extra axis is absent, not out of domain, and still encodes',
  decodeInputPacket(schema, encode({ yaw: 1.0 })).accepted === true)

console.log(failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures} claim(s))`)
process.exit(failures === 0 ? 0 : 1)
