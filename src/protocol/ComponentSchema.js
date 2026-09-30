export const FIELD_TYPES = Object.freeze({
  u8: 'u8', u16: 'u16', i16: 'i16', f32: 'f32', bool: 'bool', string: 'string', enum: 'enum'
})

const VARIABLE_BYTE_SIZE = null
function fieldByteSize(field) {
  switch (field.type) {
    case 'u8': case 'bool': case 'enum': return 1
    case 'u16': case 'i16': return 2
    case 'f32': return 4
    case 'string': return VARIABLE_BYTE_SIZE
    default: throw new TypeError('[ComponentSchema] unknown field type: ' + field.type)
  }
}

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

export function defineComponentSchema(schema) {
  validateSchema(schema)
  return Object.freeze(schema)
}

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
  return new Uint8Array(Buffer.from(s, 'utf8'))
}
function decodeStringUtf8(bytes) {
  if (_textDecoder) return _textDecoder.decode(bytes)
  return Buffer.from(bytes).toString('utf8')
}

export function encodeCustomFields(schema, obj) {
  const names = Object.keys(schema)
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
