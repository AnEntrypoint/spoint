import { TransportWrapper } from './TransportWrapper.js'

export class WebTransportTransport extends TransportWrapper {
  constructor(session) {
    super()
    this.type = 'webtransport'
    this.session = session
    // stays false until _init wires up the stream/datagram reader; a send could race reliableWriter=null otherwise
    this.ready = false
    this.reliableWriter = null
    this.reliableReader = null
    this._closed = false
    this._init()
  }

  async _init() {
    try {
      await this._setupReliableStream()
      this._readDatagrams()
      if (!this._closed) this.ready = true
    } catch (e) {
      this._handleClose()
    }
  }

  async _setupReliableStream() {
    const stream = await this.session.createBidirectionalStream()
    this.reliableWriter = stream.writable.getWriter()
    this.reliableReader = stream.readable.getReader()
    this._readReliableStream()
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
      // write() rejects if the stream died mid-flight; mark closed instead of silently dropping
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
      // releasing the lock before the write settles can drop the datagram under congestion
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
