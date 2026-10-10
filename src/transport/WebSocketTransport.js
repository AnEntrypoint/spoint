import { TransportWrapper } from './TransportWrapper.js'

const UNRELIABLE_BACKPRESSURE_DROP_THRESHOLD_BYTES = 64 * 1024

export class WebSocketTransport extends TransportWrapper {
  constructor(socket) {
    super()
    this.type = 'websocket'
    this.socket = socket
    this.ready = socket.readyState === 1
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

    if (!this.ready) {
      socket.on('open', () => {
        if (this._closed) return
        this.ready = true
        this.emit('open')
      })
    }
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
    this._closed = true
    super.close()
    if (this.socket.readyState === 1) {
      this.socket.close()
    }
  }
}
