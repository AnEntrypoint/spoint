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
        // Tab regains visibility: re-ping for a fresh RTT sample AND resync the jitter buffer -- while
        // hidden, rAF stops driving getDisplayState but addSnapshot keeps accumulating every incoming
        // snapshot (the WebSocket onmessage handler is not throttled by visibility), so the buffer can
        // hold a long stale backlog by the time the tab comes back. onVisible drops it and snaps to
        // the latest snapshot instead of replaying the whole hidden-period backlog frame by frame.
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
  // spec doesn't guarantee onclose fires after onerror; treat error as close so reconnect always fires
  ws.onerror = () => { onClose && onClose() }
  return ws
}

export class PhysicsNetworkClient extends BaseClient {
  constructor(config = {}) {
    super({ url: config.url || 'ws://localhost:3000/ws', ...config })
    this.ws = null
    // Non-null only when the active connection is WebTransport (WebTransportClientTransport instance);
    // this.ws stays the WebSocket handle for the fallback path so existing callers reading `.ws` directly
    // (getReconnectState-adjacent debug code, tests) keep working unchanged when WebSocket is in use.
    this.transport = null
    this._transportType = 'websocket'
    // webTransport opt-out/config: { enabled: false } to force WebSocket-only, or { port } to override the
    // default 4433 WebTransport listener port. Defaults to auto-negotiate (enabled unless explicitly false).
    this._wtConfig = config.webTransport || {}
    // netSim: opt-in transport-simulation harness (dev tool -- see NetworkSimTransport.js). A preset name
    // string (see NETWORK_SIM_PRESETS) or a raw {lossPct,latencyMs,jitterMs,reorderPct} profile, applied
    // uniformly whichever real transport (WebSocket or WebTransport) wins negotiation. Omitted/falsy =>
    // zero behavior change from pre-sim-harness code (this.transport stays null on the WS path exactly
    // as before, this.ws drives everything directly). window.__netSim mirrors the live instance so a
    // profile can be retuned mid-connection without reconnecting (RenderControls-style live knob).
    this._netSimConfig = config.netSim || null
    this._netSim = null // the live NetworkSimTransport instance, when active
    // Automatic network-condition-driven migration trigger (navigator.connection change + RTT-spike
    // detector), see TransportMigrationTrigger.js. Opt-out via `autoMigrate: false` (defaults on -- a
    // silent, self-healing background behavior, matching the auto-negotiate default for WebTransport
    // itself). Started/stopped alongside the connection lifecycle in _onOpen/_onClose/disconnect below.
    this._autoMigrateConfig = config.autoMigrate
    this._migrationTrigger = this._autoMigrateConfig === false ? null : new TransportMigrationTrigger(this, typeof this._autoMigrateConfig === 'object' ? this._autoMigrateConfig : {})
    this._pingSent = 0
    this._destroyed = false
    // monotonic gen so a stale socket's late onclose/onerror can't fire against a newer, healthy connection
    this._connGen = 0
    this._reconnect = new ReconnectManager(config)
    // Gate on Packr-ready as well as socket-open: they are INDEPENDENT conditions.
    // The socket can open before the async Packr resolve completes, and pack()
    // deliberately throws rather than mis-encoding -- so a heartbeat firing in that
    // window threw an uncaught error during cold load on a slower CI machine.
    // Skipping the tick is correct here; the next one a second later succeeds.
    this._heartbeat = createHeartbeatManager(() => this._isOpen() && isPacked(), () => {
      this._pingSent = Date.now()
      // TOCTOU: socket can flip OPEN->CLOSING between isOpen() and send; treat a failed ping as a close
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

  // Resolves this._netSimConfig (preset name string or raw profile) to a NetworkSimTransport profile, or
  // null when sim mode isn't requested -- kept a pure resolver so both the WebTransport and WebSocket
  // negotiation paths share one profile-lookup instead of duplicating the preset-vs-raw-object branch.
  _resolveNetSimProfile() {
    const cfg = this._netSimConfig
    if (!cfg) return null
    if (typeof cfg === 'string') return NETWORK_SIM_PRESETS[cfg] || null
    return cfg
  }

  // Wraps an already-connected real TransportWrapper in NetworkSimTransport when a profile is configured,
  // else returns it unwrapped -- single call site for both the WebTransport and WebSocket negotiation
  // paths so sim-mode coverage never silently misses one transport. Stashes the live NetworkSimTransport
  // on this._netSim (and window.__netSim in a browser context) so a dev console can retune the profile
  // (`window.__netSim.configure({latencyMs:300})`) or inspect drop/reorder counts (`.getStats()`) without
  // reconnecting.
  _wrapNetSim(t) {
    const profile = this._resolveNetSimProfile()
    if (!profile) { this._netSim = null; return t }
    const sim = new NetworkSimTransport(t, profile)
    this._netSim = sim
    if (typeof window !== 'undefined') window.__netSim = sim
    return sim
  }

  // Raw send bypassing the open-check (heartbeat already checks isOpen via the outer closure); throws
  // propagate to the caller's own try/catch, matching pre-WebTransport behavior where this.ws.send threw.
  // `unreliable` routes through the transport's datagram path when available (WebTransport only --
  // WebSocketTransport.js's own sendUnreliable already degrades to a plain reliable send, so the
  // WebSocket branch here is unaffected either way, matching server-side ConnectionManager symmetry).
  _rawSend(buf, unreliable) {
    if (this.transport) {
      const ok = unreliable ? this.transport.sendUnreliable(buf) : this.transport.send(buf)
      if (!ok) throw new Error('transport send failed')
      return
    }
    this.ws.send(buf)
  }

  // TOCTOU guard: a throw on send must not propagate into the render loop
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

  // Auto-negotiate: WebTransport is the primary path when the real browser API exists AND the caller
  // hasn't opted out (`webTransport: { enabled: false }`) -- feature-detected via
  // isWebTransportSupported(), never assumed. On any failure (unsupported, no listener at the derived
  // URL, handshake/session error, thrown exception) this falls through to the existing WebSocket path
  // unconditionally -- WebSocket remains the always-available baseline transport.
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

  // Wires a just-created WebSocket's inbound message flow to `onMessage`, through NetworkSimTransport when
  // a profile is configured. this.ws stays the raw socket handle in BOTH cases (readyState-based _isOpen
  // fallback and _reconnect.sendReconnectMessage(this.ws) need it directly regardless of sim mode) --
  // only the delivery/send routing differs: sim mode additionally builds this.transport (a
  // WebSocketClientTransport wrapped in NetworkSimTransport) so _rawSend()'s existing `if (this.transport)`
  // branch takes over sending, and onMessage delivery goes through the sim's delayed 'message' re-emit
  // instead of the socket's own onmessage firing straight into onMessage.
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
    // ws.onclose/onerror already drive _onClose via createWebSocketConnection; NetworkSimTransport mirrors
    // the wrapped transport's own close forwarding, no separate listener needed here.
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
    // Reconnect re-runs the same negotiation every attempt: a WebTransport listener/network condition can
    // change between attempts (e.g. transient outage on one path, not the other), so pinning to whichever
    // transport won the first race would strand a client that could recover on the other path.
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

  // Live connection migration: opens a SECOND transport candidate while the current one stays fully live,
  // verifies it round-trips a real MIGRATE_ACK carrying the same session, THEN atomically swaps -- unlike
  // _doReconnect (which only runs after the active transport is already gone, tearing down and
  // recreating PredictionEngine/SmoothInterpolation/snapshot state), a successful migration touches NONE
  // of that: this.transport/this.ws are re-pointed in place, the in-flight snapshot/prediction state is
  // left completely untouched, and the OLD transport is closed only after the swap succeeds. Returns
  // 'migrated' | 'unsupported' | 'failed' (never throws) so a caller (e.g. a network-condition watcher)
  // can decide whether to fall back to a full reconnect. `kind`: 'webtransport' to explicitly target a
  // fresh WebTransport session (typical wifi->cellular / WS->WT upgrade case), or omitted to open a fresh
  // WebSocket candidate against the same url (still a real hand-off, useful for exercising a network path
  // change on a deployment with no WebTransport listener).
  async migrateTransport(kind) {
    if (this._destroyed || !this._isOpen() || !this._reconnect._token) return 'failed'
    const gen = this._connGen // captured, not bumped -- a migration must not race/invalidate the live generation until it actually wins
    let candidate
    // Same opt-out this._wtConfig.enabled===false honors in _tryWebTransport/connect() -- migrateTransport
    // must not silently attempt (and fail-through from) a WebTransport candidate when the caller has
    // explicitly disabled it, even for the auto (kind==null) path.
    if (this._wtConfig.enabled !== false && (kind === 'webtransport' || (kind == null && this._transportType !== 'webtransport'))) {
      if (!isWebTransportSupported()) { if (kind === 'webtransport') return 'unsupported' }
      else {
        const wtUrl = this._wtConfig.url || deriveWebTransportUrl(this.config.url, this._wtConfig.port)
        if (wtUrl) {
          try {
            const session = new WebTransport(wtUrl)
            const t = new WebTransportClientTransport(session)
            if (await t.connect()) candidate = t
          } catch (e) { /* fall through to WebSocket candidate below */ }
        } else if (kind === 'webtransport') return 'unsupported'
      }
    }
    if (!candidate) {
      if (kind === 'webtransport') return 'unsupported'
      candidate = await this._openWebSocketCandidate()
      if (!candidate) return 'failed'
    }
    if (gen !== this._connGen) { try { candidate.close() } catch (e) {} return 'failed' } // superseded by a real reconnect/migration while the candidate was opening
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

  // Sends MIGRATE directly on the candidate (bypassing _rawSend, which targets the CURRENT active
  // transport) and waits for MIGRATE_ACK on that SAME candidate only -- the candidate is not wired into
  // the normal onMessage pipe until this resolves true, so a stray non-ack message on it can't be
  // misrouted into game state before the swap is confirmed. Bounded by a real timeout: an ACK that never
  // arrives (candidate accepted the socket but the server-side session lookup hangs/never responds) must
  // not leave the caller awaiting forever.
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

  // The atomic part: re-point this.transport/this.ws/this._transportType onto the confirmed candidate,
  // wire its 'message'/'close' into the SAME onMessage/_onClose paths every other transport uses (so
  // TICK_DILATION/onSnapshot/etc keep flowing through identical code), bump _connGen so the OLD
  // transport's own close (fired next) is recognized as an intentional retirement rather than a real
  // disconnect (_onClose/onerror check `gen !== this._connGen` and no-op), then close the old transport.
  // PredictionEngine/SmoothInterpolation/SnapshotProcessor are deliberately NOT touched -- that is the
  // entire point of migration over reconnect.
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
      // re-carry unacked inputs so one dropped packet doesn't cost a server tick; server dedupes by sequence
      redundant = predEngine.getUnackedInputs(4)
    } else {
      sequence = (this._localInputSeq = (this._localInputSeq || 0) + 1)
    }
    this._safeSend(pack({ type: MSG.INPUT, payload: { input, sequence, redundant } }), isUnreliable(MSG.INPUT))
  }

  send(type, payload) { this._safeSend(pack({ type, payload }), isUnreliable(type)) }

  // Exposes the ReconnectManager's xstate value/attempts for a UI layer (reconnect banner) to
  // drive off of, without leaking the actor itself. 'connected' | 'waiting' | 'reconnecting' | 'destroyed'.
  getReconnectState() { return { state: this._reconnect._state, attempts: this._reconnect._attempts } }

  disconnect() { this._destroyed = true; this._reconnect.clear(); this._heartbeat.stop(); this._migrationTrigger?.stop(); if (this.transport) this.transport.close(); if (this.ws) this.ws.close() }

  // Exposes which transport actually won negotiation ('webtransport' | 'websocket') -- a debug/UI surface
  // (e.g. a connection-quality indicator), not consumed internally.
  getTransportType() { return this._transportType }

  // Exposes the automatic migration trigger's live diagnostics (attempts/cooldown/lastResult) for a UI/debug
  // surface, matching getReconnectState()'s pattern. null when autoMigrate:false opted out entirely.
  getAutoMigrateStats() { return this._migrationTrigger?.getStats() || null }
}
