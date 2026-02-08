const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function pack(value) {
  const chunks = []
  function write(value) {
    if (value === null || value === undefined) {
      chunks.push(0xc0)
    } else if (value === false) {
      chunks.push(0xc2)
    } else if (value === true) {
      chunks.push(0xc3)
    } else if (typeof value === 'number') {
      if (Number.isInteger(value)) {
        if (value >= 0) {
          if (value < 128) chunks.push(value)
          else if (value < 256) chunks.push(0xcc, value)
          else if (value < 65536) chunks.push(0xcd, value >> 8, value & 0xff)
          else if (value < 4294967296) chunks.push(0xce, (value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff)
          else writeFloat64(value)
        } else {
          if (value >= -32) chunks.push(value & 0xff)
          else if (value >= -128) chunks.push(0xd0, value & 0xff)
          else if (value >= -32768) chunks.push(0xd1, (value >> 8) & 0xff, value & 0xff)
          else if (value >= -2147483648) chunks.push(0xd2, (value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff)
          else writeFloat64(value)
        }
      } else {
        writeFloat64(value)
      }
    } else if (typeof value === 'string') {
      const bytes = encoder.encode(value)
      const len = bytes.length
      if (len < 32) chunks.push(0xa0 | len)
      else if (len < 256) chunks.push(0xd9, len)
      else if (len < 65536) chunks.push(0xda, len >> 8, len & 0xff)
      else chunks.push(0xdb, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff)
      for (let i = 0; i < len; i++) chunks.push(bytes[i])
    } else if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value
      const len = bytes.length
      if (len < 256) chunks.push(0xc4, len)
      else if (len < 65536) chunks.push(0xc5, len >> 8, len & 0xff)
      else chunks.push(0xc6, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff)
      for (let i = 0; i < len; i++) chunks.push(bytes[i])
    } else if (Array.isArray(value)) {
      const len = value.length
      if (len < 16) chunks.push(0x90 | len)
      else if (len < 65536) chunks.push(0xdc, len >> 8, len & 0xff)
      else chunks.push(0xdd, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff)
      for (let i = 0; i < len; i++) write(value[i])
    } else if (typeof value === 'object') {
      const keys = Object.keys(value)
      const len = keys.length
      if (len < 16) chunks.push(0x80 | len)
      else if (len < 65536) chunks.push(0xde, len >> 8, len & 0xff)
      else chunks.push(0xdf, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff)
      for (const key of keys) { write(key); write(value[key]) }
    }
  }
  function writeFloat64(value) {
    chunks.push(0xcb)
    const buf = new ArrayBuffer(8)
    new DataView(buf).setFloat64(0, value, false)
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < 8; i++) chunks.push(bytes[i])
  }
  write(value)
  return new Uint8Array(chunks)
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
  function readFloat32() { const buf = new ArrayBuffer(4); const view = new Uint8Array(buf); for (let i = 0; i < 4; i++) view[i] = bytes[offset++]; return new DataView(buf).getFloat32(0, false) }
  function readFloat64() { const buf = new ArrayBuffer(8); const view = new Uint8Array(buf); for (let i = 0; i < 8; i++) view[i] = bytes[offset++]; return new DataView(buf).getFloat64(0, false) }
  function readString(len) { const slice = bytes.subarray(offset, offset + len); offset += len; return decoder.decode(slice) }
  function readBin(len) { const slice = bytes.slice(offset, offset + len); offset += len; return slice }
  function readArray(len) { const arr = new Array(len); for (let i = 0; i < len; i++) arr[i] = read(); return arr }
  function readMap(len) { const obj = {}; for (let i = 0; i < len; i++) { const key = read(); obj[key] = read() } return obj }
  return read()
}
