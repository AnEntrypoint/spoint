import { pack, unpack, ensurePacked, isPacked } from '../protocol/msgpack.js'
import { MSG, isUnreliable } from '../protocol/MessageTypes.js'
import { ReconnectManager } from './ReconnectManager.js'
import { BaseClient } from './BaseClient.js'
import { WebTransportClientTransport, isWebTransportSupported, deriveWebTransportUrl } from '../transport/WebTransportClientTransport.js'
import { WebSocketClientTransport } from '../transport/WebSocketClientTransport.js'
import { NetworkSimTransport, NETWORK_SIM_PRESETS } from '../transport/NetworkSimTransport.js'
import { TransportMigrationTrigger } from './TransportMigrationTrigger.js'

const REDUNDANT_INPUT_COUNT = 4

function createHeartbeatManager(isOpen, sendPing, onVisible) {
  let timer = null, visibilityListener = null
  return {
    start() {
      this.stop()
      timer = setInterval(() => { if (isOpen()) sendPing() }, 1000)
      if (typeof document !== 'undefined' && !visibilityListener) {
        visibilityListener = () => { if (!document.hidden && isOpen()) { sendPing(); onVisible?.() } }
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
  ws.onerror = () => { onClose && onClose() }
  return ws
}

export class PhysicsNetworkClient extends BaseClient {
  constructor(config = {}) {
    super({ url: config.url || 'ws://localhost:3000/ws', ...config })
    this.ws = null
    this.transport = null
    this._transportType = 'websocket'
    this._wtConfig = config.webTransport || {}
    this._netSimConfig = config.netSim || null
    this._netSim = null
    this._autoMigrateConfig = config.autoMigrate
    this._migrationTrigger = this._autoMigrateConfig === false ? null : new TransportMigrationTrigger(this, typeof this._autoMigrateConfig === 'object' ? this._autoMigrateConfig : {})
    this._pingSent = 0
    this._destroyed = false
    this._connGen = 0
    this._reconnect = new ReconnectManager(config)
    const isOpenAndPackrReady = () => this._isOpen() && isPacked()
    this._heartbeat = createHeartbeatManager(isOpenAndPackrReady, () => {
      this._pingSent = Date.now()
      try { this._rawSend(pack({ type: MSG.HEARTBEAT, payload: { timestamp: this._pingSent } })) }
      catch (e) { this._onClose() }
    }, () => {
      const smoothInterp = this._msgHandler.getSmoothInterp()
      smoothInterp?.resyncToLatest()
    })
  }

  _isOpen() {
    if (this.transport) return this.transport.isOpen
    return this.ws && this.ws.readyState === WebSocket.OPEN
  }

  _resolveNetSimProfile() {
    const cfg = this._netSimConfig
    if (!cfg) return null
    if (typeof cfg === 'string') return NETWORK_SIM_PRESETS[cfg] || null
    return cfg
  }

  _wrapNetSim(t) {
    const profile = this._resolveNetSimProfile()
    if (!profile) { this._netSim = null; return t }
    const sim = new NetworkSimTransport(t, profile)
    this._netSim = sim
    if (typeof window !== 'undefined') window.__netSim = sim
    return sim
  }

  _rawSend(buf, unreliable) {
    if (this.transport) {
      const ok = unreliable ? this.transport.sendUnreliable(buf) : this.transport.send(buf)
      if (!ok) throw new Error('transport send failed')
      return
    }
    this.ws.send(buf)
  }

  _safeSend(buf, unreliable) {
    if (!this._isOpen()) return false
    try { this._rawSend(buf, unreliable); return true }
    catch (e) { this._onClose(); return false }
  }

  _handleSessionTokens(type, result) {
    if (type === MSG.HANDSHAKE_ACK && result?.sessionToken) this._reconnect.setSessionToken(result.sessionToken)
    else if (type === MSG.RECONNECT_ACK && result?.sessionToken) this._reconnect.setSessionToken(result.sessionToken)
    else if (result?.invalidate) this._reconnect.invalidateSession()
  }

  async _tryWebTransport(gen) {
    if (this._wtConfig.enabled === false) return false
    if (!isWebTransportSupported()) return false
    const wtUrl = this._wtConfig.url || deriveWebTransportUrl(this.config.url, this._wtConfig.port)
    if (!wtUrl) return false
    try {
      const session = new WebTransport(wtUrl)
      const t = new WebTransportClientTransport(session)
      const ok = await t.connect()
      if (gen !== this._connGen) { try { t.close() } catch (e) {} return false }
      if (!ok || !t.isOpen) return false
      this.transport = this._wrapNetSim(t)
      this._transportType = 'webtransport'
      this.transport.on('message', data => { if (gen !== this._connGen) return; this.onMessage(data) })
      this.transport.on('close', () => this._onClose(gen))
      return true
    } catch (e) {
      return false
    }
  }

  _wireWebSocketMessages(ws, gen) {
    const profile = this._resolveNetSimProfile()
    if (!profile) {
      ws.onmessage = event => { if (gen !== this._connGen) return; this.onMessage(event.data) }
      return
    }
    const raw = new WebSocketClientTransport(ws)
    const sim = this._wrapNetSim(raw)
    this.transport = sim
    sim.on('message', data => { if (gen !== this._connGen) return; this.onMessage(data) })
  }

  async connect() {
    await ensurePacked
    const gen = ++this._connGen
    if (await this._tryWebTransport(gen)) {
      if (gen !== this._connGen) return
      this._onOpen(null, gen)
      return
    }
    this._transportType = 'websocket'
    return new Promise(resolve => {
      let settled = false
      try {
        this.ws = createWebSocketConnection(this.config.url, () => { settled = true; this._onOpen(resolve, gen) }, () => {}, () => this._onClose(gen))
        this._wireWebSocketMessages(this.ws, gen)
        const ws = this.ws
        ws.onerror = () => { if (gen !== this._connGen) return; if (!settled) { settled = true; resolve() } }
      } catch (e) { resolve() }
    })
  }

  _onOpen(resolve, gen) { if (gen !== this._connGen) return; this.connected = true; this._heartbeat.start(); this._migrationTrigger?.start(); if (this.ws) this._reconnect.sendReconnectMessage(this.ws); this._reconnect.onConnected(); this.callbacks.onConnect(); resolve?.() }
  _onClose(gen) { if (gen !== this._connGen) return; this.connected = false; this.transport = null; this._netSim = null; this._heartbeat.stop(); this._migrationTrigger?.stop(); this.callbacks.onDisconnect(); this._reconnect.onDisconnected(() => this._doReconnect()) }

  async _doReconnect() {
    const gen = ++this._connGen
    if (await this._tryWebTransport(gen)) {
      if (gen !== this._connGen) return
      this._onOpen(null, gen)
      return
    }
    try {
      this.ws = createWebSocketConnection(this.config.url, () => this._onOpen(null, gen), () => {}, () => this._onClose(gen))
      this._wireWebSocketMessages(this.ws, gen)
    } catch (e) { this._reconnect.onDisconnected(() => this._doReconnect()) }
  }

  async migrateTransport(kind) {
    if (this._destroyed || !this._isOpen() || !this._reconnect._token) return 'failed'
    const gen = this._connGen
    let candidate
    const wantWebTransportCandidate = this._wtConfig.enabled !== false && (kind === 'webtransport' || (kind == null && this._transportType !== 'webtransport'))
    if (wantWebTransportCandidate) {
      if (!isWebTransportSupported()) { if (kind === 'webtransport') return 'unsupported' }
      else {
        const wtUrl = this._wtConfig.url || deriveWebTransportUrl(this.config.url, this._wtConfig.port)
        if (wtUrl) {
          try {
            const session = new WebTransport(wtUrl)
            const t = new WebTransportClientTransport(session)
            if (await t.connect()) candidate = t
          } catch (e) { }
        } else if (kind === 'webtransport') return 'unsupported'
      }
    }
    if (!candidate) {
      if (kind === 'webtransport') return 'unsupported'
      candidate = await this._openWebSocketCandidate()
      if (!candidate) return 'failed'
    }
    if (gen !== this._connGen) { try { candidate.close() } catch (e) {} return 'failed' }
    const ok = await this._confirmMigration(candidate)
    if (!ok) { try { candidate.close() } catch (e) {} return 'failed' }
    if (gen !== this._connGen) { try { candidate.close() } catch (e) {} return 'failed' }
    this._swapToMigratedTransport(candidate)
    return 'migrated'
  }

  _openWebSocketCandidate() {
    return new Promise(resolve => {
      try {
        const ws = new WebSocket(this.config.url)
        ws.binaryType = 'arraybuffer'
        const t = new WebSocketClientTransport(ws)
        if (t.isOpen) { resolve(t); return }
        const onOpen = () => { ws.removeEventListener('error', onError); resolve(t) }
        const onError = () => { ws.removeEventListener('open', onOpen); resolve(null) }
        ws.addEventListener('open', onOpen, { once: true })
        ws.addEventListener('error', onError, { once: true })
      } catch (e) { resolve(null) }
    })
  }

  _confirmMigration(candidate, timeoutMs = 4000) {
    return new Promise(resolve => {
      let done = false
      const finish = ok => { if (done) return; done = true; clearTimeout(timer); candidate.off('message', onMessage); candidate.off('close', onClose); resolve(ok) }
      const onMessage = data => {
        let msg
        try { msg = unpack(data) } catch (e) { return }
        if (msg?.type !== MSG.MIGRATE_ACK) return
        finish(!!msg.payload?.ok)
      }
      const onClose = () => finish(false)
      candidate.on('message', onMessage)
      candidate.on('close', onClose)
      const timer = setTimeout(() => finish(false), timeoutMs)
      const sent = candidate.send(pack({ type: MSG.MIGRATE, payload: { sessionToken: this._reconnect._token } }))
      if (!sent) finish(false)
    })
  }

  _swapToMigratedTransport(candidate) {
    const gen = ++this._connGen
    const oldTransport = this.transport
    const oldWs = this.ws
    this.transport = this._wrapNetSim(candidate)
    this._transportType = candidate.type
    this.ws = null
    this.transport.on('message', data => { if (gen !== this._connGen) return; this.onMessage(data) })
    this.transport.on('close', () => this._onClose(gen))
    if (oldTransport) { try { oldTransport.close() } catch (e) {} }
    if (oldWs) { try { oldWs.close() } catch (e) {} }
  }

  sendInput(input) {
    if (!this._isOpen()) return
    const predEngine = this._msgHandler.getPredEngine()
    let sequence, redundant
    if (this.config.predictionEnabled && predEngine) {
      sequence = predEngine.addInput(input)
      redundant = predEngine.getUnackedInputs(REDUNDANT_INPUT_COUNT)
    } else {
      sequence = (this._localInputSeq = (this._localInputSeq || 0) + 1)
    }
    this._safeSend(pack({ type: MSG.INPUT, payload: { input, sequence, redundant } }), isUnreliable(MSG.INPUT))
  }

  send(type, payload) { this._safeSend(pack({ type, payload }), isUnreliable(type)) }

  getReconnectState() { return { state: this._reconnect._state, attempts: this._reconnect._attempts } }

  disconnect() { this._destroyed = true; this._reconnect.clear(); this._heartbeat.stop(); this._migrationTrigger?.stop(); if (this.transport) this.transport.close(); if (this.ws) this.ws.close() }

  getTransportType() { return this._transportType }

  getAutoMigrateStats() { return this._migrationTrigger?.getStats() || null }
}
