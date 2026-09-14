import { TransportWrapper } from './TransportWrapper.js'

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

export function isWebTransportSupported() {
  return typeof WebTransport === 'function'
}

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
