export const FIELD_TYPES = Object.freeze({
  u8: 'u8', u16: 'u16', i16: 'i16', f32: 'f32', f64: 'f64', bool: 'bool', string: 'string', enum: 'enum'
})

const MAX_ENUM_VALUES = 256
const MAX_STRING_BYTES = 65535
const VARIABLE_BYTE_SIZE = null

function fieldByteSize(field) {
  switch (field.type) {
    case 'u8': case 'bool': case 'enum': return 1
    case 'u16': case 'i16': return 2
    case 'f32': return 4
    case 'f64': return 8
    case 'string': return VARIABLE_BYTE_SIZE
    default: throw new TypeError('[ComponentSchema] unknown field type: ' + field.type)
  }
}

export function validateSchema(schema) {
  if (!schema || typeof schema !== 'object') throw new TypeError('[ComponentSchema] schema must be an object')
  for (const [name, field] of Object.entries(schema)) {
    if (!field || typeof field !== 'object') throw new TypeError(`[ComponentSchema] field "${name}" must be an object`)
    if (!Object.hasOwn(FIELD_TYPES, field.type)) throw new TypeError(`[ComponentSchema] field "${name}" has unknown type: ${field.type}`)
    if (field.type === 'enum') {
      if (!Array.isArray(field.enum) || field.enum.length === 0) throw new TypeError(`[ComponentSchema] enum field "${name}" needs a non-empty enum: string[]`)
      if (field.enum.length > MAX_ENUM_VALUES) throw new TypeError(`[ComponentSchema] enum field "${name}" exceeds ${MAX_ENUM_VALUES} values (1-byte index)`)
      const declared = new Set()
      for (const member of field.enum) {
        if (typeof member !== 'string' || member.length === 0) throw new TypeError(`[ComponentSchema] enum field "${name}" declares the member ${String(member)}, which no string value can encode to`)
        if (declared.has(member)) throw new TypeError(`[ComponentSchema] enum field "${name}" declares the member "${member}" twice`)
        declared.add(member)
      }
    }
    if (field.tier != null && field.tier !== 'full' && field.tier !== 'reduced') {
      throw new TypeError(`[ComponentSchema] field "${name}" tier must be 'full' or 'reduced'`)
    }
  }
  return schema
}

function _deepFreezeSchema(schema) {
  for (const field of Object.values(schema)) {
    if (field.type === 'enum') Object.freeze(field.enum)
    Object.freeze(field)
  }
  return Object.freeze(schema)
}

const _validatedSchemas = new WeakSet()

export function defineComponentSchema(schema) {
  validateSchema(schema)
  const frozen = _deepFreezeSchema(schema)
  _validatedSchemas.add(frozen)
  return frozen
}

function _requireValidatedSchema(schema) {
  if (_validatedSchemas.has(schema)) return schema
  validateSchema(schema)
  return schema
}

const _registry = new Map()
const _registryShape = new Map()

function _canonicalShape(schema) {
  const names = Object.keys(schema).sort()
  return JSON.stringify(names.map((name) => {
    const field = schema[name]
    const head = [name, field.type, field.tier ?? null]
    return field.type === 'enum' ? [...head, field.enum] : head
  }))
}

export function registerComponentSchema(name, schema) {
  if (!name || typeof name !== 'string') throw new TypeError('[ComponentSchema] registerComponentSchema: name must be a non-empty string')
  const frozen = defineComponentSchema(schema)
  const shape = _canonicalShape(frozen)
  const bound = _registryShape.get(name)
  if (bound !== undefined && bound !== shape) {
    throw new TypeError(`[ComponentSchema] registerComponentSchema: name "${name}" is already bound to a different schema shape`)
  }
  _registry.set(name, frozen)
  _registryShape.set(name, shape)
  return frozen
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
  _requireValidatedSchema(schema)
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
      off = _writeField(dv, off, field, name, obj[name])
    }
    return buf
  }

  const parts = []
  for (const name of names) {
    const field = schema[name]
    const present = obj != null && obj[name] !== undefined
    if (!present) { parts.push(new Uint8Array(1 + (field.type === 'string' ? 0 : fieldByteSize(field)))); continue }
    if (field.type === 'string') {
      const value = obj[name]
      if (typeof value !== 'string') throw new TypeError(`[ComponentSchema] field "${name}" of type string is ${typeof value}, not string`)
      const strBytes = encodeStringUtf8(value)
      if (strBytes.length > MAX_STRING_BYTES) throw new RangeError(`[ComponentSchema] field "${name}" encodes to ${strBytes.length} UTF-8 bytes, over the declared ${MAX_STRING_BYTES}`)
      const head = new Uint8Array(3)
      const hdv = new DataView(head.buffer)
      hdv.setUint8(0, 1)
      hdv.setUint16(1, strBytes.length, true)
      parts.push(head, strBytes)
    } else {
      const size = fieldByteSize(field)
      const chunk = new Uint8Array(1 + size)
      const dv = new DataView(chunk.buffer)
      dv.setUint8(0, 1)
      _writeField(dv, 1, field, name, obj[name])
      parts.push(chunk)
    }
  }
  let total = 0; for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

function _finite(name, value) {
  if (Number.isFinite(value)) return value
  throw new RangeError(`[ComponentSchema] field "${name}" is not a finite number (got ${typeof value} ${String(value)})`)
}

