import { SendContractError, TransportWrapper } from './TransportWrapper.js'

const _kindOf = (v) => Object.prototype.toString.call(v).slice(8, -1)

function _postFnOf(postFn, who) {
  if (typeof postFn !== 'function') {
    throw new SendContractError(`${who} reaches the wire only through postFn; got ${_kindOf(postFn)}. send() answers one fact -- whether the payload reached the wire -- and an uncallable postFn can never answer it`)
  }
  return postFn
}

function _wireBufferOf(data, who) {
  if (data instanceof ArrayBuffer) return data
  if (data instanceof Uint8Array) {
    return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
      ? data.buffer
      : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  }
  throw new SendContractError(`${who}.send() answers one fact -- whether the payload reached the wire -- and accepts only Uint8Array|ArrayBuffer; got ${_kindOf(data)}. Any other value was silently sent as a zero-byte frame and reported as success`)
}

export class WorkerTransport extends TransportWrapper {
  constructor(postFn) {
    super()
    this._post = _postFnOf(postFn, 'WorkerTransport')
    this.type = 'worker'
    this.ready = true
  }

  send(data, mt) {
    const buf = _wireBufferOf(data, 'WorkerTransport')
    if (!this.ready) return false
    this._post({ type: 'SEND_CLIENT', data: buf, mt }, [buf])
    return true
  }

  close() {
    this.ready = false
    this.emit('close')
  }
}

export class PeerTransport extends TransportWrapper {
  constructor(peerId, postFn) {
    super()
    this._peerId = peerId
    this._post = _postFnOf(postFn, 'PeerTransport')
    this.type = 'peer'
    this.ready = true
  }

  send(data, mt) {
    const buf = _wireBufferOf(data, 'PeerTransport')
    if (!this.ready) return false
    this._post({ type: 'PEER_SEND', peerId: this._peerId, data: buf, mt }, [buf])
    return true
  }

  close() {
    this.ready = false
    this.emit('close')
  }
}
