import { TransportWrapper } from './TransportWrapper.js'

const CONNECTING = 'connecting'
const OPEN = 'open'
const CLOSED = 'closed'

export class WebSocketClientTransport extends TransportWrapper {
  constructor(ws) {
    super()
    this.type = 'websocket'
    this.ws = ws
    this._state = ws.readyState === WebSocket.OPEN ? OPEN : CONNECTING
    Object.defineProperty(this, 'ready', { enumerable: false, configurable: true, get: () => this.isOpen })
    ws.addEventListener('message', (event) => this.emit('message', event.data))
    ws.addEventListener('close', () => { this.markClosed(); this.emit('close') })
    ws.addEventListener('error', (err) => this.emit('error', err))
    ws.addEventListener('open', () => {
      if (this._state !== CONNECTING) return
      this.markOpened()
      this.emit('open')
    })
  }

  get state() {
    return this._state
  }

  get isOpen() {
    return this._state === OPEN
  }

  markOpened() {
    this._state = OPEN
  }

  markClosed() {
    this._state = CLOSED
  }

  send(data) {
    if (!this.isOpen) return false
    try { this.ws.send(data); return true } catch (e) { return false }
  }

  close() {
    this.markClosed()
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      try { this.ws.close() } catch (e) {}
    }
  }
}
