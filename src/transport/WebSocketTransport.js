import { TransportWrapper } from './TransportWrapper.js'

const UNRELIABLE_BACKPRESSURE_DROP_THRESHOLD_BYTES = 64 * 1024

const CONNECTING = 'connecting'
const OPEN = 'open'
const CLOSED = 'closed'

export class WebSocketTransport extends TransportWrapper {
  constructor(socket) {
    super()
    this.type = 'websocket'
    this.socket = socket
    this._state = socket.readyState === 1 ? OPEN : CONNECTING
    Object.defineProperty(this, 'ready', { enumerable: false, configurable: true, get: () => this.isOpen })

    socket.on('message', (data) => {
      this.emit('message', data)
    })

    socket.on('close', () => {
      this.markClosed()
      this.emit('close')
    })

    socket.on('error', (err) => {
      this.emit('error', err)
    })

    if (socket.readyState !== 1) {
      socket.on('open', () => {
        if (this._state === CLOSED) return
        this.markOpened()
        this.emit('open')
      })
    }
  }

  get state() {
    if (this._state === CLOSED) return CLOSED
    if (this.socket.readyState === 1) return OPEN
    return this._state === OPEN ? CLOSED : CONNECTING
  }

  get isOpen() {
    return this.state === OPEN
  }

  markOpened() {
    this._state = OPEN
  }

  markClosed() {
    this._state = CLOSED
  }

  send(data) {
    if (!this.isOpen) return false
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
    this.markClosed()
    if (this.socket.readyState === 1) {
      this.socket.close()
    }
  }
}
