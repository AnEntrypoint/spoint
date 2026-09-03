import { TransportWrapper } from './TransportWrapper.js'

// Browser-side counterpart to server WebTransportTransport.js: wraps a connected `WebTransport` session
// (the real browser API, `new WebTransport(url)`) into the same TransportWrapper interface every other
// client transport uses -- reliable ordered messages via a single bidirectional stream (mirrors the
// server's one-stream-per-session convention in WebTransportServer.js/_acceptSessions), unreliable
// best-effort messages via datagrams. `send()`/`sendUnreliable()` semantics match WebSocketTransport.js's
// contract so PhysicsNetworkClient can swap between the two without any call-site branching.
export class WebTransportClientTransport extends TransportWrapper {
  constructor(session) {
    super()
    this.type = 'webtransport'
    this.session = session
    this.ready = false
    this.reliableWriter = null
    this.reliableReader = null
    this._closed = false
  }

  // Real async setup: negotiate the session, open the bidirectional stream, start read loops. Callers
  // must await connect() (or race it) before relying on isOpen -- mirrors WebTransportTransport.js's
  // constructor-driven _init but exposed as an explicit method since the client also needs to await
  // `session.ready` itself (server sessions are already-accepted; client sessions are not).
  async connect() {
    try {
      await this.session.ready
      const stream = await this.session.createBidirectionalStream()
      this.reliableWriter = stream.writable.getWriter()
      this.reliableReader = stream.readable.getReader()
      this._readReliableStream()
      this._readDatagrams()
      this._watchClosed()
      if (!this._closed) { this.ready = true; this.emit('open') }
      return true
    } catch (e) {
      this._handleClose()
      return false
    }
  }

  async _readReliableStream() {
    try {
      while (!this._closed) {
        const { value, done } = await this.reliableReader.read()
        if (done) break
        if (value) this.emit('message', value)
      }
    } catch (e) {
      if (!this._closed) this._handleClose()
    }
  }

  async _readDatagrams() {
    try {
      const reader = this.session.datagrams.readable.getReader()
      while (!this._closed) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) this.emit('message', value)
      }
    } catch (e) {
      if (!this._closed) this._handleClose()
    }
  }

  async _watchClosed() {
    try {
      await this.session.closed
      this._handleClose()
    } catch (e) {
      this._handleClose()
    }
  }

  _handleClose() {
    if (this._closed) return
    this._closed = true
    this.ready = false
    this.emit('close')
  }

  get isOpen() {
    return this.ready && !this._closed
  }

  send(data) {
    if (!this.isOpen || !this.reliableWriter) return false
    try {
      this.reliableWriter.write(data).catch(() => { if (!this._closed) this._handleClose() })
      return true
    } catch (e) {
      return false
    }
  }

  sendUnreliable(data) {
    if (!this.isOpen) return false
    try {
      const writer = this.session.datagrams.writable.getWriter()
      writer.write(data).then(() => writer.releaseLock(), () => { try { writer.releaseLock() } catch (_) {} })
      return true
    } catch (e) {
      return this.send(data)
    }
  }

  close() {
    super.close()
    this._closed = true
    try { this.session.close() } catch (e) {}
  }
}

// Real browser feature-detection -- never assumed. `WebTransport` is a global constructor only present
// in Chromium-family browsers with HTTP/3 support; Firefox/Safari (as of this writing) and every Node/
// Worker-without-DOM environment lack it entirely, so `typeof WebTransport === 'function'` is the actual
// support signal (matches how `typeof WebSocket` is already checked implicitly by PhysicsNetworkClient's
// existing `new WebSocket(url)` call).
export function isWebTransportSupported() {
  return typeof WebTransport === 'function'
}

// Derives a WebTransport URL from the existing ws(s):// URL config, on the assumption a WebTransport
// listener (WebTransportServer.js) shares the deployment's host but a distinct port (matches
// ServerAPI.js's `ctx.config.webTransport.port`, default 4433) -- WebTransport requires HTTPS, so ws://
// maps to https:// (dev) and wss:// maps to https:// (prod, same scheme either way since WebTransport has
// no unencrypted variant).
export function deriveWebTransportUrl(wsUrl, port) {
  try {
    const u = new URL(wsUrl)
    const host = u.hostname
    const wtPort = port || 4433
    return `https://${host}:${wtPort}/`
  } catch (e) {
    return null
  }
}
