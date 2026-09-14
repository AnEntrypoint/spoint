import { PredictionEngine } from './PredictionEngine.js'
import { SmoothInterpolation } from './SmoothInterpolation.js'
import { ClockSync } from './ClockSync.js'
import { MSG, WIRE_PROTOCOL_VERSION } from '../protocol/MessageTypes.js'
import { WIRE_STRUCT_HASH } from '../protocol/msgpack.js'

const PRE_HANDSHAKE_TICK_RATE = 60

export class MessageHandler {
  constructor(config = {}) {
    this._config = config
    this._predEngine = null
    this._smoothInterp = null
    this._playerId = null
    this._callbacks = config.callbacks || {}
    this._clockSync = new ClockSync(config.clockSync)
    this._peerRttTable = { rtt: {}, pubkeys: {} }
  }

  handleMessage(type, payload, snapProc) {
    if (type === MSG.HANDSHAKE_ACK) {
      return this._handleHandshake(payload)
    } else if (type === MSG.RECONNECT_ACK) {
      return this._handleReconnect(payload, snapProc)
    } else if (type === MSG.STATE_RECOVERY) {
      return payload.snapshot
    } else if (type === MSG.DISCONNECT_REASON) {
      if (payload.code === 4) return { invalidate: true }
    } else if (type === MSG.SNAPSHOT || type === MSG.STATE_CORRECTION) {
      return payload
    } else if (type === MSG.PLAYER_LEAVE) {
      snapProc?.removePlayer(payload.playerId)
      this._callbacks.onPlayerLeft?.(payload.playerId)
    } else if (type === MSG.WORLD_DEF) {
      if (payload.movement && this._predEngine) this._predEngine.setMovement(payload.movement)
      if (payload.gravity && this._predEngine) this._predEngine.setGravity(payload.gravity)
      if (payload.tickRate && this._predEngine) this._predEngine.setTickRate(payload.tickRate)
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
    }
  }

  _handleHandshake(payload) {
    const serverVersion = payload.version ?? WIRE_PROTOCOL_VERSION
    if (serverVersion !== WIRE_PROTOCOL_VERSION) {
      console.error(`[client] WIRE PROTOCOL MISMATCH: server v${serverVersion} vs client v${WIRE_PROTOCOL_VERSION} - snapshots/messages may be misread; update the stale side`)
    }
    this._checkStructHash(payload.structHash)
    this._playerId = payload.playerId
    this._predEngine = new PredictionEngine(payload.tickRate || this._config.tickRate || PRE_HANDSHAKE_TICK_RATE)
    this._predEngine.init(this._playerId)
    if (this._config.smoothInterpolation !== false) {
      this._smoothInterp = new SmoothInterpolation({ predictionEnabled: this._config.predictionEnabled !== false })
      this._smoothInterp.setLocalPlayer(this._playerId)
    }
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
    if (this._smoothInterp) {
      this._smoothInterp.reset()
      this._smoothInterp.setLocalPlayer(this._playerId)
    }
    if (oldPlayerId) this._callbacks.onPlayerLeft?.(oldPlayerId)
    const prevEngine = this._predEngine
    this._predEngine = new PredictionEngine(payload.tickRate || this._config.tickRate || PRE_HANDSHAKE_TICK_RATE)
    this._predEngine.init(this._playerId, { position: payload.position, health: payload.health })
    if (prevEngine && Array.isArray(prevEngine.inputHistory) && prevEngine.inputHistory.length) {
      const unacked = prevEngine.inputHistory.filter(e => e.sequence > prevEngine._lastAckedSeq)
      if (unacked.length) {
        this._predEngine.inputHistory = unacked
        this._predEngine._inputSeq = prevEngine._inputSeq
        this._predEngine._lastAckedSeq = prevEngine._lastAckedSeq
      }
    }
    if (this._config.smoothInterpolation !== false && !this._smoothInterp) {
      this._smoothInterp = new SmoothInterpolation({ predictionEnabled: this._config.predictionEnabled !== false })
      this._smoothInterp.setLocalPlayer(this._playerId)
    }
    return { sessionToken: payload.sessionToken }
  }

  _handleHeartbeat(payload) {
    const t3 = Date.now()
    if (this._smoothInterp && payload.timestamp) {
      this._smoothInterp.updateRTT(payload.timestamp, t3)
    }
    if (typeof payload.timestamp === 'number' && typeof payload.serverTime === 'number') {
      this._clockSync.addSample(payload.timestamp, payload.serverTime, t3)
    }
  }

  getPlayerId() { return this._playerId }
  getPredEngine() { return this._predEngine }
  getSmoothInterp() { return this._smoothInterp }
  getStructMismatch() { return this._structMismatch }
  getClockSync() { return this._clockSync }

  getRTT() {
    return this._smoothInterp?.getRTT() || 0
  }

  getOneWayDelay() {
    return this._clockSync.getOneWayDelay()
  }

  estimateMessageAgeMs(clientSendTime) {
    return this._clockSync.estimateAgeMs(clientSendTime)
  }

  getBufferHealth() {
    return this._smoothInterp?.getBufferHealth() || 0
  }

  getPeerRttTable() { return this._peerRttTable }
}
