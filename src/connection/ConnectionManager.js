import { pack, unpack } from '../protocol/msgpack.js'
import { isUnreliable } from '../protocol/MessageTypes.js'
import { EventEmitter } from '../protocol/EventEmitter.js'

const _sendObj = { type: 0, payload: null }

// Coalescing frame format: sentinel byte 0xFF (never a valid opening byte for our top-level msgpack value --
// every message packs a map {type,payload}, whose msgpack header is 0x80-0x8f/0xde/0xdf, so a lone 0xFF byte
// is unambiguous and back-compatible with any peer still expecting one message per socket frame) followed by
// repeated [uint32 LE length][payload bytes] records. Used to fold every send() this tick for a client into
// ONE socket.send() call instead of N -- each send() carries real per-call syscall/framing overhead at a
// the configured server tick rate (60Hz default, per-world override) with potentially several messages (snapshot + heartbeat-ack + app-events) landing in the
// same tick for the same client.
const COALESCE_SENTINEL = 0xff
const LEN_PREFIX_BYTES = 4

function frameCoalesced(buffers) {
  if (buffers.length === 1) return buffers[0]
  let total = 1
  for (const b of buffers) total += LEN_PREFIX_BYTES + b.length
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  out[0] = COALESCE_SENTINEL
  let off = 1
  for (const b of buffers) {
    view.setUint32(off, b.length, true); off += LEN_PREFIX_BYTES
    out.set(b, off); off += b.length
  }
  return out
}

export class ConnectionManager extends EventEmitter {
  constructor(options = {}) {
    super()
    this.clients = new Map()
    this.heartbeatInterval = options.heartbeatInterval || 1000
    this.heartbeatTimeout = options.heartbeatTimeout || 3000
    this.timers = new Map()
  }

  addClient(clientId, transport) {
    const client = {
      id: clientId,
      transport,
      lastHeartbeat: Date.now(),
      sessionToken: null,
      transportType: transport.type || 'websocket',
      // Present only for a wireweave P2P peer connection (PeerTransport carries the room's pubkey as
      // _peerId -- see src/transport/WorkerTransport.js). Undefined on the plain WS/in-Worker-host transport.
      // Host-migration election (client/HostMigration.js, via MSG.PEER_RTT_TABLE's playerId->pubkey map)
      // needs this to know WHICH wireweave peer a given server playerId corresponds to, since the two id
      // spaces (sequential server playerId vs nostr pubkey) are otherwise uncorrelated on the client side.
      peerPubkey: transport.type === 'peer' ? transport._peerId : undefined,
      // per-tick coalescing outbox, flushed by flushAll() at end of tick. Reliable and unreliable messages
      // queued this tick are frame-coalesced separately (each becomes its own single socket.send()) so an
      // unreliable/dropped snapshot frame never blocks or gets blocked by a reliable message's delivery
      // guarantee, and vice versa. _lastType tracks the single message type queued so far -- if it stays
      // singular for the whole tick, flushAll can still forward a real `mt` to transports (e.g.
      // WorkerTransport) that use it for their own type-aware coalescing; mixed types forward `mt=undefined`.
      _outReliable: [], _outReliableType: undefined, _outReliableMixed: false,
      _outUnreliable: [], _outUnreliableType: undefined, _outUnreliableMixed: false
    }

    transport.on('message', (data) => {
      try {
        client.lastHeartbeat = Date.now()
        const msg = unpack(data)
        this.emit('message', clientId, msg)
      } catch (err) {
        console.error(`[connection] decode error for ${clientId}:`, err.message)
      }
    })

    // guard on clients.has: whichever disconnect path (close/error/timeout) fires second is a no-op
    transport.on('close', () => {
      if (this.clients.has(clientId)) this.emit('disconnect', clientId, 'closed')
      this.removeClient(clientId)
    })

    transport.on('error', (err) => {
      console.error(`[connection] transport error for ${clientId}:`, err.message)
      if (this.clients.has(clientId)) this.emit('disconnect', clientId, 'error')
      this.removeClient(clientId)
    })

    this.clients.set(clientId, client)
    this._setupHeartbeat(clientId)
    return client
  }

  _setupHeartbeat(clientId) {
    const check = () => {
      const client = this.clients.get(clientId)
      if (!client) return
      const age = Date.now() - client.lastHeartbeat
      if (age > this.heartbeatTimeout) {
        this.emit('disconnect', clientId, 'timeout')
        this.removeClient(clientId)
        return
      }
      const timer = setTimeout(check, this.heartbeatInterval)
      this.timers.set(clientId, timer)
    }
    const timer = setTimeout(check, this.heartbeatInterval)
    this.timers.set(clientId, timer)
  }

  resetHeartbeat(clientId) {
    const client = this.clients.get(clientId)
    if (client) client.lastHeartbeat = Date.now()
  }

