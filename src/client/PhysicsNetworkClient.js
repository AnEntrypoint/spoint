import { pack, unpack, ensurePacked, isPacked } from '../protocol/msgpack.js'
import { MSG, isUnreliable } from '../protocol/MessageTypes.js'
import { ReconnectManager } from './ReconnectManager.js'
import { BaseClient } from './BaseClient.js'
import { WebTransportClientTransport, isWebTransportSupported, deriveWebTransportUrl } from '../transport/WebTransportClientTransport.js'
import { WebSocketClientTransport } from '../transport/WebSocketClientTransport.js'
import { NetworkSimTransport, NETWORK_SIM_PRESETS } from '../transport/NetworkSimTransport.js'
import { TransportMigrationTrigger } from './TransportMigrationTrigger.js'

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

const WT_CONNECT_TIMEOUT_MS = 4000
const WT_FIRST_CONNECT_TIMEOUT_MS = 750
const WT_NEGATIVE_TTL_MS = 600000
const WT_CACHE_PREFIX = 'spoint.wt.'
const WT_ANNOUNCED_FAILURES = new Set()

function transportConnectError(reason, url, detail) {
  const err = new Error(`[transport] connect to ${url} failed: ${reason}${detail ? ` (${detail})` : ''}`)
  err.name = 'TransportConnectError'
  err.reason = reason
  err.url = url
  return err
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
    this._wtStatus = null
    this._wtCache = new Map()
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
      this._msgHandler.getTimeline().resync()
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
    else if (result?.invalidate) this._dropSessionAndReconnect()
  }

  _dropSessionAndReconnect() {
    this._reconnect.invalidateSession()
    const transport = this.transport
    const ws = this.ws
    if (transport) { try { transport.close() } catch (e) {} }
    if (ws && ws !== transport) { try { ws.close() } catch (e) {} }
    setTimeout(() => { if (!this._destroyed && !this._isOpen()) this._reconnect.onDisconnected(() => this._doReconnect()) }, 0)
  }

  async _followClusterHandoff(payload) {
    const url = payload?.url, token = payload?.sessionToken
    if (typeof url !== 'string' || typeof token !== 'string' || this._destroyed) return
    this.config.url = url
    this._reconnect.setSessionToken(token)
    this._reconnect.beginMigration()
    this._connGen++
    this._migrationTrigger?.stop()
    this._heartbeat.stop()
    const oldTransport = this.transport, oldWs = this.ws
    this.transport = null; this.ws = null; this.connected = false
    if (oldTransport) { try { oldTransport.close() } catch (e) {} }
    if (oldWs) { try { oldWs.close() } catch (e) {} }
    this.callbacks.onDisconnect()
    await this._doReconnect()
  }

  _wtCacheRead(key) {
    if (this._wtCache.has(key)) return this._wtCache.get(key)
    let entry = null
    try { if (typeof localStorage !== 'undefined') entry = JSON.parse(localStorage.getItem(key) || 'null') } catch (e) { entry = null }
    if (entry) this._wtCache.set(key, entry)
    return entry
  }

  _wtCacheWrite(key, entry) {
    const merged = { ...(this._wtCache.get(key) || {}), ...entry }
    this._wtCache.set(key, merged)
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(merged)) } catch (e) {}
  }

  _setWtStatus(status) {
    this._wtStatus = status
    if (typeof window !== 'undefined') window.__wtStatus = status
    if (!status.failure) return
    const key = status.url || status.failure
    if (WT_ANNOUNCED_FAILURES.has(key)) return
    WT_ANNOUNCED_FAILURES.add(key)
    if (typeof console === 'undefined') return
    const spent = status.elapsedMs == null ? '' : ` after ${status.elapsedMs} ms`
    const suffix = status.cachedSkip ? ' (cached from an earlier failure)' : ''
    const cause = status.supported === false
      ? 'this browser has no WebTransport constructor'
      : `${status.url || 'no url derived'}: ${status.failure}${spent}${suffix}`
    console.info(`[webtransport] ${cause} -- this session runs over WebSocket, so snapshots ride the ordered transport; give the server a webTransport config (cert, key, port 4433) to serve the datagram path instead`)
  }

  async _tryWebTransport(gen) {
    if (this._wtConfig.enabled === false) return false
    if (!isWebTransportSupported()) { this._setWtStatus({ supported: false, url: null, failure: 'browser-lacks-webtransport', transportType: 'websocket' }); return false }
    const wtUrl = this._wtConfig.url || deriveWebTransportUrl(this.config.url, this._wtConfig.port)
    if (!wtUrl) { this._setWtStatus({ supported: true, url: null, failure: 'no-url-derived' }); return false }
    const cacheKey = WT_CACHE_PREFIX + wtUrl
    const cached = this._wtCacheRead(cacheKey)
    if (cached && cached.failedUntil && cached.failedUntil > Date.now()) {
      this._setWtStatus({ supported: true, url: wtUrl, failure: cached.failure || 'handshake-failed', cachedSkip: true, transportType: 'websocket' })
      return false
    }
    const timeoutMs = this._wtConfig.connectTimeoutMs ?? (cached && cached.everConnected ? WT_CONNECT_TIMEOUT_MS : WT_FIRST_CONNECT_TIMEOUT_MS)
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
    this._setWtStatus({ supported: true, url: wtUrl, failure: null, timeoutMs, transportType: 'websocket' })
    try {
      const session = new WebTransport(wtUrl)
      const t = new WebTransportClientTransport(session)
      const ok = await t.connect(timeoutMs)
      if (ok && t.isOpen) this._wtCacheWrite(cacheKey, { everConnected: true, failedUntil: 0 })
      if (gen !== this._connGen) { try { t.close() } catch (e) {} return false }
      if (!ok || !t.isOpen) { try { t.close() } catch (e) {} this._wtFail(wtUrl, cacheKey, startedAt, timeoutMs, 'handshake-failed'); return false }
      this.transport = this._wrapNetSim(t)
      this._transportType = 'webtransport'
      this._setWtStatus({ supported: true, url: wtUrl, failure: null, timeoutMs, connected: true, transportType: 'webtransport' })
      this.transport.on('message', data => { if (gen !== this._connGen) return; this.onMessage(data) })
      this.transport.on('close', () => this._onClose(gen))
      return true
    } catch (e) {
      this._wtFail(wtUrl, cacheKey, startedAt, timeoutMs, (e && e.message) || 'connect-threw')
      return false
    }
  }

  _wtFail(wtUrl, cacheKey, startedAt, timeoutMs, failure) {
    const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt
    const inconclusive = elapsed >= timeoutMs * 0.8
    this._setWtStatus({ supported: true, url: wtUrl, failure, timeoutMs, elapsedMs: Math.round(elapsed), inconclusive, transportType: 'websocket' })
    if (!inconclusive) this._wtCacheWrite(cacheKey, { failure, failedUntil: Date.now() + WT_NEGATIVE_TTL_MS })
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
    await this._connectWebSocket(gen)
  }

  _connectWebSocket(gen) {
    return new Promise((resolve, reject) => {
      let settled = false
      const fail = (reason, detail) => {
        if (settled) return
        settled = true
        reject(transportConnectError(reason, this.config.url, detail))
      }
      const drop = () => { try { ws.close() } catch (e) {} }
      let ws
      try {
        ws = createWebSocketConnection(this.config.url, () => {}, () => {}, () => {})
      } catch (e) { fail('websocket-unavailable', e && e.message); return }
      this.ws = ws
      ws.onopen = () => {
        if (settled) { drop(); return }
        if (gen !== this._connGen) { drop(); fail('connect-superseded'); return }
        settled = true
        ws.onclose = () => this._onClose(gen)
        this._onOpen(null, gen)
        resolve()
      }
      ws.onerror = event => { if (!settled) fail('websocket-error', event && event.message) }
      ws.onclose = event => { if (!settled) fail('websocket-closed-before-open', event ? `close code ${event.code}` : null) }
      this._wireWebSocketMessages(ws, gen)
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
          this._setWtStatus({ supported: true, url: wtUrl, failure: null, transportType: this._transportType })
          try {
            const session = new WebTransport(wtUrl)
            const t = new WebTransportClientTransport(session)
            if (await t.connect(this._wtConfig.connectTimeoutMs ?? WT_CONNECT_TIMEOUT_MS)) candidate = t
            else this._setWtStatus({ supported: true, url: wtUrl, failure: 'handshake-failed', transportType: this._transportType })
          } catch (e) {
            this._setWtStatus({ supported: true, url: wtUrl, failure: (e && e.message) || 'connect-threw', transportType: this._transportType })
          }
        } else if (kind === 'webtransport') return 'unsupported'
      }
    }
    if (!candidate) {
      if (kind === 'webtransport') return 'unsupported'
      try { candidate = await this._openWebSocketCandidate() }
      catch (e) { return 'failed' }
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
    return new Promise((resolve, reject) => {
      try {
        const ws = new WebSocket(this.config.url)
        ws.binaryType = 'arraybuffer'
        const t = new WebSocketClientTransport(ws)
        if (t.isOpen) { resolve(t); return }
        const onOpen = () => { ws.removeEventListener('error', onError); resolve(t) }
        const onError = event => { ws.removeEventListener('open', onOpen); try { ws.close() } catch (e) {} reject(transportConnectError('websocket-candidate-error', this.config.url, event && event.message)) }
        ws.addEventListener('open', onOpen, { once: true })
        ws.addEventListener('error', onError, { once: true })
      } catch (e) { reject(transportConnectError('websocket-candidate-unavailable', this.config.url, e && e.message)) }
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

  sendInput(input, stepAt, periodMs) { if (this._isOpen()) super.sendInput(input, stepAt, periodMs) }

  send(type, payload) { this._safeSend(pack({ type, payload }), isUnreliable(type)) }

  getReconnectState() { return { state: this._reconnect._state, attempts: this._reconnect._attempts } }

  disconnect() { this._destroyed = true; this.stopInputLoop(); this._reconnect.clear(); this._heartbeat.stop(); this._migrationTrigger?.stop(); if (this.transport) this.transport.close(); if (this.ws) this.ws.close() }

  getTransportType() { return this._transportType }

  getWebTransportStatus() { return this._wtStatus ? { ...this._wtStatus, transportType: this._transportType } : null }

  getAutoMigrateStats() { return this._migrationTrigger?.getStats() || null }
}
