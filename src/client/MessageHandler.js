import { PredictionEngine } from './PredictionEngine.js'
import { SmoothInterpolation } from './SmoothInterpolation.js'
import { ClockSync } from './ClockSync.js'
import { MSG, WIRE_PROTOCOL_VERSION } from '../protocol/MessageTypes.js'
import { WIRE_STRUCT_HASH } from '../protocol/msgpack.js'

export class MessageHandler {
  constructor(config = {}) {
    this._config = config
    this._predEngine = null
    this._smoothInterp = null
    this._playerId = null
    this._callbacks = config.callbacks || {}
    this._clockSync = new ClockSync(config.clockSync)
    // {rtt:{[playerId]:rttMs}, pubkeys:{[playerId]:wireweavePubkey}} from the most recent
    // MSG.PEER_RTT_TABLE broadcast (see TickHandler.js) -- the host-migration election
    // (client/HostMigration.js) reads this so every joiner independently agrees on the same lowest-ping
    // remaining peer AND can resolve that winner's server playerId back to a wireweave pubkey to reconnect
    // to. Empty until the first broadcast arrives (~1s after connect).
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
      // catch so a throw here can't wedge the loading machine's handshake
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
    // undefined version = pre-versioning server, treated as compatible
    const serverVersion = payload.version ?? WIRE_PROTOCOL_VERSION
    if (serverVersion !== WIRE_PROTOCOL_VERSION) {
      console.error(`[client] WIRE PROTOCOL MISMATCH: server v${serverVersion} vs client v${WIRE_PROTOCOL_VERSION} - snapshots/messages may be misread; update the stale side`)
    }
    this._checkStructHash(payload.structHash)
    this._playerId = payload.playerId
    // must use server's tickRate, not the local default, or prediction diverges every step
    this._predEngine = new PredictionEngine(payload.tickRate || this._config.tickRate || 60)
    this._predEngine.init(this._playerId)
    if (this._config.smoothInterpolation !== false) {
      this._smoothInterp = new SmoothInterpolation({ predictionEnabled: this._config.predictionEnabled !== false })
      this._smoothInterp.setLocalPlayer(this._playerId)
    }
    return { sessionToken: payload.sessionToken }
  }

  // The actual shared-dictionary negotiation check: both sides build their msgpackr `structures` table
  // from the SAME imported WIRE_STRUCTURES const (src/protocol/msgpack.js), so under normal operation
  // this hash always matches -- there is no runtime table EXCHANGE (that would cost a round trip before
  // any other message could be safely decoded). What this catches is DRIFT: a stale client bundle (old
  // browser cache) talking to a freshly-deployed server (or vice versa) whose WIRE_STRUCTURES differ,
  // which corrupts every future SNAPSHOT/envelope silently -- msgpackr decodes structure id 0/1 using
  // whatever fields ITS OWN local table says id 0/1 means, with no wire-level signal that the two tables
  // disagree. `this._structMismatch` is set so a caller (e.g. app.js's connection-error UI) can react --
  // undefined structHash (pre-this-feature peer) is treated as compatible, same discipline as `version`.
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
    // carry unacked input tail across reconnect or the local player jumps when the server resyncs
    const prevEngine = this._predEngine
    this._predEngine = new PredictionEngine(payload.tickRate || this._config.tickRate || 60)
    // seed from authoritative reconnect position/health to avoid an origin-teleport
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
    // NTP-style sample: t0=our echoed send time, t2=server's send-side clock
    // reading, t3=our receive time now. serverTime absent (pre-upgrade server
    // or the no-timestamp HEARTBEAT_ACK branch) simply skips the sample --
    // getOneWayDelay()/estimateAgeMs() stay at their prior/zero state.
    if (typeof payload.timestamp === 'number' && typeof payload.serverTime === 'number') {
      this._clockSync.addSample(payload.timestamp, payload.serverTime, t3)
    }
  }

  getPlayerId() { return this._playerId }
  getPredEngine() { return this._predEngine }
  getSmoothInterp() { return this._smoothInterp }
  // undefined = no handshake/reconnect completed yet (or peer predates this feature); true/false once one has.
  getStructMismatch() { return this._structMismatch }
  getClockSync() { return this._clockSync }

  getRTT() {
    return this._smoothInterp?.getRTT() || 0
  }

  // Real one-way-delay estimate from the NTP-style min-RTT estimator, replacing
  // the previous naive RTT/2-of-a-single-noisy-sample assumption wherever a
  // caller needs "how long did this message take to arrive" rather than the
  // full round trip.
  getOneWayDelay() {
    return this._clockSync.getOneWayDelay()
  }

  // Converts a raw client-clock send timestamp (e.g. sendFire's clientTime)
  // into an age-in-ms usable directly as LagCompensator's rewind amount,
  // accounting for real clock offset + drift instead of assuming the client
  // and server clocks read the same value.
  estimateMessageAgeMs(clientSendTime) {
    return this._clockSync.estimateAgeMs(clientSendTime)
  }

  getBufferHealth() {
    return this._smoothInterp?.getBufferHealth() || 0
  }

  // {rtt:{[playerId]:rttMs}, pubkeys:{[playerId]:wireweavePubkey}}, most recent MSG.PEER_RTT_TABLE
  // broadcast. See client/HostMigration.js.
  getPeerRttTable() { return this._peerRttTable }
}
