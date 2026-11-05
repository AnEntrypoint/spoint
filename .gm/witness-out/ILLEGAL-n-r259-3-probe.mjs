import { defineComponentSchema, encodeCustomFields, decodeCustomFields } from '/workspace/spoint/src/protocol/ComponentSchema.js'
const schema = defineComponentSchema({ team: { type: 'enum', enum: ['red', 'blue'] } })
const res = {}
try { res.encodeOutOfEnum = encodeCustomFields(schema, { team: 'green' }).length === 2 ? 'silently-encoded' : 'encoded' } catch (e) { res.encodeOutOfEnum = 'threw: ' + e.message }
try { res.decodeOrdinal7 = decodeCustomFields(schema, Uint8Array.of(1, 7)) } catch (e) { res.decodeOrdinal7 = 'threw: ' + e.message }
console.log(JSON.stringify(res))
