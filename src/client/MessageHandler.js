import { PredictionEngine } from './PredictionEngine.js'
import { SmoothInterpolation } from './SmoothInterpolation.js'
import { MSG } from '../protocol/MessageTypes.js'

export class MessageHandler {
  constructor(config = {}) {
    this._config = config
    this._predEngine = null
    this._smoothInterp = null
    this._playerId = null
    this._currentTick = 0
    this._callbacks = config.callbacks || {}
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
      this._callbacks.onWorldDef?.(payload)
    } else if (type === MSG.APP_EVENT) {
      this._callbacks.onAppEvent?.(payload)
    } else if (type === MSG.HOT_RELOAD || type === MSG.APP_MODULE || type === MSG.ASSET_UPDATE) {
      const cb = { [MSG.HOT_RELOAD]: 'onHotReload', [MSG.APP_MODULE]: 'onAppModule', [MSG.ASSET_UPDATE]: 'onAssetUpdate' }[type]
      this._callbacks[cb]?.(payload)
    } else if (type === MSG.HEARTBEAT_ACK) {
      this._handleHeartbeat(payload)
    }
  }

  _handleHandshake(payload) {
    this._playerId = payload.playerId
    this._currentTick = payload.tick
    this._predEngine = new PredictionEngine(this._config.tickRate || 128)
    this._predEngine.init(this._playerId)
    if (this._config.smoothInterpolation !== false) {
      this._smoothInterp = new SmoothInterpolation({ predictionEnabled: this._config.predictionEnabled !== false })
      this._smoothInterp.setLocalPlayer(this._playerId)
    }
    return { sessionToken: payload.sessionToken }
  }

  _handleReconnect(payload, snapProc) {
    const oldPlayerId = this._playerId
    this._playerId = payload.playerId
    this._currentTick = payload.tick
    if (oldPlayerId && oldPlayerId !== this._playerId) {
      snapProc?.removePlayer(oldPlayerId)
      if (this._smoothInterp) this._smoothInterp.removePlayer(oldPlayerId)
      this._callbacks.onPlayerLeft?.(oldPlayerId)
    }
    if (!this._predEngine) {
      this._predEngine = new PredictionEngine(this._config.tickRate || 128)
      this._predEngine.init(this._playerId)
    }
    if (this._config.smoothInterpolation !== false && !this._smoothInterp) {
      this._smoothInterp = new SmoothInterpolation({ predictionEnabled: this._config.predictionEnabled !== false })
      this._smoothInterp.setLocalPlayer(this._playerId)
    }
    return { sessionToken: payload.sessionToken }
  }

  _handleHeartbeat(payload) {
    if (this._smoothInterp) {
      this._smoothInterp.updateRTT(payload.timestamp || 0, Date.now())
    }
  }

  getPlayerId() { return this._playerId }
  getCurrentTick() { return this._currentTick }
  setCurrentTick(tick) { this._currentTick = tick }
  getPredEngine() { return this._predEngine }
  getSmoothInterp() { return this._smoothInterp }

  getDisplayState(tick) {
    if (this._smoothInterp) {
      return this._smoothInterp.getDisplayState()
    }
    return { players: [], entities: [] }
  }

  getRTT() {
    return this._smoothInterp?.getRTT() || 0
  }

  getBufferHealth() {
    return this._smoothInterp?.getBufferHealth() || 0
  }
}
