import { TransportWrapper } from './TransportWrapper.js'

const BATCH_THRESHOLD = 128
const BATCH_PREFIX = 0xBE

export class WireweaveTransport extends TransportWrapper {
  constructor({ session, peerPubkey }) {
    super()
    this.type = 'wireweave'
    this._session = session
    this._peer = peerPubkey
    this._batchQueue = []
    this._batchTimer = null
    this._onData = (e) => {
      if (e.detail.peerPubkey !== this._peer) return
      const raw = _toArrayBuffer(e.detail.data)
      if (raw.byteLength > 0 && new Uint8Array(raw)[0] === BATCH_PREFIX) {
        const view = new Uint8Array(raw, 1)
        let off = 0
        while (off + 4 <= view.byteLength) {
          const len = (view[off] << 24) | (view[off + 1] << 16) | (view[off + 2] << 8) | view[off + 3]
          off += 4
          if (off + len > view.byteLength) break
          // zero-copy view: ConnectionManager.addClient decodes synchronously and never retains the buffer
          this.emit('message', new Uint8Array(view.buffer, view.byteOffset + off, len))
          off += len
        }
      } else {
        this.emit('message', raw)
      }
    }
    this._onOpen = (e) => { if (e.detail.peerPubkey === this._peer) { this.ready = true; this.emit('open') } }
    this._onClose = (e) => { if (e.detail.peerPubkey === this._peer) { this.ready = false; this.emit('close') } }
    session.addEventListener('data', this._onData)
    session.addEventListener('peer-open', this._onOpen)
    session.addEventListener('peer-close', this._onClose)
    session.addEventListener('peer-closed', this._onClose)
    if (session.peers?.get(peerPubkey)?.dc?.readyState === 'open') this.ready = true
  }

  _flushBatch() {
    this._batchTimer = null
    const items = this._batchQueue.splice(0)
    if (items.length === 0) return true
    if (items.length === 1) {
      return this._session.send(this._peer, items[0])
    }
    const totalLen = items.reduce((s, buf) => s + 4 + buf.byteLength, 0)
    const batchMsg = new Uint8Array(1 + totalLen)
    batchMsg[0] = BATCH_PREFIX
    let offset = 1
    for (const buf of items) {
      batchMsg[offset++] = (buf.byteLength >> 24) & 0xFF
      batchMsg[offset++] = (buf.byteLength >> 16) & 0xFF
      batchMsg[offset++] = (buf.byteLength >> 8) & 0xFF
      batchMsg[offset++] = buf.byteLength & 0xFF
      batchMsg.set(new Uint8Array(buf), offset)
      offset += buf.byteLength
    }
    return this._session.send(this._peer, batchMsg.buffer)
  }

  send(data) {
    if (!this.ready) return false
    const buf = _toBuffer(data)
    if (buf.byteLength < BATCH_THRESHOLD) {
      this._batchQueue.push(buf)
      if (!this._batchTimer) this._batchTimer = Promise.resolve().then(() => this._flushBatch())
      return true
    }
    this._flushBatch()
    return this._session.send(this._peer, buf)
  }

  sendUnreliable(data) { return this.send(data) }

  close() {
    super.close()
    this._session.removeEventListener('data', this._onData)
    this._session.removeEventListener('peer-open', this._onOpen)
    this._session.removeEventListener('peer-close', this._onClose)
    this._session.removeEventListener('peer-closed', this._onClose)
  }
}

function _toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data
  if (data instanceof Uint8Array) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  return new Uint8Array(data).buffer
}

function _toBuffer(data) {
  if (data instanceof ArrayBuffer) return data
  if (data instanceof Uint8Array) return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data.buffer : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  return new Uint8Array(data).buffer
}
