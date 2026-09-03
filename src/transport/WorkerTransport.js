import { TransportWrapper } from './TransportWrapper.js'

export class WorkerTransport extends TransportWrapper {
  constructor(postFn) {
    super()
    this._post = postFn
    this.type = 'worker'
    this.ready = true
  }

  // mt is forwarded so the main thread can coalesce snapshot-family messages by type, else the
  // worker->main postMessage queue grows unbounded when render lags behind the snapshot rate
  send(data, mt) {
    if (!this.ready) return false
    const buf = data instanceof Uint8Array
      ? (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data.buffer : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
      : data instanceof ArrayBuffer ? data : new Uint8Array(data).buffer
    try {
      this._post({ type: 'SEND_CLIENT', data: buf, mt }, [buf])
      return true
    } catch (e) {
      return false
    }
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
    this._post = postFn
    this.type = 'peer'
    this.ready = true
  }

  // mt forwarded (mirrors WorkerTransport.send above) so the main thread can identify a bare-SNAPSHOT
  // PEER_SEND without decoding msgpack -- see client/BrowserServer.js's onPeerSnapshot tap
  // (p2p-mesh-redundant-snapshot-relay-via-joiner-joiner-edges), which needs each peer's latest raw
  // SNAPSHOT bytes to have something to relay when that peer's direct host edge looks degraded.
  send(data, mt) {
    if (!this.ready) return false
    const buf = data instanceof Uint8Array
      ? (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data.buffer : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
      : data instanceof ArrayBuffer ? data : new Uint8Array(data).buffer
    try {
      this._post({ type: 'PEER_SEND', peerId: this._peerId, data: buf, mt }, [buf])
      return true
    } catch (e) {
      return false
    }
  }

  close() {
    this.ready = false
    this.emit('close')
  }
}
