import { pack, unpack } from './msgpack.js'

function toUint8(input) {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  return new Uint8Array(input)
}

export class Codec {
  constructor() {
    this.bytesSent = 0
    this.bytesReceived = 0
    this.messagesSent = 0
    this.messagesReceived = 0
    this.sendSequence = 0
  }

  encode(type, payload) {
    const seq = this.sendSequence++ & 0xFFFF
    const body = pack(payload)
    const bodyBytes = toUint8(body)
    const frame = new Uint8Array(3 + bodyBytes.length)
    frame[0] = type
    frame[1] = (seq >> 8) & 0xFF
    frame[2] = seq & 0xFF
    frame.set(bodyBytes, 3)
    this.bytesSent += frame.length
    this.messagesSent++
    return frame
  }

  decode(buffer) {
    const buf = toUint8(buffer)
    if (buf.length < 3) return null
    const type = buf[0]
    const seq = (buf[1] << 8) | buf[2]
    const payload = buf.length > 3 ? unpack(buf.slice(3)) : null
    this.bytesReceived += buf.length
    this.messagesReceived++
    return { type, seq, payload }
  }

  getStats() {
    return {
      bytesSent: this.bytesSent,
      bytesReceived: this.bytesReceived,
      messagesSent: this.messagesSent,
      messagesReceived: this.messagesReceived,
      sendSequence: this.sendSequence
    }
  }

  resetStats() {
    this.bytesSent = 0
    this.bytesReceived = 0
    this.messagesSent = 0
    this.messagesReceived = 0
  }
}
