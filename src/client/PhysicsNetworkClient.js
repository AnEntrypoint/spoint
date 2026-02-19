import { PredictionEngine } from './PredictionEngine.js'
import { SmoothInterpolation } from './SmoothInterpolation.js'
import { pack, unpack } from '../protocol/msgpack.js'
import { MSG } from '../protocol/MessageTypes.js'

export class PhysicsNetworkClient {
  constructor(config = {}) {
    this.config = { url: config.url || 'ws://localhost:3000/ws', tickRate: config.tickRate || 128, predictionEnabled: config.predictionEnabled !== false, smoothInterpolation: config.smoothInterpolation !== false, debug: config.debug || false, ...config }
    this.ws = null
    this.playerId = null
    this.connected = false
    this._predEngine = null
    this._smoothInterp = null
    this._playerStates = new Map()
    this._entityStates = new Map()
    this.lastSnapshotTick = 0
    this.currentTick = 0
    this.state = { players: [], entities: [] }
    this.heartbeatTimer = null
    this._sessionToken = null
    this._reconnectAttempts = 0
    this._reconnectTimer = null
    this._reconnecting = false
    this._maxReconnectDelay = 5000
    this._destroyed = false
    this._pingSent = 0
    this._visibilityListener = null
    this.callbacks = {
      onConnect: config.onConnect || (() => {}),
      onDisconnect: config.onDisconnect || (() => {}),
      onPlayerJoined: config.onPlayerJoined || (() => {}),
      onPlayerLeft: config.onPlayerLeft || (() => {}),
      onEntityAdded: config.onEntityAdded || (() => {}),
      onEntityRemoved: config.onEntityRemoved || (() => {}),
      onSnapshot: config.onSnapshot || (() => {}),
      onRender: config.onRender || (() => {}),
      onStateUpdate: config.onStateUpdate || (() => {}),
      onWorldDef: config.onWorldDef || (() => {}),
      onAppModule: config.onAppModule || (() => {}),
      onAssetUpdate: config.onAssetUpdate || (() => {}),
      onAppEvent: config.onAppEvent || (() => {}),
      onHotReload: config.onHotReload || (() => {})
    }
  }

  async connect() {
    return new Promise((resolve, reject) => {
      let settled = false
      try {
        this.ws = new WebSocket(this.config.url)
        this.ws.binaryType = 'arraybuffer'
        this.ws.onopen = () => { settled = true; this._onOpen(resolve) }
        this.ws.onmessage = (event) => this.onMessage(event.data)
        this.ws.onclose = () => this._onClose()
        this.ws.onerror = (error) => { if (!settled) { settled = true; resolve() }  }
      } catch (error) { resolve() }
    })
  }

  _onOpen(resolve) {
    this.connected = true
    this._reconnectAttempts = 0
    this._startHeartbeat()
    if (this._sessionToken && this._reconnecting) {
      this.ws.send(pack({ type: MSG.RECONNECT, payload: { sessionToken: this._sessionToken } }))
    }
    this._reconnecting = false
    this.callbacks.onConnect()
    if (resolve) resolve()
  }

  _onClose() {
    this.connected = false
    this._stopHeartbeat()
    this.callbacks.onDisconnect()
    this._scheduleReconnect()
  }

  _onError(error, reject) {
    if (reject) reject(error)
  }

