import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MODULE = process.env.INPUT_CODEC_MODULE
  ? resolve(process.env.INPUT_CODEC_MODULE)
  : resolve(REPO, 'src/protocol/InputCodec.js')
const { createInputSchema, encodeInputPacket, decodeInputPacket, quantizeInput, tryEncodeInputPacket } = await import(pathToFileURL(MODULE).href)

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

const CEILING = 4294967296
const tryEncode = (entries, epoch = 0) => tryEncodeInputPacket(schema, entries, epoch)
const refused = (r) => r.accepted === false && typeof r.reason === 'string' && r.reason.length > 0

const nanSeq = tryEncode([{ sequence: NaN, data: { yaw: 1.0 } }])
expect('a NaN sequence is refused instead of re-keyed to 0 where it collides with genuine sequence 0',
  refused(nanSeq), JSON.stringify(nanSeq))
const genuineZero = tryEncode([{ sequence: 0, data: { yaw: 1.0 } }])
expect('genuine sequence 0 still encodes while NaN sequence is refused',
  genuineZero.accepted === true && nanSeq.accepted === false)
for (const [claim, seq] of [
  ['a negative sequence is refused instead of wrapping to 4294967295', -1],
  ['a fractional sequence is refused instead of re-keyed by >>> 0', 1.5],
  ['a sequence at the uint32 ceiling is refused instead of wrapping to 0', CEILING],
  ['a string sequence is refused instead of re-keyed to 0', '7'],
  ['an undefined sequence is refused instead of re-keyed to 0', undefined],
]) expect(claim, refused(tryEncode([{ sequence: seq, data: {} }])), JSON.stringify(tryEncode([{ sequence: seq, data: {} }])))
for (const [claim, epoch] of [
  ['a NaN chartEpoch is refused instead of silently untagging the packet', NaN],
  ['a negative chartEpoch is refused instead of silently untagging the packet', -1],
  ['a fractional chartEpoch is refused instead of silently truncating the tag', 2.5],
  ['a chartEpoch at the uint32 ceiling is refused instead of wrapping to 0', CEILING],
]) expect(claim, refused(tryEncode([{ sequence: 1, data: {} }], epoch)), JSON.stringify(tryEncode([{ sequence: 1, data: {} }], epoch)))
expect('entries that are not an array are refused', refused(tryEncode(null)), JSON.stringify(tryEncode(null)))
expect('an empty entries array is refused instead of encoding a count byte of 0', refused(tryEncode([])), JSON.stringify(tryEncode([])))
expect('a record with no data object is refused', refused(tryEncode([{ sequence: 1 }])), JSON.stringify(tryEncode([{ sequence: 1 }])))
expect('a non-finite field is refused by the total entry without throwing',
  refused(tryEncode([{ sequence: 1, data: { yaw: NaN } }])), JSON.stringify(tryEncode([{ sequence: 1, data: { yaw: NaN } }])))

const many = tryEncode(entries, EPOCH)
expect('a 10-entry packet reports 2 dropped records instead of dropping them silently',
  many.accepted === true && many.count === 8 && many.dropped === 2, JSON.stringify({ count: many.count, dropped: many.dropped }))
expect('the total entry and the legacy entry emit byte-identical packets',
  many.accepted === true && Buffer.from(many.bytes).equals(Buffer.from(tagged)))

const outOfRange = tryEncode([{ sequence: 1, data: { pitch: 2.0, analogForward: 4, analogRight: -4, expr: 300 } }])
expect('an out-of-range pitch, analog pair and expr are reported as clamped, not clamped silently',
  outOfRange.accepted === true && isDeepStrictEqual(outOfRange.clamped, ['pitch', 'expr', 'analogForward', 'analogRight']),
  JSON.stringify(outOfRange.clamped))
const inRange = tryEncode([{ sequence: 1, data: { pitch: -0.5, analogForward: 0.5, analogRight: -0.5, expr: 40 } }])
expect('in-domain pitch, analog and expr report no clamps', inRange.accepted === true && inRange.clamped.length === 0, JSON.stringify(inRange.clamped))
const qClamped = []
quantizeInput(schema, { pitch: 2.0, analogForward: 4 }, qClamped)
expect('quantizeInput reports the fields it clamps instead of clamping them silently',
  isDeepStrictEqual(qClamped, ['pitch', 'analogForward']), JSON.stringify(qClamped))
const clampedPitch = decodeInputPacket(schema, outOfRange.bytes)
expect('a clamped record decodes to exactly the quantization of its own input, so the clamp is the only loss',
  clampedPitch.accepted === true && isDeepStrictEqual(clampedPitch.entries[0].data, quantizeInput(schema, { pitch: 2.0, analogForward: 4, analogRight: -4, expr: 300 })),
  JSON.stringify(clampedPitch.entries?.[0]?.data))

expect('the legacy entry turns every refusal into a loud RangeError, never a silent packet',
  thrownOf(() => encodeInputPacket(schema, [{ sequence: NaN, data: {} }])),
  'RangeError: [InputCodec] input packet record 0 sequence NaN outside 0..4294967295')
expect('the legacy entry still returns the bytes for an accepted packet',
  encodeInputPacket(schema, [{ sequence: 1, data: { yaw: 1.0 } }]) instanceof Uint8Array)

console.log(failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures} claim(s))`)
process.exit(failures === 0 ? 0 : 1)
