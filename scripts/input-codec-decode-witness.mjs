import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { tryEncodeInputPacket, decodeInputPacket, createInputSchema, DEFAULT_INPUT_SCHEMA, INPUT_CASE } = await import(pathToFileURL(path.join(ROOT, 'src/protocol/InputCodec.js')).href)

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const schema = DEFAULT_INPUT_SCHEMA
const rich = createInputSchema({ inputAxes: ['throttle'] })
const full = { sequence: 42, data: { forward: true, sprint: true, yaw: 1.5, pitch: -0.5, expr: 7, analogForward: 0.5, analogRight: -0.25, throttle: 0.75 } }
const encoded = tryEncodeInputPacket(rich, [full], 0)
check('a full record with analog and an extra axis encodes', encoded.accepted === true)

const decoded = decodeInputPacket(rich, encoded.bytes)
const d = decoded.accepted ? decoded.entries[0] : null
check('the round trip keeps the sequence', d !== null && d.sequence === 42, `sequence=${d && d.sequence}`)
check('the round trip keeps the buttons and expr', d !== null && d.data.forward === true && d.data.sprint === true && d.data.backward === false && d.data.expr === 7)
check('the round trip keeps yaw and pitch within one step', d !== null && Math.abs(d.data.yaw - 1.5) < 2 * Math.PI / 65536 && Math.abs(d.data.pitch + 0.5) < (Math.PI / 2) / 32767)
check('the round trip keeps analog axes within one 1/127 step', d !== null && Math.abs(d.data.analogForward - 0.5) <= 1 / 127 && Math.abs(d.data.analogRight + 0.25) <= 1 / 127)
check('the round trip keeps the extra axis as a float', d !== null && Math.abs(d.data.throttle - 0.75) < 1e-6)

const zeroCount = decodeInputPacket(schema, new Uint8Array([0]))
check('a count of 0 is refused with input_count_out_of_range', zeroCount.accepted === false && zeroCount.code === INPUT_CASE.COUNT)
const overCount = decodeInputPacket(schema, new Uint8Array([9, 0]))
check('a count of 9 is refused with input_count_out_of_range', overCount.accepted === false && overCount.code === INPUT_CASE.COUNT)

const plain = tryEncodeInputPacket(schema, [{ sequence: 1, data: { forward: true, yaw: 0, pitch: 0, expr: 0 } }], 0).bytes
const unknownFlag = Uint8Array.from(plain)
unknownFlag[1 + 13] = 0x02
check('a record with an undeclared flag bit is refused with input_flags_unknown_bits', decodeInputPacket(schema, unknownFlag).code === INPUT_CASE.FLAGS)

check('trailing bytes after the last record are refused with input_trailing_bytes', decodeInputPacket(schema, Uint8Array.from([...plain, 0])).code === INPUT_CASE.TRAILING)
check('a record cut inside its fixed header is refused with input_truncated_record', decodeInputPacket(schema, plain.slice(0, 10)).code === INPUT_CASE.TRUNCATED_RECORD)

const analogPlain = tryEncodeInputPacket(schema, [{ sequence: 1, data: { forward: true, yaw: 0, pitch: 0, expr: 0, analogForward: 1, analogRight: 0 } }], 0).bytes
check('a record flagged analog but cut before its analog bytes is refused with input_truncated_analog', decodeInputPacket(schema, analogPlain.slice(0, 1 + 14)).code === INPUT_CASE.TRUNCATED_ANALOG)
const axisPlain = tryEncodeInputPacket(rich, [{ sequence: 1, data: { throttle: 0.5, yaw: 0, pitch: 0, expr: 0 } }], 0).bytes
check('a record cut before its extra axis bytes is refused with input_truncated_axes', decodeInputPacket(rich, axisPlain.slice(0, axisPlain.length - 2)).code === INPUT_CASE.TRUNCATED_AXES)

const nanAxis = Uint8Array.from(axisPlain)
new DataView(nanAxis.buffer).setFloat32(1 + 14, NaN, true)
check('a non-finite extra axis in the bytes is refused with input_axis_not_finite', decodeInputPacket(rich, nanAxis).code === INPUT_CASE.AXIS)

const tagged = tryEncodeInputPacket(schema, [1, 2, 3].map((s) => ({ sequence: s, data: { yaw: 0, pitch: 0, expr: 0 } })), 77).bytes
const cutEpoch = Uint8Array.from([tagged[0], 0, 0])
check('an epoch-tagged packet shorter than its epoch is refused with input_truncated_epoch', decodeInputPacket(schema, cutEpoch).code === INPUT_CASE.TRUNCATED_EPOCH)
check('the epoch-tagged packet decodes all records and its epoch', decodeInputPacket(schema, tagged).chartEpoch === 77 && decodeInputPacket(schema, tagged).entries.length === 3)
check('dropAtOrBelow skips records at or below the acknowledged sequence', decodeInputPacket(schema, tagged, 2).entries.map((e) => e.sequence).join(',') === '3')

check('a non-binary payload is refused with input_payload_not_binary', decodeInputPacket(schema, [1, 0]).code === INPUT_CASE.PAYLOAD)
check('an empty payload is refused with input_payload_empty', decodeInputPacket(schema, new Uint8Array(0)).code === INPUT_CASE.PAYLOAD_EMPTY)

const failed = checks.filter((c) => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`)
  process.exit(1)
}
console.log('RESULT: PASS decodeInputPacket round-trips encoded records and refuses bad counts, unknown flags, truncation, trailing bytes, non-finite axes and non-binary payloads with a code')
process.exit(0)
