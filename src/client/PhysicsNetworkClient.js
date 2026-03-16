import { pack, unpack } from '../protocol/msgpack.js'
import { MSG } from '../protocol/MessageTypes.js'
import { ReconnectManager } from './ReconnectManager.js'
import { SnapshotProcessor } from './SnapshotProcessor.js'
import { MessageHandler } from './MessageHandler.js'

function createHeartbeatManager(isOpen, sendPing) {
  let timer = null, visibilityListener = null
  return {
    start() {
      this.stop()
      timer = setInterval(() => { if (isOpen()) sendPing() }, 1000)
      if (typeof document !== 'undefined' && !visibilityListener) {
        visibilityListener = () => { if (!document.hidden && isOpen()) sendPing() }
        document.addEventListener('visibilitychange', visibilityListener)
      }
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null }
      if (visibilityListener && typeof document !== 'undefined') { document.removeEventListener('visibilitychange', visibilityListener); visibilityListener = null }
    }
  }
}

function createWebSocketConnection(url, onOpen, onMessage, onClose) {
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  ws.onopen = onOpen
  ws.onmessage = event => onMessage(event.data)
  ws.onclose = onClose
  ws.onerror = () => {}
  return ws
}

export class PhysicsNetworkClient {
  constructor(config = {}) {
    this.config = { url: config.url || 'ws://localhost:3000/ws', tickRate: config.tickRate || 128, predictionEnabled: config.predictionEnabled !== false, smoothInterpolation: config.smoothInterpolation !== false, debug: config.debug || false, ...config }
    this.ws = null; this.connected = false; this.state = { players: [], entities: [] }
    this.lastSnapshotTick = 0; this.currentTick = 0; this._pingSent = 0; this._destroyed = false
    this.callbacks = { onConnect: config.onConnect || (() => {}), onDisconnect: config.onDisconnect || (() => {}), onPlayerJoined: config.onPlayerJoined || (() => {}), onPlayerLeft: config.onPlayerLeft || (() => {}), onEntityAdded: config.onEntityAdded || (() => {}), onEntityRemoved: config.onEntityRemoved || (() => {}), onSnapshot: config.onSnapshot || (() => {}), onRender: config.onRender || (() => {}), onStateUpdate: config.onStateUpdate || (() => {}), onWorldDef: config.onWorldDef || (() => {}), onAppModule: config.onAppModule || (() => {}), onAssetUpdate: config.onAssetUpdate || (() => {}), onAppEvent: config.onAppEvent || (() => {}), onHotReload: config.onHotReload || (() => {}), onEditorSelect: config.onEditorSelect || (() => {}), onMessage: config.onMessage || (() => {}) }
    this._reconnect = new ReconnectManager(config)
    this._snapProc = new SnapshotProcessor({ callbacks: this.callbacks })
    this._msgHandler = new MessageHandler({ ...config, callbacks: this.callbacks })
    this._heartbeat = createHeartbeatManager(() => this._isOpen(), () => { this._pingSent = Date.now(); this.ws.send(pack({ type: MSG.HEARTBEAT, payload: { timestamp: this._pingSent } })) })
  }

  get playerId() { return this._msgHandler.getPlayerId() }
  _isOpen() { return this.ws && this.ws.readyState === WebSocket.OPEN }

  async connect() {
    return new Promise(resolve => {
      let settled = false
      try {
        this.ws = createWebSocketConnection(this.config.url, () => { settled = true; this._onOpen(resolve) }, data => this.onMessage(data), () => this._onClose())
        this.ws.onerror = () => { if (!settled) { settled = true; resolve() } }
      } catch (e) { resolve() }
    })
  }

  _onOpen(resolve) { this.connected = true; this._heartbeat.start(); this._reconnect.sendReconnectMessage(this.ws); this._reconnect.onConnected(); this.callbacks.onConnect(); resolve?.() }
  _onClose() { this.connected = false; this._heartbeat.stop(); this.callbacks.onDisconnect(); this._reconnect.onDisconnected(() => this._doReconnect()) }

  _doReconnect() {
    try {
      this.ws = createWebSocketConnection(this.config.url, () => this._onOpen(null), data => this.onMessage(data), () => this._onClose())
    } catch (e) { this._reconnect.onDisconnected(() => this._doReconnect()) }
  }

  sendInput(input) {
    if (!this._isOpen()) return
    const predEngine = this._msgHandler.getPredEngine()
    if (this.config.predictionEnabled && predEngine) predEngine.addInput(input)
    this.ws.send(pack({ type: MSG.INPUT, payload: { input } }))
  }

  sendFire(data) { if (this._isOpen()) this.ws.send(pack({ type: MSG.APP_EVENT, payload: { type: 'fire', shooterId: this.playerId, clientTime: Date.now(), ...data } })) }
  sendReload() { if (this._isOpen()) this.ws.send(pack({ type: MSG.APP_EVENT, payload: { type: 'reload', playerId: this.playerId } })) }
  send(type, payload) { if (this._isOpen()) this.ws.send(pack({ type, payload })) }

  onMessage(data) {
    try {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data
      const msg = unpack(bytes)
      const result = this._msgHandler.handleMessage(msg.type, msg.payload || {}, this._snapProc)
      if (msg.type === MSG.HANDSHAKE_ACK && result?.sessionToken) this._reconnect.setSessionToken(result.sessionToken)
      else if (msg.type === MSG.RECONNECT_ACK && result?.sessionToken) this._reconnect.setSessionToken(result.sessionToken)
      else if (result?.invalidate) this._reconnect.invalidateSession()
      else if (result && (msg.type === MSG.SNAPSHOT || msg.type === MSG.STATE_CORRECTION || msg.type === MSG.STATE_RECOVERY)) this._onSnapshot(result)
    } catch (e) { console.error('[client] parse error:', e) }
  }

  _onSnapshot(data) {
    this.lastSnapshotTick = this.currentTick = data.tick || 0
    const snapshotForBuffer = this._snapProc.processSnapshot(data, this.currentTick)
    const smoothInterp = this._msgHandler.getSmoothInterp()
    if (smoothInterp) smoothInterp.addSnapshot(snapshotForBuffer)
    const predEngine = this._msgHandler.getPredEngine()
    if (this.playerId && this.config.predictionEnabled && predEngine) {
      const localState = this._snapProc.getPlayerState(this.playerId)
      if (localState) predEngine.onServerSnapshot({ players: [localState] }, this.currentTick)
    }
    this.state.players = Array.from(this._snapProc.getAllPlayerStates().values())
    this.state.entities = Array.from(this._snapProc.getAllEntities().values())
    this.callbacks.onSnapshot(data); this.callbacks.onStateUpdate(this.state)
  }

  getSmoothState(now) { const si = this._msgHandler.getSmoothInterp(); return si ? si.getDisplayState(now) : { players: this.state.players, entities: this.state.entities } }
  getRTT() { return this._msgHandler.getRTT() }
  getBufferHealth() { return this._msgHandler.getBufferHealth() }
  getLocalState() { const pred = this._msgHandler.getPredEngine(); return this.config.predictionEnabled && pred ? pred.localState : this._snapProc.getPlayerState(this.playerId) }
  getRemoteState(id) { return this._snapProc.getPlayerState(id) }
  getAllStates() { return this._snapProc.getAllPlayerStates() }
  getEntity(id) { return this._snapProc.getEntity(id) }
  getAllEntities() { return this._snapProc.getAllEntities() }
  disconnect() { this._destroyed = true; this._reconnect.clear(); this._heartbeat.stop(); if (this.ws) this.ws.close() }
}
