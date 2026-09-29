import { PredictionEngine } from './PredictionEngine.js'
import { SnapshotTimeline } from './SnapshotTimeline.js'
import { ClockSync } from './ClockSync.js'
import { MSG, WIRE_PROTOCOL_VERSION, DISCONNECT_REASONS } from '../protocol/MessageTypes.js'
import { WIRE_STRUCT_HASH } from '../protocol/msgpack.js'
import { createInputSchema, DEFAULT_INPUT_SCHEMA } from '../protocol/InputCodec.js'

const PRE_HANDSHAKE_TICK_RATE = 60
const RTT_EMA_ALPHA = 0.25
const RTT_OUTLIER_FACTOR = 5

export class MessageHandler {
  constructor(config = {}) {
    this._config = config
    this._predEngine = null
    this._timeline = new SnapshotTimeline({ tickRate: config.tickRate || PRE_HANDSHAKE_TICK_RATE })
    this._rttMs = 0
    this._playerId = null
    this._callbacks = config.callbacks || {}
    this._clockSync = new ClockSync(config.clockSync)
    this._peerRttTable = { rtt: {}, pubkeys: {} }
    this._inputSchema = DEFAULT_INPUT_SCHEMA
  }

  getInputSchema() { return this._inputSchema }

  handleMessage(type, payload, snapProc) {
    if (type === MSG.HANDSHAKE_ACK) {
      return this._handleHandshake(payload)
    } else if (type === MSG.RECONNECT_ACK) {
      return this._handleReconnect(payload, snapProc)
    } else if (type === MSG.STATE_RECOVERY) {
      return payload.snapshot
    } else if (type === MSG.DISCONNECT_REASON) {
      if (payload.code === DISCONNECT_REASONS.INVALID_SESSION) return { invalidate: true }
      if (payload.code === DISCONNECT_REASONS.PROTOCOL_MISMATCH) {
        const msg = `[client] server v${payload.version} rejected this v${WIRE_PROTOCOL_VERSION} client (protocol mismatch); hard-reload`
        console.error(msg)
        return { protocolMismatch: msg }
      }
    } else if (type === MSG.SNAPSHOT || type === MSG.STATE_CORRECTION) {
      return payload
    } else if (type === MSG.PLAYER_LEAVE) {
      snapProc?.removePlayer(payload.playerId)
      this._callbacks.onPlayerLeft?.(payload.playerId)
    } else if (type === MSG.WORLD_DEF) {
      if (payload.movement && this._predEngine) this._predEngine.setMovement(payload.movement)
      if (payload.gravity && this._predEngine) this._predEngine.setGravity(payload.gravity)
      if (payload.tickRate && this._predEngine) this._predEngine.setTickRate(payload.tickRate)
      if (payload.tickRate) this._timeline.setTickRate(payload.tickRate)
      this._inputSchema = createInputSchema(payload.netcode || null)
      try { this._callbacks.onWorldDef?.(payload) }
      catch (e) { console.error('[client] onWorldDef failed:', e?.message || e) }
    } else if (type === MSG.APP_EVENT) {
      this._callbacks.onAppEvent?.(payload)
    } else if (type === MSG.HOT_RELOAD || type === MSG.APP_MODULE || type === MSG.ASSET_UPDATE) {
      const cb = { [MSG.HOT_RELOAD]: 'onHotReload', [MSG.APP_MODULE]: 'onAppModule', [MSG.ASSET_UPDATE]: 'onAssetUpdate' }[type]
      this._callbacks[cb]?.(payload)
    } else if (type === MSG.HEARTBEAT_ACK) {
      this._handleHeartbeat(payload)
    } else if (type === MSG.PEER_RTT_TABLE) {
      this._peerRttTable = { rtt: payload?.rtt || {}, pubkeys: payload?.pubkeys || {} }
      this._callbacks.onPeerRttTable?.(this._peerRttTable)
    } else if (type === MSG.EDITOR_SELECT) {
      this._callbacks.onEditorSelect?.(payload)
    } else if (type === MSG.APP_LIST || type === MSG.SOURCE || type === MSG.SCENE_GRAPH || type === MSG.APP_FILES || type === MSG.EDITOR_PROPS || type === MSG.EVENT_LOG_DATA || type === MSG.WORLD_SAVED || type === MSG.WORLD_LIST || type === MSG.FS_TREE || type === MSG.FS_TREE_CHANGED || type === MSG.FS_OP_RESULT) {
      this._callbacks.onMessage?.(type, payload)
    } else if (type === MSG.TERRAIN_CONFIG) {
      this._callbacks.onTerrainConfig?.(payload)
    } else if (type === MSG.TERRAIN_SCULPT_ACK) {
      this._callbacks.onTerrainSculptAck?.(payload)
    } else if (type === MSG.TERRAIN_PAINT_BIOME_ACK) {
      this._callbacks.onTerrainPaintBiomeAck?.(payload)
    } else if (type === MSG.GRASS_DECAL_SYNC) {
      this._callbacks.onGrassDecalSync?.(payload)
    } else if (type === MSG.TERRAIN_SCULPT_SYNC) {
      this._callbacks.onTerrainSculptSync?.(payload)
    } else if (type === MSG.TIME_OF_DAY_SYNC) {
      this._callbacks.onTimeOfDaySync?.(payload)
    } else if (type === MSG.WEATHER_SYNC) {
      this._callbacks.onWeatherSync?.(payload)
    } else if (type === MSG.DESTROY_ENTITY) {
      this._callbacks.onEntityRemoved?.(payload.entityId)
    } else if (type === MSG.TELEPORT_ACK) {
      this._handleTeleportAck(payload)
    }
  }

