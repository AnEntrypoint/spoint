import { TransportWrapper } from './TransportWrapper.js'

const UNRELIABLE_BACKPRESSURE_DROP_THRESHOLD_BYTES = 64 * 1024

export class WebSocketTransport extends TransportWrapper {
  constructor(socket) {
    super()
    this.type = 'websocket'
    this.socket = socket
    this._closed = false

    socket.on('message', (data) => {
      this.emit('message', data)
    })

    socket.on('close', () => {
      this.ready = false
      this.emit('close')
    })

    socket.on('error', (err) => {
      this.ready = false
      this.emit('error', err)
    })

    if (socket.readyState !== 1) {
      socket.on('open', () => {
        if (this._closed) return
        this.emit('open')
      })
    }
  }

  get ready() {
    return this._closed ? false : this.socket.readyState === 1
  }

  set ready(open) {
    if (!open && this.socket) this._closed = true
  }

  send(data) {
    if (this.socket.readyState !== 1) return false
    try {
      this.socket.send(data)
      return true
    } catch (e) {
      return false
    }
  }

  sendUnreliable(data) {
    if (this.socket.bufferedAmount > UNRELIABLE_BACKPRESSURE_DROP_THRESHOLD_BYTES) return false
    return this.send(data)
  }

  close() {
    super.close()
    if (this.socket.readyState === 1) {
      this.socket.close()
    }
  }
}
