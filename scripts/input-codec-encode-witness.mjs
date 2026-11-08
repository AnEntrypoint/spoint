import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { tryEncodeInputPacket, encodeInputPacket, decodeInputPacket, DEFAULT_INPUT_SCHEMA, INPUT_CASE } = await import(pathToFileURL(path.join(ROOT, 'src/protocol/InputCodec.js')).href)

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const schema = DEFAULT_INPUT_SCHEMA
const record = (seq, data = {}) => ({ sequence: seq, data: { forward: true, yaw: 0.25, pitch: 0.1, expr: 1, ...data } })
const ten = Array.from({ length: 10 }, (_, i) => record(100 + i))

const packet = tryEncodeInputPacket(schema, ten, 0)
check('ten records encode as an accepted packet', packet.accepted === true && packet.code === INPUT_CASE.ACCEPTED, `code=${packet.code}`)
check('the packet carries the newest 8 of 10 records', packet.count === 8 && packet.dropped === 2, `count=${packet.count} dropped=${packet.dropped}`)
const dropped = packet.cases.find((c) => c.code === INPUT_CASE.DROPPED)
check('the 2 oldest drops are reported with input_records_dropped', dropped !== undefined && dropped.dropped === 2 && dropped.kept === 8 && dropped.got === 10, JSON.stringify(dropped ? { dropped: dropped.dropped, kept: dropped.kept, got: dropped.got } : null))
check('the drop reason names the count and the dropped records', dropped !== undefined && /were not sent/.test(dropped.reason) && dropped.reason.startsWith('[InputCodec] '), dropped ? dropped.reason : 'none')

const decoded = decodeInputPacket(schema, packet.bytes)
const seqs = decoded.accepted ? decoded.entries.map((e) => e.sequence) : []
check('the decoded sequences are the newest 8, oldest first: 102..109', seqs.join(',') === '102,103,104,105,106,107,108,109', seqs.join(','))
check('the packet is 1 count byte plus 8 fixed-size records', packet.bytes.length === 1 + 8 * 14, `bytes=${packet.bytes.length}`)

const exact = tryEncodeInputPacket(schema, ten.slice(0, 8), 0)
check('eight records encode without a drop', exact.accepted && exact.dropped === 0 && !exact.cases.some((c) => c.code === INPUT_CASE.DROPPED))

const tagged = tryEncodeInputPacket(schema, ten.slice(0, 3), 9)
check('a positive chart epoch sets the epoch flag and a 4-byte epoch', tagged.accepted && (tagged.bytes[0] & 0x80) !== 0 && tagged.bytes.length === 1 + 4 + 3 * 14, `header=0x${tagged.bytes[0].toString(16)} bytes=${tagged.bytes.length}`)
check('the tagged epoch decodes back', decodeInputPacket(schema, tagged.bytes).chartEpoch === 9)

const nanPitch = tryEncodeInputPacket(schema, [record(1, { pitch: NaN })], 0)
check('a non-finite field refuses the packet with input_field_not_finite', nanPitch.accepted === false && nanPitch.code === INPUT_CASE.FIELD && nanPitch.bytes === undefined, `code=${nanPitch.code}`)
const infYaw = tryEncodeInputPacket(schema, [record(1, { yaw: Infinity })], 0)
check('an infinite yaw is refused the same way', infYaw.accepted === false && infYaw.code === INPUT_CASE.FIELD)

check('an empty entries array is refused with input_entries_empty', tryEncodeInputPacket(schema, [], 0).code === INPUT_CASE.ENTRIES_EMPTY)
check('a non-array entries value is refused with input_entries_not_array', tryEncodeInputPacket(schema, 'x', 0).code === INPUT_CASE.ENTRIES)
check('a negative sequence is refused with input_sequence_out_of_domain', tryEncodeInputPacket(schema, [{ sequence: -1, data: {} }], 0).code === INPUT_CASE.SEQUENCE)
check('an epoch past uint32 is refused with input_epoch_out_of_domain', tryEncodeInputPacket(schema, [record(1)], 2 ** 32).code === INPUT_CASE.EPOCH)

let threw = null
try { encodeInputPacket(schema, [record(1, { pitch: NaN })], 0) } catch (e) { threw = e }
check('the throwing encode raises a RangeError carrying the reason', threw instanceof RangeError && /input record field "pitch"/.test(threw.message), threw ? threw.message : 'no throw')

const failed = checks.filter((c) => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`)
  process.exit(1)
}
console.log('RESULT: PASS tryEncodeInputPacket keeps the newest 8 of 10 records, reports the 2 dropped, refuses non-finite and out-of-domain input with a code, and tags the chart epoch')
process.exit(0)
