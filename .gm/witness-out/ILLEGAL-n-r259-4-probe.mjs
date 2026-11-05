import { defineComponentSchema, encodeCustomFields, decodeCustomFields } from '/workspace/spoint/src/protocol/ComponentSchema.js'
const schema = defineComponentSchema({ n: { type: 'u8' }, name: { type: 'string' } })
const good = encodeCustomFields(schema, { n: 5, name: 'abc' })
const res = {}
const attempt = (label, bytes) => { try { res[label] = { ok: true, value: decodeCustomFields(schema, bytes) } } catch (e) { res[label] = { ok: false, error: e.message } } }
attempt('valid', good)
attempt('presenceFlag7', Uint8Array.of(7, 5, 1, 0, 97))
attempt('truncatedString', good.subarray(0, good.length - 1))
attempt('trailingByte', Uint8Array.from([...good, 0]))
attempt('stringLenPastBuffer', Uint8Array.of(1, 5, 1, 9, 0, 97))
console.log(JSON.stringify(res))
