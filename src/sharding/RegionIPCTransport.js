import { TransportWrapper } from '../transport/TransportWrapper.js'

// Per-player transport used INSIDE a region-shard worker process. The worker never talks to a real
// socket -- the router (RegionRouter.js) owns the actual WebSocket and forwards raw client frames to
// whichever region worker currently owns that player over Node's child_process IPC channel (`process.send`
// in the child / `child.send` in the parent). This class is the worker-side half: ConnectionManager and
// every wire handler (ServerHandlers.js, EditorHandlers.js, ...) treat it exactly like a WebSocketTransport
// or WorkerTransport -- same send/close/on('message') contract -- so ZERO changes were needed to the
// server-side message-handling code to make sharding work; only the transport implementation differs.
//
// Framing: IPC `send()` already delivers structured-clone-able JS values (Node serializes internally), so
// binary payloads are passed as base64 strings wrapped in an envelope object -- `child.send()` cannot carry
// a raw Buffer/Uint8Array across the IPC boundary without a manual encode step (Node's IPC channel is JSON
// under the hood; a Buffer survives structured serialization poorly across versions, base64 is the
// unambiguous, version-stable choice here given the low relative frequency of shard-boundary traffic vs.
// the wire-protocol's own binary hot path, which never touches this file).
export class RegionIPCTransport extends TransportWrapper {
  constructor(playerId, sendToRouter) {
    super()
    this.type = 'region-ipc'
    this.playerId = playerId
    this._sendToRouter = sendToRouter
    this.ready = true
  }

  send(data) {
    if (!this.ready) return false
    const buf = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(Buffer.from(data))
    try {
      // WORKER_FRAME (worker -> router -> client) is intentionally a DIFFERENT type name than
      // CLIENT_FRAME (router -> worker, the inbound direction handled in RegionWorkerEntry.js's
      // process.on('message')) even though both carry a client wire-frame -- the two travel in
      // opposite directions on the SAME IPC channel, and reusing one type name for both would let a
      // frame the router just forwarded in loop back as if the worker had sent it outbound.
      this._sendToRouter({ type: 'WORKER_FRAME', playerId: this.playerId, dataB64: Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('base64') })
      return true
    } catch (e) {
      return false
    }
  }

  close() {
    if (!this.ready) return
    this.ready = false
    this._sendToRouter({ type: 'CLIENT_CLOSE_FROM_WORKER', playerId: this.playerId })
    this.emit('close')
  }

  // Called by the worker's own IPC message dispatcher when a raw client frame arrives from the router.
  deliver(dataB64) {
    this.emit('message', Buffer.from(dataB64, 'base64'))
  }
}
