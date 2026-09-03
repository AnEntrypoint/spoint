// ComponentSchema.js -- declarative replicated-component-field schemas + the generic byte-packing
// codec that drives them. This is the schema HALF of the ecs-app-layer-replicated-component-schemas
// roadmap item (see AGENTS.md/roadmap #79+#80): a component factory (defineHealth/defineTeams/
// definePlayerInventory in this directory) declares which of ITS state fields are worth replicating,
// as data -- {fieldName: {type, tier}} -- instead of SnapshotEncoder.js hand-writing a bespoke
// encode/decode branch per field. SnapshotEncoder.js's encodeCustomBySchema/decodeCustomBySchema
// consume a schema to pack/unpack a JS object's declared fields into/out of a compact byte buffer,
// generically, for ANY schema -- adding a new replicated field to health.js means adding one schema
// entry, not touching netcode code.
//
// Deliberately narrow field-type set (the common wire-worthy shapes seen across health/teams/
// inventory -- HP counters, team-slot indices, currency balances): u8/u16/i16/f32/bool/string.
// 'enum' is sugar over u8 with a declared string->index table (teamId, bodyType-shaped fields) so a
// schema author writes team ids as strings, not magic numbers, while the wire still carries 1 byte.
//
// tier is carried for future use by a caller wanting to skip low-priority fields at distance/rate
// (mirrors SnapshotEncoder.js's existing NEAR/MID/FAR distance-tier and PLAYER_LOD full/reduced/dot
// concepts) -- 'full' (always replicate) or 'reduced' (a caller MAY omit this field for a FAR/REDUCED
// -tier viewer). This pass does not yet wire tier-based omission into SnapshotEncoder's distance-tier
// logic (that composition is real follow-up scope, not required for the schema-format proof), but the
// field is part of the schema contract now so components declare it once, correctly, up front.
//
// A schema is a plain object: { [fieldName]: { type, tier?, enum?: string[] } }.
// Field iteration order is Object.keys() insertion order -- callers must declare fields in a STABLE
// order (object literals preserve string-key insertion order in JS) since the wire format has no
// per-field name tag, only positional bytes; reordering a shipped schema is a wire-breaking change,
// same caveat any fixed-layout binary format has (see SnapshotEncoder.js's own BIN_RECORD_BYTES).

export const FIELD_TYPES = Object.freeze({
  u8: 'u8', u16: 'u16', i16: 'i16', f32: 'f32', bool: 'bool', string: 'string', enum: 'enum'
})

// Byte cost of one field's payload (excluding the 1-byte presence bit the caller may add). 'string'
// has no fixed cost -- computed per-value at encode time (2-byte length prefix + UTF-8 bytes).
function fieldByteSize(field) {
  switch (field.type) {
    case 'u8': case 'bool': case 'enum': return 1
    case 'u16': case 'i16': return 2
    case 'f32': return 4
    case 'string': return null // variable
    default: throw new TypeError('[ComponentSchema] unknown field type: ' + field.type)
  }
}

// Validates a schema at definition time (fail fast: a malformed schema should throw when the
// component module loads, never silently corrupt the wire the first time an entity replicates).
export function validateSchema(schema) {
  if (!schema || typeof schema !== 'object') throw new TypeError('[ComponentSchema] schema must be an object')
  for (const [name, field] of Object.entries(schema)) {
    if (!field || typeof field !== 'object') throw new TypeError(`[ComponentSchema] field "${name}" must be an object`)
    if (!FIELD_TYPES[field.type]) throw new TypeError(`[ComponentSchema] field "${name}" has unknown type: ${field.type}`)
    if (field.type === 'enum') {
      if (!Array.isArray(field.enum) || field.enum.length === 0) throw new TypeError(`[ComponentSchema] enum field "${name}" needs a non-empty enum: string[]`)
      if (field.enum.length > 256) throw new TypeError(`[ComponentSchema] enum field "${name}" exceeds 256 values (1-byte index)`)
    }
    if (field.tier != null && field.tier !== 'full' && field.tier !== 'reduced') {
      throw new TypeError(`[ComponentSchema] field "${name}" tier must be 'full' or 'reduced'`)
    }
  }
  return schema
}

// Defines a schema (validates + freezes, the pattern every component below calls once at module load).
export function defineComponentSchema(schema) {
  validateSchema(schema)
  return Object.freeze(schema)
}

// --- Schema registry -------------------------------------------------------------------------------
// A named lookup table so SnapshotEncoder.js (or any other consumer) can resolve "the schema for
// custom.health" by NAME instead of importing every component module directly (avoids a netcode<->
// gameplay circular-import edge, and lets a world/app register its OWN custom schemas at runtime
// without editing SnapshotEncoder.js itself). Component modules register their static schema at
// import time (see health.js/inventory.js bottom-of-file registerComponentSchema calls); a per-instance
// schema (teams.js's buildTeamsSchema, which depends on the live team-id list) is registered by the
// calling app once it knows its concrete team list, via the same function.
const _registry = new Map()

export function registerComponentSchema(name, schema) {
  if (!name || typeof name !== 'string') throw new TypeError('[ComponentSchema] registerComponentSchema: name must be a non-empty string')
  validateSchema(schema)
  _registry.set(name, schema)
  return schema
}

export function getComponentSchema(name) { return _registry.get(name) || null }

export function hasComponentSchema(name) { return _registry.has(name) }

