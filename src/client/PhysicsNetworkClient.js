import { PredictionEngine } from './PredictionEngine.js'
import { pack, unpack } from '../protocol/msgpack.js'
import { MSG } from '../protocol/MessageTypes.js'

export class PhysicsNetworkClient {
  constructor(config = {}) {
    this.config = { url: config.url || 'ws://localhost:8080/ws', tickRate: config.tickRate || 128, predictionEnabled: config.predictionEnabled !== false, debug: config.debug || false, ...config }
    this.ws = null
    this.playerId = null
    this.connected = false
    this._predEngine = null
    this._playerStates = new Map()
    this._entityStates = new Map()
    this.lastSnapshotTick = 0
    this.currentTick = 0
    this.state = { players: [], entities: [] }
    this.heartbeatTimer = null
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
      onAppEvent: config.onAppEvent || (() => {})
    }
  }

  async connect() {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.config.url)
        this.ws.binaryType = 'arraybuffer'
        this.ws.onopen = () => this._onOpen(resolve)
        this.ws.onmessage = (event) => this.onMessage(event.data)
        this.ws.onclose = () => this._onClose()
        this.ws.onerror = (error) => this._onError(error, reject)
      } catch (error) { reject(error) }
    })
  }

  _onOpen(resolve) {
    this.connected = true
    this._startHeartbeat()
    this.callbacks.onConnect()
    resolve()
  }

  _onClose() {
    this.connected = false
    this._stopHeartbeat()
    this.callbacks.onDisconnect()
  }

  _onError(error, reject) { reject(error) }

  sendInput(input) {
    if (!this._isOpen()) return
    if (this.config.predictionEnabled && this._predEngine) this._predEngine.addInput(input)
    this.ws.send(pack({ type: MSG.INPUT, payload: { input } }))
  }

  sendFire(data) {
    if (!this._isOpen()) return
    this.ws.send(pack({ type: MSG.APP_EVENT, payload: { type: 'fire', shooterId: this.playerId, ...data } }))
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
      this._predEngine = new PredictionEngine(this.config.tickRate)
      this._predEngine.init(this.playerId)
    } else if (type === MSG.SNAPSHOT || type === MSG.STATE_CORRECTION) {
      this._onSnapshot(payload)
    } else if (type === MSG.PLAYER_LEAVE) {
      this._playerStates.delete(payload.playerId)
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
    }
  }

  _onSnapshot(data) {
    this.lastSnapshotTick = this.currentTick = data.tick || 0
    for (const p of data.players || []) {
      const { playerId, state } = this._parsePlayer(p)
      if (!this._playerStates.has(playerId)) this.callbacks.onPlayerJoined(playerId, state)
      this._playerStates.set(playerId, state)
      if (playerId === this.playerId && this.config.predictionEnabled && this._predEngine) {
        this._predEngine.onServerSnapshot({ players: [state] }, this.currentTick)
      }
    }
    for (const e of data.entities || []) {
      const { entityId, state } = this._parseEntity(e)
      if (!this._entityStates.has(entityId)) this.callbacks.onEntityAdded(entityId, state)
      this._entityStates.set(entityId, state)
    }
    this.state.players = Array.from(this._playerStates.values())
    this.state.entities = Array.from(this._entityStates.values())
    this.callbacks.onSnapshot(data)
    this.callbacks.onStateUpdate(this.state)
    this._render()
  }

  _parsePlayer(p) {
    if (Array.isArray(p)) return { playerId: p[0], state: { id: p[0], position: [p[1], p[2], p[3]], rotation: [p[4], p[5], p[6], p[7]], velocity: [p[8], p[9], p[10]], onGround: p[11] === 1, health: p[12], inputSequence: p[13] } }
    return { playerId: p.id || p.i, state: { id: p.id || p.i, position: p.position || [0, 0, 0], rotation: p.rotation || [0, 0, 0, 1], velocity: p.velocity || [0, 0, 0], onGround: p.onGround ?? false, health: p.health ?? 100 } }
  }

  _parseEntity(e) {
    if (Array.isArray(e)) return { entityId: e[0], state: { id: e[0], model: e[1], position: [e[2], e[3], e[4]], rotation: [e[5], e[6], e[7], e[8]], bodyType: e[9], custom: e[10] } }
    return { entityId: e.id, state: { id: e.id, model: e.model, position: e.position || [0, 0, 0], rotation: e.rotation || [0, 0, 0, 1], bodyType: e.bodyType || 'static', custom: e.custom || null } }
  }

  _render() {
    const displayStates = new Map()
    for (const [playerId, serverState] of this._playerStates) {
      displayStates.set(playerId, playerId === this.playerId && this.config.predictionEnabled && this._predEngine ? this._predEngine.getDisplayState(this.currentTick, 0) : serverState)
    }
    this.callbacks.onRender(displayStates)
  }

  getLocalState() {
    return this.config.predictionEnabled && this._predEngine ? this._predEngine.localState : this._playerStates.get(this.playerId)
  }

  getRemoteState(playerId) { return this._playerStates.get(playerId) }
  getAllStates() { return new Map(this._playerStates) }
  getEntity(entityId) { return this._entityStates.get(entityId) }
  getAllEntities() { return new Map(this._entityStates) }

  disconnect() {
    this._stopHeartbeat()
    if (this.ws) this.ws.close()
  }

  _startHeartbeat() {
    this._stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this._isOpen()) this.ws.send(pack({ type: MSG.HEARTBEAT, payload: {} }))
    }, 1000)
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
  }
}
