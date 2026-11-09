import { EventEmitter } from 'node:events'

const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3
const servers = new Set()

function serverPort(httpServer) {
  const address = httpServer && typeof httpServer.address === 'function' ? httpServer.address() : null
  return address && typeof address === 'object' ? address.port : null
}

function copyPayload(data) {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0))
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
  throw new TypeError('[virtual-ws] send data must be a string, an ArrayBuffer or an ArrayBuffer view')
}

function clientData(payload, binaryType) {
  if (typeof payload === 'string') return payload
  if (binaryType === 'nodebuffer') return Buffer.from(payload)
  return payload.slice().buffer
}

class VirtualSocket extends EventEmitter {
  constructor(side) {
    super()
    this.side = side
    this.readyState = CONNECTING
    this.bufferedAmount = 0
    this.binaryType = side === 'server' ? 'nodebuffer' : 'arraybuffer'
    this.protocol = ''
    this.extensions = ''
    this.peer = null
    this.server = null
    this.domListeners = new Map()
    this.onopen = null
    this.onmessage = null
    this.onclose = null
    this.onerror = null
  }

  dispatch(type, nodeArgs, event) {
    if (type !== 'error' || this.listenerCount('error') > 0) this.emit(type, ...nodeArgs)
    if (this.side !== 'client') return
    const handler = this[`on${type}`]
    if (typeof handler === 'function') handler.call(this, event)
    for (const entry of [...(this.domListeners.get(type) || [])]) {
      if (entry.once) this.removeEventListener(type, entry.fn)
      entry.fn.call(this, event)
    }
  }

  addEventListener(type, fn, options) {
    if (typeof fn !== 'function') return
    const list = this.domListeners.get(type) || []
    list.push({ fn, once: !!(options && options.once) })
    this.domListeners.set(type, list)
  }

  removeEventListener(type, fn) {
    const list = this.domListeners.get(type)
    if (list) this.domListeners.set(type, list.filter(entry => entry.fn !== fn))
  }

  send(data) {
    if (this.readyState === CONNECTING) throw new Error('[virtual-ws] send before the socket is open')
    if (this.readyState !== OPEN) return
    const payload = copyPayload(data)
    const peer = this.peer
    setTimeout(() => peer._receive(payload), 0)
  }

  _receive(payload) {
    if (this.readyState !== OPEN) return
    if (this.side === 'server') {
      this.dispatch('message', [Buffer.from(payload), false], null)
      return
    }
    const data = clientData(payload, this.binaryType)
    this.dispatch('message', [data], { type: 'message', data, target: this })
  }

  close(code = 1000, reason = '') {
    if (this.readyState === CLOSING || this.readyState === CLOSED) return
    this.readyState = CLOSING
    setTimeout(() => this.finishClose(code, String(reason), true), 0)
  }

  terminate() {
    this.finishClose(1006, '', false)
  }

  ping() {}

  pong() {}

  finishClose(code, reason, clean) {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    if (this.server) this.server.clients.delete(this)
    const peer = this.peer
    this.dispatch('close', [code, Buffer.from(reason)], { type: 'close', code, reason, wasClean: clean, target: this })
    if (peer) peer.finishClose(code, reason, clean)
  }
}

export class WebSocket extends VirtualSocket {
  constructor(url) {
    super('client')
    this.url = String(url)
    setTimeout(() => this.connect(), 0)
  }

  connect() {
    if (this.readyState !== CONNECTING) return
    const url = new URL(this.url)
    const port = Number(url.port)
    const server = [...servers].find(candidate => !candidate._closed && serverPort(candidate.httpServer) === port)
    if (!server || (server.path && url.pathname !== server.path)) {
      this.refuse()
      return
    }
    const serverSide = new VirtualSocket('server')
    serverSide.server = server
    serverSide.peer = this
    serverSide.readyState = OPEN
    this.peer = serverSide
    this.readyState = OPEN
    server.clients.add(serverSide)
    server.emit('connection', serverSide, { url: url.pathname + url.search, headers: { host: url.host }, socket: { remoteAddress: '127.0.0.1' } })
    this.dispatch('open', [], { type: 'open', target: this })
  }

  refuse() {
    this.readyState = CLOSED
    this.dispatch('error', [new Error('[virtual-ws] connection refused')], { type: 'error', message: 'connection refused' })
    this.dispatch('close', [1006, Buffer.alloc(0)], { type: 'close', code: 1006, reason: '', wasClean: false })
  }
}

for (const [name, value] of Object.entries({ CONNECTING, OPEN, CLOSING, CLOSED })) {
  Object.defineProperty(WebSocket, name, { value, enumerable: true })
  Object.defineProperty(WebSocket.prototype, name, { value, enumerable: true })
}

export class WebSocketServer extends EventEmitter {
  constructor(options = {}) {
    super()
    this.path = options.path || null
    this.httpServer = options.server || null
    this.clients = new Set()
    this._closed = false
    servers.add(this)
  }

  address() {
    return this.httpServer && typeof this.httpServer.address === 'function' ? this.httpServer.address() : null
  }

  close(callback) {
    if (!this._closed) {
      this._closed = true
      servers.delete(this)
      for (const socket of [...this.clients]) socket.terminate()
    }
    if (typeof callback === 'function') setTimeout(callback, 0)
  }
}

WebSocket.Server = WebSocketServer

export default WebSocket