const _f32buf = new ArrayBuffer(4)
const _f32dv = new DataView(_f32buf)
const _textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null
const _textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null

function encodeStringUtf8(s) {
  if (_textEncoder) return _textEncoder.encode(s)
  // Node-without-TextEncoder fallback (older embedded contexts) -- Buffer is always present under Node.
  return new Uint8Array(Buffer.from(s, 'utf8'))
}
function decodeStringUtf8(bytes) {
  if (_textDecoder) return _textDecoder.decode(bytes)
  return Buffer.from(bytes).toString('utf8')
}

// Encodes `obj`'s schema-declared fields into a fresh Uint8Array. Layout: for each field in
// Object.keys(schema) order, ONE presence byte (0/1 -- distinguishes "field absent/undefined on obj"
// from "field present with a falsy/zero value", so a schema-driven record round-trips a partially
// -populated object faithfully, not just a fully-populated one) followed by the field's payload bytes
// (omitted entirely when the presence byte is 0). This is intentionally simpler than a real bitmask
// header (which SnapshotEncoder's own FIELD_* mask already does for its top-level fields) -- component
// schemas are typically 1-4 fields, so a per-field presence byte costs at most a few bytes and keeps
// the codec allocation-free and trivially self-describing without a separate mask-width computation.
export function encodeCustomFields(schema, obj) {
  const names = Object.keys(schema)
  // First pass: compute total byte length (avoids a growable-buffer or two-pass copy for the common
  // fixed-size-only case; only falls back to a dynamic parts list when a string field is present).
  let hasString = false
  for (const name of names) { if (schema[name].type === 'string') { hasString = true; break } }

  if (!hasString) {
    let total = 0
    for (const name of names) total += 1 + (fieldByteSize(schema[name]) || 0)
    const buf = new Uint8Array(total)
    const dv = new DataView(buf.buffer)
    let off = 0
    for (const name of names) {
      const field = schema[name]
      const present = obj != null && obj[name] !== undefined
      dv.setUint8(off, present ? 1 : 0); off += 1
      if (!present) { off += fieldByteSize(field); continue }
      off = _writeField(dv, off, field, obj[name])
    }
    return buf
  }

  // Variable-length (string-bearing) path: build parts then concat once.
  const parts = []
  for (const name of names) {
    const field = schema[name]
    const present = obj != null && obj[name] !== undefined
    if (!present) { parts.push(Uint8Array.of(0)); continue }
    if (field.type === 'string') {
      const strBytes = encodeStringUtf8(String(obj[name]))
      const head = new Uint8Array(3)
      const hdv = new DataView(head.buffer)
      hdv.setUint8(0, 1)
      hdv.setUint16(1, Math.min(65535, strBytes.length), true)
      parts.push(head, strBytes.subarray(0, Math.min(65535, strBytes.length)))
    } else {
      const size = fieldByteSize(field)
      const chunk = new Uint8Array(1 + size)
      const dv = new DataView(chunk.buffer)
      dv.setUint8(0, 1)
      _writeField(dv, 1, field, obj[name])
      parts.push(chunk)
    }
  }
  let total = 0; for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

function _writeField(dv, off, field, value) {
  switch (field.type) {
    case 'u8': dv.setUint8(off, Math.max(0, Math.min(255, Math.round(value))) & 0xFF); return off + 1
    case 'bool': dv.setUint8(off, value ? 1 : 0); return off + 1
    case 'enum': {
      const idx = field.enum.indexOf(String(value))
      dv.setUint8(off, idx >= 0 ? idx : 0)
      return off + 1
    }
    case 'u16': dv.setUint16(off, Math.max(0, Math.min(65535, Math.round(value))), true); return off + 2
    case 'i16': dv.setInt16(off, Math.max(-32768, Math.min(32767, Math.round(value))), true); return off + 2
    case 'f32': dv.setFloat32(off, value, true); return off + 4
    default: throw new TypeError('[ComponentSchema] unknown field type: ' + field.type)
  }
}

// Decodes a buffer produced by encodeCustomFields back into a plain object. Fields whose presence
// byte was 0 are omitted from the result entirely (matching the "undefined on the source object"
// case symmetrically -- never written as null/0, so a round-trip of a partial object stays partial).
export function decodeCustomFields(schema, buf) {
  const names = Object.keys(schema)
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = {}
  let off = 0
  for (const name of names) {
    const field = schema[name]
    const present = dv.getUint8(off) === 1; off += 1
    if (!present) { if (field.type !== 'string') off += fieldByteSize(field); continue }
    if (field.type === 'string') {
      const len = dv.getUint16(off, true); off += 2
      out[name] = decodeStringUtf8(bytes.subarray(off, off + len)); off += len
      continue
    }
    const size = fieldByteSize(field)
    out[name] = _readField(dv, off, field)
    off += size
  }
  return out
}

function _readField(dv, off, field) {
  switch (field.type) {
    case 'u8': return dv.getUint8(off)
    case 'bool': return dv.getUint8(off) === 1
    case 'enum': return field.enum[dv.getUint8(off)] ?? field.enum[0]
    case 'u16': return dv.getUint16(off, true)
    case 'i16': return dv.getInt16(off, true)
    case 'f32': return dv.getFloat32(off, true)
    default: throw new TypeError('[ComponentSchema] unknown field type: ' + field.type)
  }
}

export default { defineComponentSchema, validateSchema, encodeCustomFields, decodeCustomFields, FIELD_TYPES }
