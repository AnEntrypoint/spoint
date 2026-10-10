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
      const items = _beginsWithBatchPrefix(raw) ? _decodeBatch(new Uint8Array(raw, 1)) : null
      if (items === null) {
        this.emit('message', raw)
        return
      }
      for (const item of items) this.emit('message', item)
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
    return this._sendFrame(items.length === 1 ? _wireFrameOf(items[0]) : _encodeBatch(items))
  }

  _sendFrame(frame) {
    if (this._session.send(this._peer, frame)) return true
    this.emit('error', { reason: 'send-refused', byteLength: frame.byteLength })
    return false
  }

  send(data) {
    if (!this.ready) return false
    const buf = _toArrayBuffer(data)
    if (buf.byteLength >= BATCH_THRESHOLD) {
      this._flushBatch()
      this._sendFrame(_wireFrameOf(buf))
      return
    }
    this._batchQueue.push(buf)
    if (!this._batchTimer) {
      this._batchTimer = Promise.resolve().then(() => this._flushBatch())
        .catch((err) => this.emit('error', { reason: 'flush-threw', message: err && err.message }))
    }
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
  if (data instanceof ArrayBuffer) return data.slice(0)
  if (data instanceof Uint8Array) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  return new Uint8Array(data).buffer
}

function _beginsWithBatchPrefix(buf) {
  return buf.byteLength > 0 && new Uint8Array(buf)[0] === BATCH_PREFIX
}

function _encodeBatch(items) {
  const totalLen = items.reduce((s, buf) => s + 4 + buf.byteLength, 0)
  const batchMsg = new Uint8Array(1 + totalLen)
  batchMsg[0] = BATCH_PREFIX
  let offset = 1
  for (const buf of items) {
    batchMsg[offset++] = (buf.byteLength >>> 24) & 0xFF
    batchMsg[offset++] = (buf.byteLength >>> 16) & 0xFF
    batchMsg[offset++] = (buf.byteLength >>> 8) & 0xFF
    batchMsg[offset++] = buf.byteLength & 0xFF
    batchMsg.set(new Uint8Array(buf), offset)
    offset += buf.byteLength
  }
  return batchMsg.buffer
}

function _wireFrameOf(buf) {
  return _beginsWithBatchPrefix(buf) ? _encodeBatch([buf]) : buf
}

function _decodeBatch(view) {
  const items = []
  let off = 0
  while (off < view.byteLength) {
    if (off + 4 > view.byteLength) return null
    const len = ((view[off] << 24) | (view[off + 1] << 16) | (view[off + 2] << 8) | view[off + 3]) >>> 0
    off += 4
    if (off + len > view.byteLength) return null
    items.push(view.subarray(off, off + len))
    off += len
  }
  return items.length > 0 ? items : null
}
