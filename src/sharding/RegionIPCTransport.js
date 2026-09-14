import { TransportWrapper } from '../transport/TransportWrapper.js'

export class RegionIPCTransport extends TransportWrapper {
  constructor(playerId, sendToRouter) {
    super()
    this.type = 'region-ipc'
    this.playerId = playerId
    this._sendToRouter = sendToRouter
    this.ready = true
  }

  send(data) {
    if (!this.ready) return false
    const buf = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(Buffer.from(data))
    try {
      this._sendToRouter({ type: 'WORKER_FRAME', playerId: this.playerId, dataB64: Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('base64') })
      return true
    } catch (e) {
      return false
    }
  }

  close() {
    if (!this.ready) return
    this.ready = false
    this._sendToRouter({ type: 'CLIENT_CLOSE_FROM_WORKER', playerId: this.playerId })
    this.emit('close')
  }

  deliver(dataB64) {
    this.emit('message', Buffer.from(dataB64, 'base64'))
  }
}
