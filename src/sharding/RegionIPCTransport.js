import { TransportWrapper } from '../transport/TransportWrapper.js'
import { messageRefusal } from './ShardingRefusal.js'

function frameBytesOf(data) {
  if (typeof data === 'string') return Buffer.from(data)
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  throw new TypeError('[region-ipc] frame payload must be a string, an ArrayBuffer, a TypedArray or a DataView')
}

export class RegionIPCTransport extends TransportWrapper {
  constructor(routerPlayerId, sendToRouter) {
    super()
    this.type = 'region-ipc'
    this.routerPlayerId = routerPlayerId
    this._sendToRouter = sendToRouter
    this.ready = true
    this.lastRefusal = null
  }

  send(data) {
    if (!this.ready) {
      this.lastRefusal = messageRefusal('transport-closed', { routerPlayerId: this.routerPlayerId })
      return false
    }
    let buf
    try {
      buf = frameBytesOf(data)
    } catch (e) {
      this.lastRefusal = messageRefusal('frame-payload-not-binary', { routerPlayerId: this.routerPlayerId, error: e?.message ?? String(e) })
      throw e
    }
    try {
      this._sendToRouter({ type: 'WORKER_FRAME', routerPlayerId: this.routerPlayerId, dataB64: Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('base64') })
      this.lastRefusal = null
      return true
    } catch (e) {
      this.lastRefusal = messageRefusal('ipc-frame-send-failed', { routerPlayerId: this.routerPlayerId, error: e?.message ?? String(e) })
      return false
    }
  }

  close() {
    if (!this.ready) {
      this.lastRefusal = messageRefusal('transport-already-closed', { routerPlayerId: this.routerPlayerId })
      return false
    }
    this.ready = false
    let delivered = true
    try {
      this._sendToRouter({ type: 'CLIENT_CLOSE_FROM_WORKER', routerPlayerId: this.routerPlayerId })
      this.lastRefusal = null
    } catch (e) {
      this.lastRefusal = messageRefusal('ipc-close-send-failed', { routerPlayerId: this.routerPlayerId, error: e?.message ?? String(e) })
      delivered = false
    }
    this.emit('close')
    return delivered
  }

  deliver(dataB64) {
    this.emit('message', Buffer.from(dataB64, 'base64'))
  }
}