  removeClient(clientId) {
    const client = this.clients.get(clientId)
    if (!client) return
    if (client.transport && client.transport.isOpen) {
      client.transport.close()
    }
    this.clients.delete(clientId)
    const timer = this.timers.get(clientId)
    if (timer) clearTimeout(timer)
    this.timers.delete(clientId)
  }

  detachClient(clientId) {
    const client = this.clients.get(clientId)
    if (client?.transport) {
      client.transport.removeAllListeners('message')
      client.transport.removeAllListeners('close')
      client.transport.removeAllListeners('error')
    }
    this.clients.delete(clientId)
    const timer = this.timers.get(clientId)
    if (timer) clearTimeout(timer)
    this.timers.delete(clientId)
  }

  getClient(clientId) {
    return this.clients.get(clientId)
  }

  send(clientId, type, payload = {}) {
    const client = this.clients.get(clientId)
    if (!client || !client.transport.isOpen) return false
    try {
      _sendObj.type = type; _sendObj.payload = payload
      const data = pack(_sendObj)
      return this._enqueue(client, data, isUnreliable(type), type)
    } catch (err) {
      console.error(`[connection] send error to ${clientId}:`, err.message)
      return false
    }
  }

  broadcast(type, payload = {}) {
    _sendObj.type = type; _sendObj.payload = payload
    const data = pack(_sendObj)
    const unreliable = isUnreliable(type)
    let count = 0
    for (const client of this.clients.values()) {
      if (!client.transport.isOpen) continue
      try {
        if (this._enqueue(client, data, unreliable, type) !== false) count++
      } catch (err) {
        console.error(`[connection] broadcast error to ${client.id}:`, err.message)
      }
    }
    return count
  }

  sendPacked(clientId, data, unreliable, type) {
    const client = this.clients.get(clientId)
    if (!client || !client.transport.isOpen) return false
    try {
      return this._enqueue(client, data, unreliable, type)
    } catch (err) {
      console.error(`[connection] sendPacked error to ${clientId}:`, err.message)
      return false
    }
  }

  // Queues a single packed message onto this tick's per-client outbox rather than sending immediately.
  // flushAll() (called once per tick, after all app/tick logic has run) coalesces everything queued this
  // tick into at most one reliable + one unreliable socket.send() per client.
  _enqueue(client, data, unreliable, type) {
    if (unreliable) {
      if (client._outUnreliable.length === 0) client._outUnreliableType = type
      else if (client._outUnreliableType !== type) client._outUnreliableMixed = true
      client._outUnreliable.push(data)
    } else {
      if (client._outReliable.length === 0) client._outReliableType = type
      else if (client._outReliableType !== type) client._outReliableMixed = true
      client._outReliable.push(data)
    }
    return true
  }

  // Called once per tick (after onTick) to flush every client's coalesced outbox. Reliable and unreliable
  // queues are framed and sent separately -- see frameCoalesced's header comment for the wire format and
  // rationale. A transport-level drop (e.g. WebSocketTransport.sendUnreliable's backpressure guard) only
  // ever applies to the unreliable frame, matching per-message drop semantics (a queued reliable message
  // is never silently dropped by coalescing it). The resolved `mt` (only meaningful/passed through when
  // exactly one message type was queued this tick) preserves WorkerTransport's own type-aware coalescing
  // (see client/BrowserServer.js's snapshot rAF-batch) for the common single-message-per-tick case.
  flushAll() {
    for (const client of this.clients.values()) {
      if (!client.transport.isOpen) {
        client._outReliable.length = 0; client._outUnreliable.length = 0
        client._outReliableMixed = false; client._outUnreliableMixed = false
        continue
      }
      if (client._outReliable.length) {
        const mt = client._outReliableMixed ? undefined : client._outReliableType
        try { client.transport.send(frameCoalesced(client._outReliable), mt) }
        catch (err) { console.error(`[connection] flush(reliable) error to ${client.id}:`, err.message) }
        client._outReliable.length = 0; client._outReliableMixed = false
      }
      if (client._outUnreliable.length) {
        const mt = client._outUnreliableMixed ? undefined : client._outUnreliableType
        try { client.transport.sendUnreliable(frameCoalesced(client._outUnreliable), mt) }
        catch (err) { console.error(`[connection] flush(unreliable) error to ${client.id}:`, err.message) }
        client._outUnreliable.length = 0; client._outUnreliableMixed = false
      }
    }
  }

  getAllStats() {
    return {
      activeConnections: this.clients.size,
      clients: Array.from(this.clients.entries()).map(([id, c]) => ({
        id,
        transport: c.transportType,
        sessionToken: c.sessionToken ? '***' : null
      }))
    }
  }

  destroy() {
    for (const clientId of [...this.clients.keys()]) this.removeClient(clientId)
  }
}
