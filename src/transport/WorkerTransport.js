import { TransportWrapper } from './TransportWrapper.js'

export class WorkerTransport extends TransportWrapper {
  constructor(postFn) {
    super()
    this._post = postFn
    this.type = 'worker'
    this.ready = true
  }

  send(data) {
    if (!this.ready) return
    const buf = data instanceof Uint8Array
      ? (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data.buffer : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
      : data instanceof ArrayBuffer ? data : new Uint8Array(data).buffer
    this._post({ type: 'SEND_CLIENT', data: buf }, [buf])
  }

  close() {
    this.ready = false
    this.emit('close')
  }
}
