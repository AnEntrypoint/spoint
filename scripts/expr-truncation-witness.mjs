import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { quantizeInput, tryEncodeInputPacket, decodeInputPacket, DEFAULT_INPUT_SCHEMA, INPUT_CASE } = await import(pathToFileURL(path.join(ROOT, 'src/protocol/InputCodec.js')).href)

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const schema = DEFAULT_INPUT_SCHEMA
const quant = (expr) => {
  const cases = []
  const data = quantizeInput(schema, { forward: true, yaw: 0, pitch: 0, expr }, cases)
  return { expr: data.expr, cases }
}

for (const [input, want] of [[3.7, 3], [3.2, 3], [254.9, 254], [0, 0], [255, 255]]) {
  const got = quant(input)
  check(`expr ${input} is truncated to ${want}, not rounded, and reports nothing`, got.expr === want && got.cases.length === 0, `expr=${got.expr} cases=${got.cases.length}`)
}

for (const [input, want] of [[255.4, 255], [-0.4, 0]]) {
  const got = quant(input)
  check(`expr ${input} is clamped to ${want} and reported with input_field_clamped`, got.expr === want && got.cases.some((c) => c.code === INPUT_CASE.CLAMPED && c.field === 'expr'), `expr=${got.expr} codes=${got.cases.map((c) => c.code).join(',')}`)
}

const packet = tryEncodeInputPacket(schema, [{ sequence: 1, data: { forward: true, yaw: 0, pitch: 0, expr: 3.7 } }], 0)
const decoded = packet.accepted ? decodeInputPacket(schema, packet.bytes) : null
const wireExpr = decoded && decoded.accepted ? decoded.entries[0].data.expr : null
check('the wire carries the truncated expr: 3.7 encodes and decodes as 3', wireExpr === 3, `wire expr=${wireExpr}`)

const failed = checks.filter((c) => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`)
  process.exit(1)
}
console.log('RESULT: PASS quantizeInput truncates expr (3.7 -> 3, 254.9 -> 254) without reporting it, clamps out-of-range expr with input_field_clamped, and the wire carries the truncated value')
process.exit(0)
