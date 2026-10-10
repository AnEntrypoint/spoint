import { TransportWrapper } from './TransportWrapper.js'

export class WebSocketClientTransport extends TransportWrapper {
  constructor(ws) {
    super()
    this.type = 'websocket'
    this.ws = ws
    this.ready = ws.readyState === WebSocket.OPEN
    this._closed = false
    ws.addEventListener('message', (event) => this.emit('message', event.data))
    ws.addEventListener('close', () => { this.ready = false; this.emit('close') })
    ws.addEventListener('error', (err) => { this.ready = false; this.emit('error', err) })
    if (!this.ready) {
      ws.addEventListener('open', () => { if (this._closed) return; this.ready = true; this.emit('open') })
    }
  }

  send(data) {
    if (this.ws.readyState !== WebSocket.OPEN) return false
    try { this.ws.send(data); return true } catch (e) { return false }
  }

  close() {
    this._closed = true
    super.close()
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      try { this.ws.close() } catch (e) {}
    }
  }
}