function _integerInRange(name, value, lo, hi) {
  const v = _finite(name, value)
  const rounded = Math.round(v)
  if (rounded < lo || rounded > hi) throw new RangeError(`[ComponentSchema] field "${name}" is ${v}, outside the declared ${lo}..${hi}`)
  return rounded
}

function _writeField(dv, off, field, name, value) {
  switch (field.type) {
    case 'u8': dv.setUint8(off, _integerInRange(name, value, 0, 255)); return off + 1
    case 'bool': {
      if (typeof value === 'string') throw new TypeError(`[ComponentSchema] field "${name}" of type bool is the string ${JSON.stringify(value)}, which is truthy and would encode as true`)
      dv.setUint8(off, value ? 1 : 0); return off + 1
    }
    case 'enum': {
      if (typeof value !== 'string') throw new RangeError(`[ComponentSchema] field "${name}" of type enum is ${typeof value} ${String(value)}, not one of [${field.enum.join(', ')}]`)
      const idx = field.enum.indexOf(value)
      if (idx < 0) throw new RangeError(`[ComponentSchema] field "${name}" of type enum is ${String(value)}, outside [${field.enum.join(', ')}]`)
      dv.setUint8(off, idx)
      return off + 1
    }
    case 'u16': dv.setUint16(off, _integerInRange(name, value, 0, 65535), true); return off + 2
    case 'i16': dv.setInt16(off, _integerInRange(name, value, -32768, 32767), true); return off + 2
    case 'f32': dv.setFloat32(off, _finite(name, value), true); return off + 4
    case 'f64': dv.setFloat64(off, _finite(name, value), true); return off + 8
    default: throw new TypeError('[ComponentSchema] unknown field type: ' + field.type)
  }
}

const PRESENCE_BYTES = 1
const STRING_LENGTH_BYTES = 2

function _refusal(bytes, off, need, what) {
  return new RangeError(`[ComponentSchema] ${what} needs ${need} byte(s) at offset ${off}, ${bytes.length - off} remain`)
}

function _asBytes(buf) {
  if (buf instanceof Uint8Array) return buf
  if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf)
  throw new TypeError(`[ComponentSchema] decodeCustomFields needs a Uint8Array or ArrayBuffer, got ${buf === null ? 'null' : typeof buf}`)
}

export function decodeCustomFields(schema, buf) {
  _requireValidatedSchema(schema)
  const names = Object.keys(schema)
  const bytes = _asBytes(buf)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = {}
  let off = 0
  for (const name of names) {
    const field = schema[name]
    if (off + PRESENCE_BYTES > bytes.length) throw _refusal(bytes, off, PRESENCE_BYTES, `presence byte of field "${name}"`)
    const flag = dv.getUint8(off); off += PRESENCE_BYTES
    if (flag !== 0 && flag !== 1) throw new RangeError(`[ComponentSchema] field "${name}" presence flag ${flag} is outside the declared 0 or 1`)
    if (flag === 0) { if (field.type !== 'string') off += fieldByteSize(field); continue }
    if (field.type === 'string') {
      if (off + STRING_LENGTH_BYTES > bytes.length) throw _refusal(bytes, off, STRING_LENGTH_BYTES, `string length of field "${name}"`)
      const len = dv.getUint16(off, true); off += STRING_LENGTH_BYTES
      if (off + len > bytes.length) throw new RangeError(`[ComponentSchema] field "${name}" declares ${len} string bytes, ${bytes.length - off} remain`)
      out[name] = decodeStringUtf8(bytes.subarray(off, off + len)); off += len
      continue
    }
    const size = fieldByteSize(field)
    if (off + size > bytes.length) throw _refusal(bytes, off, size, `field "${name}" of type ${field.type}`)
    out[name] = _readField(dv, off, field, name)
    off += size
  }
  if (off !== bytes.length) throw new RangeError(`[ComponentSchema] custom block has ${bytes.length - off} trailing bytes`)
  return out
}

function _readField(dv, off, field, name) {
  switch (field.type) {
    case 'u8': return dv.getUint8(off)
    case 'bool': {
      const b = dv.getUint8(off)
      if (b !== 0 && b !== 1) throw new RangeError(`[ComponentSchema] field "${name}" bool byte ${b} is outside the declared 0 or 1`)
      return b === 1
    }
    case 'enum': {
      const idx = dv.getUint8(off)
      if (idx >= field.enum.length) throw new RangeError(`[ComponentSchema] field "${name}" enum ordinal ${idx} is outside 0..${field.enum.length - 1}`)
      return field.enum[idx]
    }
    case 'u16': return dv.getUint16(off, true)
    case 'i16': return dv.getInt16(off, true)
    case 'f32': {
      const v = dv.getFloat32(off, true)
      if (!Number.isFinite(v)) throw new RangeError(`[ComponentSchema] field "${name}" is not a finite f32`)
      return v
    }
    case 'f64': {
      const v = dv.getFloat64(off, true)
      if (!Number.isFinite(v)) throw new RangeError(`[ComponentSchema] field "${name}" is not a finite f64`)
      return v
    }
    default: throw new TypeError('[ComponentSchema] unknown field type: ' + field.type)
  }
}

export default { defineComponentSchema, validateSchema, encodeCustomFields, decodeCustomFields, FIELD_TYPES }
