const encoder = new TextEncoder()
const decoder = new TextDecoder()
const f64Buf = new ArrayBuffer(8)
const f64View = new DataView(f64Buf)
const f64Bytes = new Uint8Array(f64Buf)

let buf = new Uint8Array(4096)
let pos = 0

function grow(need) {
  if (pos + need <= buf.length) return
  let size = buf.length
  while (size < pos + need) size *= 2
  const next = new Uint8Array(size)
  next.set(buf.subarray(0, pos))
  buf = next
}

function w1(v) { grow(1); buf[pos++] = v }
function w2(a, b) { grow(2); buf[pos++] = a; buf[pos++] = b }
function w3(a, b, c) { grow(3); buf[pos++] = a; buf[pos++] = b; buf[pos++] = c }
function w5(a, b, c, d, e) { grow(5); buf[pos++] = a; buf[pos++] = b; buf[pos++] = c; buf[pos++] = d; buf[pos++] = e }

function writeFloat64(value) {
  grow(9)
  buf[pos++] = 0xcb
  f64View.setFloat64(0, value, false)
  buf[pos++] = f64Bytes[0]; buf[pos++] = f64Bytes[1]; buf[pos++] = f64Bytes[2]; buf[pos++] = f64Bytes[3]
  buf[pos++] = f64Bytes[4]; buf[pos++] = f64Bytes[5]; buf[pos++] = f64Bytes[6]; buf[pos++] = f64Bytes[7]
}

function write(value) {
  if (value === null || value === undefined) {
    w1(0xc0)
  } else if (value === false) {
    w1(0xc2)
  } else if (value === true) {
    w1(0xc3)
  } else if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      if (value >= 0) {
        if (value < 128) w1(value)
        else if (value < 256) w2(0xcc, value)
        else if (value < 65536) w3(0xcd, value >> 8, value & 0xff)
        else if (value < 4294967296) w5(0xce, (value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff)
        else writeFloat64(value)
      } else {
        if (value >= -32) w1(value & 0xff)
        else if (value >= -128) w2(0xd0, value & 0xff)
        else if (value >= -32768) w3(0xd1, (value >> 8) & 0xff, value & 0xff)
        else if (value >= -2147483648) w5(0xd2, (value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff)
        else writeFloat64(value)
      }
    } else {
      writeFloat64(value)
    }
  } else if (typeof value === 'string') {
    const bytes = encoder.encode(value)
    const len = bytes.length
    if (len < 32) w1(0xa0 | len)
    else if (len < 256) w2(0xd9, len)
    else if (len < 65536) w3(0xda, len >> 8, len & 0xff)
    else w5(0xdb, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff)
    grow(len)
    buf.set(bytes, pos)
    pos += len
  } else if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value
    const len = bytes.length
    if (len < 256) w2(0xc4, len)
    else if (len < 65536) w3(0xc5, len >> 8, len & 0xff)
    else w5(0xc6, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff)
    grow(len)
    buf.set(bytes, pos)
    pos += len
  } else if (Array.isArray(value)) {
    const len = value.length
    if (len < 16) w1(0x90 | len)
    else if (len < 65536) w3(0xdc, len >> 8, len & 0xff)
    else w5(0xdd, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff)
    for (let i = 0; i < len; i++) write(value[i])
  } else if (typeof value === 'object') {
    const keys = Object.keys(value)
    const len = keys.length
    if (len < 16) w1(0x80 | len)
    else if (len < 65536) w3(0xde, len >> 8, len & 0xff)
    else w5(0xdf, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff)
    for (const key of keys) { write(key); write(value[key]) }
  }
}

export function pack(value) {
  pos = 0
  write(value)
  return buf.slice(0, pos)
}

export function unpack(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  let offset = 0
  function read() {
    const byte = bytes[offset++]
    if (byte < 0x80) return byte
    if ((byte & 0xf0) === 0x80) return readMap(byte & 0x0f)
    if ((byte & 0xf0) === 0x90) return readArray(byte & 0x0f)
    if ((byte & 0xe0) === 0xa0) return readString(byte & 0x1f)
    if (byte >= 0xe0) return byte - 256
    switch (byte) {
      case 0xc0: return null
      case 0xc2: return false
      case 0xc3: return true
      case 0xc4: return readBin(bytes[offset++])
      case 0xc5: return readBin(readUint16())
      case 0xc6: return readBin(readUint32())
      case 0xca: return readFloat32()
      case 0xcb: return readFloat64()
      case 0xcc: return bytes[offset++]
      case 0xcd: return readUint16()
      case 0xce: return readUint32()
      case 0xd0: return readInt8()
      case 0xd1: return readInt16()
      case 0xd2: return readInt32()
      case 0xd9: return readString(bytes[offset++])
      case 0xda: return readString(readUint16())
      case 0xdb: return readString(readUint32())
      case 0xdc: return readArray(readUint16())
      case 0xdd: return readArray(readUint32())
      case 0xde: return readMap(readUint16())
      case 0xdf: return readMap(readUint32())
      default: throw new Error(`Unknown msgpack type: 0x${byte.toString(16)}`)
    }
  }
  function readUint16() { const v = (bytes[offset] << 8) | bytes[offset + 1]; offset += 2; return v }
  function readUint32() { const v = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]; offset += 4; return v >>> 0 }
  function readInt8() { const v = bytes[offset++]; return v > 127 ? v - 256 : v }
  function readInt16() { const v = (bytes[offset] << 8) | bytes[offset + 1]; offset += 2; return v > 32767 ? v - 65536 : v }
  function readInt32() { const v = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]; offset += 4; return v }
  function readFloat32() { const b = new ArrayBuffer(4); const v = new Uint8Array(b); for (let i = 0; i < 4; i++) v[i] = bytes[offset++]; return new DataView(b).getFloat32(0, false) }
  function readFloat64() { const b = new ArrayBuffer(8); const v = new Uint8Array(b); for (let i = 0; i < 8; i++) v[i] = bytes[offset++]; return new DataView(b).getFloat64(0, false) }
  function readString(len) { const slice = bytes.subarray(offset, offset + len); offset += len; return decoder.decode(slice) }
  function readBin(len) { const slice = bytes.slice(offset, offset + len); offset += len; return slice }
  function readArray(len) { const arr = new Array(len); for (let i = 0; i < len; i++) arr[i] = read(); return arr }
  function readMap(len) { const obj = {}; for (let i = 0; i < len; i++) { const key = read(); obj[key] = read() } return obj }
  return read()
}
