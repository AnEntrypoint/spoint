import { TransportWrapper } from './TransportWrapper.js'

export const LIFECYCLE_CONNECTING = 'connecting'
export const LIFECYCLE_OPEN = 'open'
export const LIFECYCLE_CLOSED = 'closed'

export class WebTransportTransport extends TransportWrapper {
  constructor(session) {
    super()
    this.type = 'webtransport'
    this.session = session
    this.lifecycle = LIFECYCLE_CONNECTING
    this.reliableWriter = null
    this.reliableReader = null
    this.datagramWriter = null
    this._lastSendError = null
    this._init()
  }

  async _init() {
    try {
      await this._setupReliableStream()
      this._readDatagrams()
      if (this.lifecycle === LIFECYCLE_CONNECTING) this.lifecycle = LIFECYCLE_OPEN
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
      while (this.lifecycle !== LIFECYCLE_CLOSED) {
        const { value, done } = await this.reliableReader.read()
        if (done) break
        if (value) this.emit('message', value)
      }
    } catch (e) {
      this._handleClose()
    }
  }

  async _readDatagrams() {
    try {
      const reader = this.session.datagrams.readable.getReader()
      while (this.lifecycle !== LIFECYCLE_CLOSED) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) this.emit('message', value)
      }
    } catch (e) {
      this._handleClose()
    }
  }

  _handleClose() {
    if (this.lifecycle === LIFECYCLE_CLOSED) return
    this.lifecycle = LIFECYCLE_CLOSED
    this.emit('close')
  }

  get isOpen() {
    return this.lifecycle === LIFECYCLE_OPEN
  }

  get ready() {
    return this.isOpen
  }

  set ready(open) {
    this.lifecycle = open ? LIFECYCLE_OPEN : LIFECYCLE_CLOSED
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
        this._handleClose()
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
    this._handleClose()
    super.close()
    if (this.datagramWriter) {
      const writer = this.datagramWriter
      this.datagramWriter = null
      try { writer.releaseLock() } catch (e) {}
    }
    try { this.session.close() } catch (e) {}
  }
}
