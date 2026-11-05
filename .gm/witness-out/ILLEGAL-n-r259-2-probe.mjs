import { tryEncodeInputPacket, encodeInputPacket, decodeInputPacket, DEFAULT_INPUT_SCHEMA, INPUT_CASE } from '/workspace/spoint/src/protocol/InputCodec.js'
const entries = Array.from({ length: 10 }, (_, i) => ({ sequence: i + 1, data: { yaw: 0, pitch: 0, forward: true } }))
const r = tryEncodeInputPacket(DEFAULT_INPUT_SCHEMA, entries, 0)
const legacyWarn = []
const orig = console.warn
console.warn = (m) => legacyWarn.push(String(m))
const legacyBytes = encodeInputPacket(DEFAULT_INPUT_SCHEMA, entries, 0)
console.warn = orig
const dec = decodeInputPacket(DEFAULT_INPUT_SCHEMA, legacyBytes)
console.log(JSON.stringify({
  tryAccepted: r.accepted, tryCount: r.count, tryDropped: r.dropped,
  tryCaseCodes: r.cases.map(c => c.code), droppedCodeIs: INPUT_CASE.DROPPED,
  legacyWarnings: legacyWarn,
  keptSequences: dec.entries.map(e => e.sequence)
}))