  _handleTeleportAck(payload) {
    if (payload.op === 'to' && payload.phase === 'placed' && payload.ok) {
      this._timeline.reset()
      this._predEngine?.teleport(payload.position, payload.velocity, payload.tick)
    }
    this._callbacks.onTeleportAck?.(payload)
  }

  _handleHandshake(payload) {
    const serverVersion = payload.version ?? 1
    if (serverVersion !== WIRE_PROTOCOL_VERSION) {
      const msg = `[client] WIRE PROTOCOL MISMATCH: server v${serverVersion} vs client v${WIRE_PROTOCOL_VERSION}; refusing to run the session, hard-reload the stale side`
      console.error(msg)
      return { protocolMismatch: msg }
    }
    this._checkStructHash(payload.structHash)
    this._playerId = payload.playerId
    this._predEngine = new PredictionEngine(payload.tickRate || this._config.tickRate || PRE_HANDSHAKE_TICK_RATE)
    this._predEngine.init(this._playerId)
    this._timeline.setTickRate(payload.tickRate || this._config.tickRate || PRE_HANDSHAKE_TICK_RATE)
    this._timeline.reset()
    return { sessionToken: payload.sessionToken }
  }

  _checkStructHash(structHash) {
    if (structHash === undefined) return
    this._structMismatch = structHash !== WIRE_STRUCT_HASH
    if (this._structMismatch) {
      console.error(`[client] WIRE STRUCT-TABLE MISMATCH: server hash ${structHash} vs client hash ${WIRE_STRUCT_HASH} - msgpackr structure ids disagree, snapshots/messages WILL be misdecoded; hard-reload the stale side`)
    }
  }

  _handleReconnect(payload, snapProc) {
    this._checkStructHash(payload.structHash)
    const oldPlayerId = this._playerId
    this._playerId = payload.playerId
    snapProc?.clear()
    this._timeline.reset()
    if (oldPlayerId) this._callbacks.onPlayerLeft?.(oldPlayerId)
    const prevEngine = this._predEngine
    this._predEngine = new PredictionEngine(payload.tickRate || this._config.tickRate || PRE_HANDSHAKE_TICK_RATE)
    this._predEngine.init(this._playerId, { position: payload.position, health: payload.health })
    if (prevEngine) {
      this._predEngine._inputSeq = prevEngine._inputSeq
      this._predEngine._lastAckedSeq = prevEngine._inputSeq - 1
      this._predEngine.setMovement(prevEngine.movement)
      this._predEngine.gravityY = prevEngine.gravityY
      if (prevEngine._surface) this._predEngine.setGroundSurface(prevEngine._surface.heightAt)
    }
    this._timeline.setTickRate(payload.tickRate || this._config.tickRate || PRE_HANDSHAKE_TICK_RATE)
    return { sessionToken: payload.sessionToken }
  }

  _handleHeartbeat(payload) {
    const t3 = Date.now()
    if (typeof payload.timestamp === 'number') this._recordRtt(t3 - payload.timestamp)
    if (typeof payload.timestamp === 'number' && typeof payload.serverTime === 'number') {
      this._clockSync.addSample(payload.timestamp, payload.serverTime, t3)
    }
  }

  getPlayerId() { return this._playerId }
  getPredEngine() { return this._predEngine }
  getTimeline() { return this._timeline }
  getStructMismatch() { return this._structMismatch }
  getClockSync() { return this._clockSync }

  getRTT() {
    return this._rttMs
  }

  _recordRtt(sample) {
    if (!Number.isFinite(sample) || sample < 0) return
    if (this._rttMs > 0 && sample > this._rttMs * RTT_OUTLIER_FACTOR) return
    this._rttMs = this._rttMs > 0 ? this._rttMs * (1 - RTT_EMA_ALPHA) + sample * RTT_EMA_ALPHA : sample
  }

  getOneWayDelay() {
    return this._clockSync.getOneWayDelay()
  }

  estimateMessageAgeMs(clientSendTime) {
    return this._clockSync.estimateAgeMs(clientSendTime)
  }

  getBufferHealth() {
    return this._timeline.bufferedAhead
  }

  getPeerRttTable() { return this._peerRttTable }
}
