import { TransportWrapper } from './TransportWrapper.js'

export class WebTransportTransport extends TransportWrapper {
  constructor(session) {
    super()
    this.type = 'webtransport'
    this.session = session
    this.ready = false
    this.reliableWriter = null
    this.reliableReader = null
    this.datagramWriter = null
    this._closed = false
    this._lastSendError = null
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

  get lastSendError() {
    return this._lastSendError
  }

  _releaseDatagramWriter() {
    const writer = this.datagramWriter
    this.datagramWriter = null
    if (writer) {
      try { writer.releaseLock() } catch (e) {}
    }
  }

  _reportSendFailure(channel, data, error) {
    this._lastSendError = { channel, data, error }
    this.emit('send-error', { channel, data, error })
  }

  send(data) {
    if (!this.isOpen || !this.reliableWriter) return false
    try {
      const written = this.reliableWriter.write(data)
      Promise.resolve(written).catch((error) => {
        this._reportSendFailure('reliable', data, error)
        if (!this._closed) this._handleClose()
      })
      return true
    } catch (error) {
      this._reportSendFailure('reliable', data, error)
      return false
    }
  }

  sendUnreliable(data) {
    if (!this.isOpen) return false
    try {
      if (!this.datagramWriter) this.datagramWriter = this.session.datagrams.writable.getWriter()
      const written = this.datagramWriter.write(data)
      Promise.resolve(written).catch((error) => {
        this._reportSendFailure('unreliable', data, error)
        this._releaseDatagramWriter()
      })
      return 'datagram'
    } catch (error) {
      this._releaseDatagramWriter()
      this._reportSendFailure('unreliable', data, error)
      return this.send(data) ? 'reliable' : false
    }
  }

  close() {
    super.close()
    this._handleClose()
    if (this.datagramWriter) {
      const writer = this.datagramWriter
      this.datagramWriter = null
      try { writer.releaseLock() } catch (e) {}
    }
    try { this.session.close() } catch (e) {}
  }
}