  _scheduleReconnect() {
    if (this._destroyed) return
    if (this._reconnectTimer) return
    const delay = Math.min(1000 * Math.pow(1.5, this._reconnectAttempts), this._maxReconnectDelay)
    this._reconnectAttempts++
    this._reconnecting = true
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      if (this._destroyed) return
      this._doReconnect()
    }, delay)
  }

  _doReconnect() {
    try {
      this.ws = new WebSocket(this.config.url)
      this.ws.binaryType = 'arraybuffer'
      this.ws.onopen = () => this._onOpen(null)
      this.ws.onmessage = (event) => this.onMessage(event.data)
      this.ws.onclose = () => this._onClose()
      this.ws.onerror = () => {}
    } catch (e) {
      this._scheduleReconnect()
    }
  }

  sendInput(input) {
    if (!this._isOpen()) return
    if (this.config.predictionEnabled && this._predEngine) this._predEngine.addInput(input)
    this.ws.send(pack({ type: MSG.INPUT, payload: { input } }))
  }

  sendFire(data) {
    if (!this._isOpen()) return
    this.ws.send(pack({ type: MSG.APP_EVENT, payload: { type: 'fire', shooterId: this.playerId, ...data } }))
  }

  sendReload() {
    if (!this._isOpen()) return
    this.ws.send(pack({ type: MSG.APP_EVENT, payload: { type: 'reload', playerId: this.playerId } }))
  }

  _isOpen() { return this.ws && this.ws.readyState === WebSocket.OPEN }

  onMessage(data) {
    try {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data
      const msg = unpack(bytes)
      this._handleMessage(msg.type, msg.payload || {})
    } catch (e) { console.error('[client] parse error:', e) }
  }

  _handleMessage(type, payload) {
    if (type === MSG.HANDSHAKE_ACK) {
      this.playerId = payload.playerId
      this.currentTick = payload.tick
      if (payload.sessionToken) this._sessionToken = payload.sessionToken
      this._predEngine = new PredictionEngine(this.config.tickRate)
      this._predEngine.init(this.playerId)
      if (this.config.smoothInterpolation) {
        this._smoothInterp = new SmoothInterpolation({ predictionEnabled: this.config.predictionEnabled })
        this._smoothInterp.setLocalPlayer(this.playerId)
      }
    } else if (type === MSG.RECONNECT_ACK) {
      const oldPlayerId = this.playerId
      this.playerId = payload.playerId
      this.currentTick = payload.tick
      if (payload.sessionToken) this._sessionToken = payload.sessionToken
      if (oldPlayerId && oldPlayerId !== this.playerId) {
        this._playerStates.delete(oldPlayerId)
        if (this._smoothInterp) this._smoothInterp.removePlayer(oldPlayerId)
        this.callbacks.onPlayerLeft(oldPlayerId)
      }
      if (!this._predEngine) {
        this._predEngine = new PredictionEngine(this.config.tickRate)
        this._predEngine.init(this.playerId)
      }
      if (this.config.smoothInterpolation && !this._smoothInterp) {
        this._smoothInterp = new SmoothInterpolation({ predictionEnabled: this.config.predictionEnabled })
        this._smoothInterp.setLocalPlayer(this.playerId)
      }
    } else if (type === MSG.STATE_RECOVERY) {
      if (payload.snapshot) this._onSnapshot(payload.snapshot)
    } else if (type === MSG.DISCONNECT_REASON) {
      if (payload.code === 4) {
        this._sessionToken = null
        this._reconnecting = false
      }
    } else if (type === MSG.SNAPSHOT || type === MSG.STATE_CORRECTION) {
      this._onSnapshot(payload)
} else if (type === MSG.PLAYER_LEAVE) {
      this._playerStates.delete(payload.playerId)
      if (this._smoothInterp) this._smoothInterp.removePlayer(payload.playerId)
      this.callbacks.onPlayerLeft(payload.playerId)
    } else if (type === MSG.WORLD_DEF) {
      if (payload.movement && this._predEngine) this._predEngine.setMovement(payload.movement)
      if (payload.gravity && this._predEngine) this._predEngine.setGravity(payload.gravity)
      this.callbacks.onWorldDef?.(payload)
    } else if (type === MSG.APP_EVENT) {
      this.callbacks.onAppEvent?.(payload)
    } else if (type === MSG.HOT_RELOAD || type === MSG.APP_MODULE || type === MSG.ASSET_UPDATE) {
      const cb = { [MSG.HOT_RELOAD]: 'onHotReload', [MSG.APP_MODULE]: 'onAppModule', [MSG.ASSET_UPDATE]: 'onAssetUpdate' }[type]
      this.callbacks[cb]?.(payload)
    } else if (type === MSG.HEARTBEAT_ACK) {
      const pongTime = Date.now()
      const pingTime = this._pingSent
      this._pingSent = 0
      if (pingTime > 0 && this._smoothInterp) {
        this._smoothInterp.updateRTT(pingTime, pongTime)
      }
    }
  }

  _onSnapshot(data) {
    this.lastSnapshotTick = this.currentTick = data.tick || 0

    const snapshotForBuffer = {
      tick: data.tick || 0,
      timestamp: data.timestamp || Date.now(),
      players: [],
      entities: []
    }

    const seenPlayers = new Set()
    for (const p of data.players || []) {
      const { playerId, state } = this._parsePlayer(p)
      seenPlayers.add(playerId)
      if (!this._playerStates.has(playerId)) this.callbacks.onPlayerJoined(playerId, state)
      this._playerStates.set(playerId, state)
      snapshotForBuffer.players.push(state)
      if (playerId === this.playerId && this.config.predictionEnabled && this._predEngine) {
        this._predEngine.onServerSnapshot({ players: [state] }, this.currentTick)
      }
    }

    for (const playerId of this._playerStates.keys()) {
      if (!seenPlayers.has(playerId)) {
        this._playerStates.delete(playerId)
        if (this._smoothInterp) this._smoothInterp.removePlayer(playerId)
        this.callbacks.onPlayerLeft(playerId)
      }
    }

    if (data.delta) {
      for (const e of data.entities || []) {
        const { entityId, state } = this._parseEntity(e)
        if (!this._entityStates.has(entityId)) this.callbacks.onEntityAdded(entityId, state)
        this._entityStates.set(entityId, state)
        snapshotForBuffer.entities.push(state)
      }
      if (data.removed) {
        for (const eid of data.removed) {
          if (this._entityStates.has(eid)) { this._entityStates.delete(eid); this.callbacks.onEntityRemoved(eid) }
        }
      }
    } else {
      const seen = new Set()
      for (const e of data.entities || []) {
        const { entityId, state } = this._parseEntity(e)
        seen.add(entityId)
        if (!this._entityStates.has(entityId)) this.callbacks.onEntityAdded(entityId, state)
        this._entityStates.set(entityId, state)
        snapshotForBuffer.entities.push(state)
      }
      for (const eid of this._entityStates.keys()) {
        if (!seen.has(eid)) { this._entityStates.delete(eid); this.callbacks.onEntityRemoved(eid) }
      }
    }

    if (this._smoothInterp) {
      this._smoothInterp.addSnapshot(snapshotForBuffer)
    }

    this.state.players = Array.from(this._playerStates.values())
    this.state.entities = Array.from(this._entityStates.values())
    this.callbacks.onSnapshot(data)
    this.callbacks.onStateUpdate(this.state)
    this._render()
  }

  _parsePlayer(p) {
    if (Array.isArray(p)) return { playerId: p[0], state: { id: p[0], position: [p[1], p[2], p[3]], rotation: [p[4], p[5], p[6], p[7]], velocity: [p[8], p[9], p[10]], onGround: p[11] === 1, health: p[12], inputSequence: p[13], crouch: p[14] || 0, lookPitch: (p[15] || 0) / 255 * 2 * Math.PI - Math.PI, lookYaw: (p[16] || 0) / 255 * 2 * Math.PI } }
    return { playerId: p.id || p.i, state: { id: p.id || p.i, position: p.position || [0, 0, 0], rotation: p.rotation || [0, 0, 0, 1], velocity: p.velocity || [0, 0, 0], onGround: p.onGround ?? false, health: p.health ?? 100 } }
  }

  _parseEntity(e) {
    if (Array.isArray(e)) return { entityId: e[0], state: { id: e[0], model: e[1], position: [e[2], e[3], e[4]], rotation: [e[5], e[6], e[7], e[8]], bodyType: e[9], custom: e[10] } }
    return { entityId: e.id, state: { id: e.id, model: e.model, position: e.position || [0, 0, 0], rotation: e.rotation || [0, 0, 0, 1], bodyType: e.bodyType || 'static', custom: e.custom || null } }
  }

  _render() {
    const displayStates = new Map()
    
    if (this._smoothInterp) {
      const smoothState = this._smoothInterp.getDisplayState()
      for (const p of smoothState.players) {
        displayStates.set(p.id, p)
      }
    } else {
      for (const [playerId, serverState] of this._playerStates) {
        displayStates.set(playerId, playerId === this.playerId && this.config.predictionEnabled && this._predEngine ? this._predEngine.getDisplayState(this.currentTick, 0) : serverState)
      }
    }
    this.callbacks.onRender(displayStates)
  }
  
  getSmoothState() {
    if (this._smoothInterp) {
      return this._smoothInterp.getDisplayState()
    }
    return { players: this.state.players, entities: this.state.entities }
  }
  
  getRTT() {
    return this._smoothInterp?.getRTT() || 0
  }
  
  getBufferHealth() {
    return this._smoothInterp?.getBufferHealth() || 0
  }

  getLocalState() {
    return this.config.predictionEnabled && this._predEngine ? this._predEngine.localState : this._playerStates.get(this.playerId)
  }

  getRemoteState(playerId) { return this._playerStates.get(playerId) }
  getAllStates() { return new Map(this._playerStates) }
  getEntity(entityId) { return this._entityStates.get(entityId) }
  getAllEntities() { return new Map(this._entityStates) }

  disconnect() {
    this._destroyed = true
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null }
    this._stopHeartbeat()
    if (this.ws) this.ws.close()
  }

  _startHeartbeat() {
    this._stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this._isOpen()) {
        this._pingSent = Date.now()
        this.ws.send(pack({ type: MSG.HEARTBEAT, payload: { timestamp: this._pingSent } }))
      }
    }, 1000)
    if (typeof document !== 'undefined' && !this._visibilityListener) {
      this._visibilityListener = () => {
        if (!document.hidden && this._isOpen()) {
          this._pingSent = Date.now()
          this.ws.send(pack({ type: MSG.HEARTBEAT, payload: { timestamp: this._pingSent } }))
        }
      }
      document.addEventListener('visibilitychange', this._visibilityListener)
    }
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
    if (this._visibilityListener && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._visibilityListener)
      this._visibilityListener = null
    }
  }
}
