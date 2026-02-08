import { MSG } from '../protocol/MessageTypes.js'
import { SnapshotEncoder } from '../netcode/SnapshotEncoder.js'
import { unpack } from '../protocol/msgpack.js'

export function createMessageRouter(deps) {
  const { emitter, quality, stateInspector, send, getState, setState } = deps

  function handleSnapshot(data) {
    try {
      const decoded = SnapshotEncoder.decode(data)
      if (decoded.tick) {
        stateInspector.recordSnapshotDelay(Date.now() - (decoded.timestamp || 0))
        setState('tick', decoded.tick)
      }
      for (const p of decoded.players || []) getState('players').set(p.id, p)
      for (const e of decoded.entities || []) getState('entities').set(e.id, e)
      emitter.emit('snapshot', decoded)
    } catch (e) {
      emitter.emit('error', e)
    }
  }

  return function onMessage(raw) {
    const buf = raw instanceof ArrayBuffer ? new Uint8Array(raw) : (raw instanceof Uint8Array ? raw : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength))
    let msg
    try { msg = unpack(buf) } catch (e) { return }
    if (!msg || typeof msg !== 'object') return
    const byteLen = buf.length || buf.byteLength || 0
    quality.recordBytesIn(byteLen)

    if (msg.type === MSG.HEARTBEAT) {
      send(MSG.HEARTBEAT_ACK, { ts: msg.payload?.ts })
      return
    }
    if (msg.type === MSG.HEARTBEAT_ACK && msg.payload?.ts) {
      quality.recordRtt(Date.now() - msg.payload.ts)
      quality.recordHeartbeatReceived()
      return
    }
    if (msg.type === MSG.HANDSHAKE_ACK) {
      setState('playerId', msg.payload.playerId)
      setState('sessionToken', msg.payload.sessionToken)
      setState('tick', msg.payload.tick)
      emitter.emit('connect', { playerId: msg.payload.playerId, tick: msg.payload.tick })
      return
    }
    if (msg.type === MSG.SNAPSHOT) { handleSnapshot(msg.payload); return }
    if (msg.type === MSG.PLAYER_LEAVE) {
      getState('players').delete(msg.payload.playerId)
      emitter.emit('playerLeave', msg.payload.playerId)
      return
    }
    if (msg.type === MSG.RECONNECT_ACK) {
      setState('playerId', msg.payload.playerId)
      setState('sessionToken', msg.payload.sessionToken)
      setState('tick', msg.payload.tick)
      setState('reconnecting', false)
      setState('reconnectAttempts', 0)
      emitter.emit('reconnect', msg.payload)
      return
    }
    if (msg.type === MSG.STATE_RECOVERY) {
      const decoded = SnapshotEncoder.decode(msg.payload.snapshot)
      for (const p of decoded.players || []) getState('players').set(p.id, p)
      for (const e of decoded.entities || []) getState('entities').set(e.id, e)
      emitter.emit('stateRecovery', decoded)
      return
    }
    if (msg.type === MSG.STATE_CORRECTION) {
      stateInspector.recordCorrection(getState('playerId'), null, msg.payload, 0)
      emitter.emit('correction', msg.payload)
      return
    }
    if (msg.type === MSG.DISCONNECT_REASON) {
      emitter.emit('disconnectReason', msg.payload)
      return
    }
    emitter.emit('message', msg)
  }
}
