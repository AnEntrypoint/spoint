import { TransportWrapper } from './TransportWrapper.js'

// Browser-side WebSocketTransport counterpart: WebSocketTransport.js's socket.on('message'/'close'/'error')
// calls are the Node `ws` package's EventEmitter API (used server-side against a real ws.WebSocketServer
// connection) -- the browser's native WebSocket exposes onmessage/onclose/onerror/onopen properties instead,
// not an EventEmitter, so that class cannot wrap a real browser WebSocket directly. This is the same
// TransportWrapper contract (send/sendUnreliable/isOpen/'message'/'close'/'error') adapted to the real
// browser API, existing ONLY so a plain WebSocket can be composed with a TransportWrapper-based decorator
// (NetworkSimTransport) the same way every other client transport already can -- PhysicsNetworkClient's
// raw `this.ws` fast path is untouched; this is opt-in, used only when a caller explicitly wants to wrap.
export class WebSocketClientTransport extends TransportWrapper {
  constructor(ws) {
    super()
    this.type = 'websocket'
    this.ws = ws
    this.ready = ws.readyState === WebSocket.OPEN
    ws.addEventListener('message', (event) => this.emit('message', event.data))
    ws.addEventListener('close', () => { this.ready = false; this.emit('close') })
    ws.addEventListener('error', (err) => this.emit('error', err))
    if (!this.ready) {
      // Emits a real 'open' event (not just flipping `ready`) so a decorator wrapping this transport
      // (NetworkSimTransport) can listen for the transition instead of polling isOpen -- a polling
      // approach using queueMicrotask starves the very macrotask (this WebSocket's own open callback)
      // it's waiting on, a real bug found live-witnessing this exact wrap against a real server.
      ws.addEventListener('open', () => { this.ready = true; this.emit('open') })
    }
  }

  get isOpen() {
    return this.ws.readyState === WebSocket.OPEN
  }

  send(data) {
    if (this.ws.readyState !== WebSocket.OPEN) return false
    try { this.ws.send(data); return true } catch (e) { return false }
  }

  close() {
    super.close()
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      try { this.ws.close() } catch (e) {}
    }
  }
}
