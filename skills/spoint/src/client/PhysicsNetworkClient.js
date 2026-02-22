import { pack, unpack } from '../protocol/msgpack.js'
import { MSG } from '../protocol/MessageTypes.js'
import { ReconnectManager } from './ReconnectManager.js'
import { SnapshotProcessor } from './SnapshotProcessor.js'
import { MessageHandler } from './MessageHandler.js'

export class PhysicsNetworkClient {
  constructor(config = {}) {
    this.config = { url: config.url || 'ws://localhost:3000/ws', tickRate: config.tickRate || 128, predictionEnabled: config.predictionEnabled !== false, smoothInterpolation: config.smoothInterpolation !== false, debug: config.debug || false, ...config }
    this.ws = null
    this.connected = false
    this.state = { players: [], entities: [] }
    this.lastSnapshotTick = 0
    this.currentTick = 0
    this._pingSent = 0
    this.heartbeatTimer = null
    this._destroyed = false
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
    this._reconnect = new ReconnectManager(config)
    this._snapProc = new SnapshotProcessor({ callbacks: this.callbacks })
    this._msgHandler = new MessageHandler({ ...config, callbacks: this.callbacks })
  }

  get playerId() { return this._msgHandler.getPlayerId() }

  async connect() {
    return new Promise((resolve) => {
      let settled = false
      try {
        this.ws = new WebSocket(this.config.url)
        this.ws.binaryType = 'arraybuffer'
        this.ws.onopen = () => { settled = true; this._onOpen(resolve) }
        this.ws.onmessage = (event) => this.onMessage(event.data)
        this.ws.onclose = () => this._onClose()
        this.ws.onerror = () => { if (!settled) { settled = true; resolve() } }
      } catch (e) { resolve() }
    })
  }

  _onOpen(resolve) {
    this.connected = true
    this._startHeartbeat()
    this._reconnect.sendReconnectMessage(this.ws)
    this._reconnect.onConnected()
    this.callbacks.onConnect()
    resolve?.()
  }

  _onClose() {
    this.connected = false
    this._stopHeartbeat()
    this.callbacks.onDisconnect()
    this._reconnect.onDisconnected(() => this._doReconnect())
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
      this._reconnect.onDisconnected(() => this._doReconnect())
    }
  }

  sendInput(input) {
    if (!this._isOpen()) return
    const predEngine = this._msgHandler.getPredEngine()
    if (this.config.predictionEnabled && predEngine) predEngine.addInput(input)
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

  _isOpen() {
    return this.ws && this.ws.readyState === WebSocket.OPEN
  }

  onMessage(data) {
    try {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data
      const msg = unpack(bytes)
      this._handleMessage(msg.type, msg.payload || {})
    } catch (e) {
      console.error('[client] parse error:', e)
    }
  }

  _handleMessage(type, payload) {
    const result = this._msgHandler.handleMessage(type, payload, this._snapProc)
    if (type === MSG.HANDSHAKE_ACK && result?.sessionToken) {
      this._reconnect.setSessionToken(result.sessionToken)
    } else if (type === MSG.RECONNECT_ACK && result?.sessionToken) {
      this._reconnect.setSessionToken(result.sessionToken)
    } else if (result?.invalidate) {
      this._reconnect.invalidateSession()
    } else if (result && (type === MSG.SNAPSHOT || type === MSG.STATE_CORRECTION || type === MSG.STATE_RECOVERY)) {
      this._onSnapshot(result)
    }
  }

  _onSnapshot(data) {
    this.lastSnapshotTick = this.currentTick = data.tick || 0
    const snapshotForBuffer = this._snapProc.processSnapshot(data, this.currentTick)
    const smoothInterp = this._msgHandler.getSmoothInterp()
    if (smoothInterp) {
      smoothInterp.addSnapshot(snapshotForBuffer)
    }
    const predEngine = this._msgHandler.getPredEngine()
    if (this.playerId && this.config.predictionEnabled && predEngine) {
      const localState = this._snapProc.getPlayerState(this.playerId)
      if (localState) {
        predEngine.onServerSnapshot({ players: [localState] }, this.currentTick)
      }
    }
    this.state.players = Array.from(this._snapProc.getAllPlayerStates().values())
    this.state.entities = Array.from(this._snapProc.getAllEntities().values())
    this.callbacks.onSnapshot(data)
    this.callbacks.onStateUpdate(this.state)
    this._render()
  }

  _render() {
    const displayStates = new Map()
    const smoothInterp = this._msgHandler.getSmoothInterp()
    if (smoothInterp) {
      const smoothState = smoothInterp.getDisplayState()
      for (const p of smoothState.players) {
        displayStates.set(p.id, p)
      }
    } else {
      const predEngine = this._msgHandler.getPredEngine()
      for (const [playerId, serverState] of this._snapProc.getAllPlayerStates()) {
        if (playerId === this.playerId && this.config.predictionEnabled && predEngine) {
          displayStates.set(playerId, predEngine.getDisplayState(this.currentTick, 0))
        } else {
          displayStates.set(playerId, serverState)
        }
      }
    }
    this.callbacks.onRender(displayStates)
  }

  getSmoothState() {
    const smoothInterp = this._msgHandler.getSmoothInterp()
    if (smoothInterp) {
      return smoothInterp.getDisplayState()
    }
    return { players: this.state.players, entities: this.state.entities }
  }

  getRTT() {
    return this._msgHandler.getRTT()
  }

  getBufferHealth() {
    return this._msgHandler.getBufferHealth()
  }

  getLocalState() {
    const predEngine = this._msgHandler.getPredEngine()
    return this.config.predictionEnabled && predEngine ? predEngine.localState : this._snapProc.getPlayerState(this.playerId)
  }

  getRemoteState(playerId) {
    return this._snapProc.getPlayerState(playerId)
  }

  getAllStates() {
    return this._snapProc.getAllPlayerStates()
  }

  getEntity(entityId) {
    return this._snapProc.getEntity(entityId)
  }

  getAllEntities() {
    return this._snapProc.getAllEntities()
  }

  disconnect() {
    this._destroyed = true
    this._reconnect.clear()
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
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this._visibilityListener && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._visibilityListener)
      this._visibilityListener = null
    }
  }
}
