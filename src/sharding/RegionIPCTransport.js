import { TransportWrapper } from '../transport/TransportWrapper.js'
import { messageRefusal } from './ShardingRefusal.js'

function frameBytesOf(data) {
  if (typeof data === 'string') return Buffer.from(data)
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  throw new TypeError('[region-ipc] frame payload must be a string, an ArrayBuffer, a TypedArray or a DataView')
}

export class RegionIPCTransport extends TransportWrapper {
  constructor(playerId, sendToRouter) {
    super()
    this.type = 'region-ipc'
    this.playerId = playerId
    this._sendToRouter = sendToRouter
    this.ready = true
    this.lastRefusal = null
  }

  send(data) {
    if (!this.ready) {
      this.lastRefusal = messageRefusal('transport-closed', { playerId: this.playerId })
      return false
    }
    let buf
    try {
      buf = frameBytesOf(data)
    } catch (e) {
      this.lastRefusal = messageRefusal('frame-payload-not-binary', { playerId: this.playerId, error: e?.message ?? String(e) })
      throw e
    }
    try {
      this._sendToRouter({ type: 'WORKER_FRAME', playerId: this.playerId, dataB64: Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('base64') })
      this.lastRefusal = null
      return true
    } catch (e) {
      this.lastRefusal = messageRefusal('ipc-frame-send-failed', { playerId: this.playerId, error: e?.message ?? String(e) })
      return false
    }
  }

  close() {
    if (!this.ready) {
      this.lastRefusal = messageRefusal('transport-already-closed', { playerId: this.playerId })
      return false
    }
    this.ready = false
    let delivered = true
    try {
      this._sendToRouter({ type: 'CLIENT_CLOSE_FROM_WORKER', playerId: this.playerId })
      this.lastRefusal = null
    } catch (e) {
      this.lastRefusal = messageRefusal('ipc-close-send-failed', { playerId: this.playerId, error: e?.message ?? String(e) })
      delivered = false
    }
    this.emit('close')
    return delivered
  }

  deliver(dataB64) {
    this.emit('message', Buffer.from(dataB64, 'base64'))
  }
}
