import { unpack } from '../protocol/msgpack.js'
import { MSG } from '../protocol/MessageTypes.js'
import { SnapshotProcessor } from './SnapshotProcessor.js'
import { MessageHandler } from './MessageHandler.js'

// Must mirror ConnectionManager.js's COALESCE_SENTINEL/frameCoalesced exactly: a leading 0xFF byte marks a
// coalesced frame (multiple per-tick sends folded into one socket.send()), followed by repeated
// [uint32 LE length][payload] records. Any other first byte is a single un-coalesced msgpack message
// (0xFF is never a valid opening byte for our top-level {type,payload} map value), so old/new servers and
// clients stay wire-compatible either way.
const COALESCE_SENTINEL = 0xff
const LEN_PREFIX_BYTES = 4

function splitCoalesced(bytes) {
  const out = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let off = 1
  while (off < bytes.length) {
    if (off + LEN_PREFIX_BYTES > bytes.length) break // truncated/corrupt tail -- stop rather than read garbage
    const len = view.getUint32(off, true); off += LEN_PREFIX_BYTES
    if (off + len > bytes.length) break
    out.push(bytes.subarray(off, off + len)); off += len
  }
  return out
}

export class BaseClient {
  constructor(config = {}) {
    // 60Hz default (was 128) -- mirrors the server's default; overwritten by the server's real tickRate on
    // HANDSHAKE_ACK/RECONNECT_ACK (see MessageHandler.js), this is only a pre-connect placeholder.
    this.config = { tickRate: config.tickRate || 60, predictionEnabled: config.predictionEnabled !== false, smoothInterpolation: config.smoothInterpolation !== false, debug: config.debug || false, ...config }
    this.connected = false
    this.state = { players: [], entities: [] }
    this.currentTick = 0
    this.lastSnapshotTick = 0
    this.dilationFactor = 1.0
    // Hand-maintained allowlist -- ANY caller-supplied config.onXxx callback not named here is silently
    // dropped (never copied onto this.callbacks, so MessageHandler.js's `this._callbacks.onXxx?.(payload)`
    // is a permanent, error-free no-op) -- the exact same rot mode already fixed once in this codebase for
    // Inspector.js's swallowed-debug-message range (see AGENTS.md). Root-caused live this session
    // (terrain-sculpt-ack-broadcast-not-reaching-client): client/app.js's _clientConfig correctly defines
    // onTerrainConfig/onTerrainSculptAck and the server-side broadcast genuinely fires (confirmed via a
    // real Worker-import bisection + live "[terrain] planet heightfield re-centered" log), but BOTH names
    // were missing here, so the ack (and terrain-reseed config push) never reached the client -- not a
    // netcode/broadcast bug at all. Keep this list in sync with every onXxx key client/app.js's
    // _clientConfig defines; a missing entry fails exactly this way (silent, no error, no warning).
    this.callbacks = { onConnect: config.onConnect || (() => {}), onDisconnect: config.onDisconnect || (() => {}), onPlayerJoined: config.onPlayerJoined || (() => {}), onPlayerLeft: config.onPlayerLeft || (() => {}), onEntityAdded: config.onEntityAdded || (() => {}), onEntityRemoved: config.onEntityRemoved || (() => {}), onSnapshot: config.onSnapshot || (() => {}), onRender: config.onRender || (() => {}), onStateUpdate: config.onStateUpdate || (() => {}), onWorldDef: config.onWorldDef || (() => {}), onAppModule: config.onAppModule || (() => {}), onAssetUpdate: config.onAssetUpdate || (() => {}), onAppEvent: config.onAppEvent || (() => {}), onHotReload: config.onHotReload || (() => {}), onEditorSelect: config.onEditorSelect || (() => {}), onMessage: config.onMessage || (() => {}), onDilation: config.onDilation || (() => {}), onMessageError: config.onMessageError || (() => {}), onPeerRttTable: config.onPeerRttTable || (() => {}), onTerrainConfig: config.onTerrainConfig || (() => {}), onTerrainSculptAck: config.onTerrainSculptAck || (() => {}), onTerrainPaintBiomeAck: config.onTerrainPaintBiomeAck || (() => {}), onGrassDecalSync: config.onGrassDecalSync || (() => {}), onTerrainSculptSync: config.onTerrainSculptSync || (() => {}), onTimeOfDaySync: config.onTimeOfDaySync || (() => {}), onWeatherSync: config.onWeatherSync || (() => {}) }
    this._snapProc = new SnapshotProcessor({ callbacks: this.callbacks })
    this._msgHandler = new MessageHandler({ ...config, callbacks: this.callbacks })
  }

  get playerId() { return this._msgHandler.getPlayerId() }

  onMessage(data) {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data
    // A coalesced server-side flush (ConnectionManager.flushAll) prefixes the frame with COALESCE_SENTINEL;
    // split it back into its constituent single-message buffers and process each exactly as before. Any
    // other leading byte is an ordinary, un-coalesced single message (unchanged fast path).
    if (bytes.length > 0 && bytes[0] === COALESCE_SENTINEL) {
      for (const part of splitCoalesced(bytes)) this._handleOneMessage(part)
      return
    }
    this._handleOneMessage(bytes)
  }

  _handleOneMessage(bytes) {
    // decode errors and handler errors are caught separately so a handler throw can't abort decoding the next message
    let msg
    try {
      msg = unpack(bytes)
    } catch (e) { console.error('[client] wire decode failed (corrupt message dropped):', e?.message || e); this.callbacks.onMessageError('decode', e); return }
    if (msg.type === MSG.NOSTR_AUTH_CHALLENGE) { this._handleNostrAuthChallenge(msg.payload || {}); return }
    try {
      const result = this._msgHandler.handleMessage(msg.type, msg.payload || {}, this._snapProc)
      this._handleSessionTokens(msg.type, result)
      if (result && (msg.type === MSG.SNAPSHOT || msg.type === MSG.STATE_CORRECTION || msg.type === MSG.STATE_RECOVERY)) this._onSnapshot(result, msg.type)
      if (msg.type === MSG.TICK_DILATION) { this.dilationFactor = msg.payload?.factor ?? 1.0; this.callbacks.onDilation(this.dilationFactor) }
    } catch (e) { console.error('[client] message handler failed (type ' + msg?.type + '):', e?.message || e); this.callbacks.onMessageError('handler', e, msg?.type) }
  }

  async _handleNostrAuthChallenge(payload) {
    if (payload.error) { console.error('[client] nostr auth failed:', payload.error); this.callbacks.onMessageError('nostrAuth', new Error(payload.error)); return }
    const challenge = payload.challenge
    if (!challenge) return
    try {
      const NostrTools = await import('nostr-tools')
      const storage = typeof localStorage !== 'undefined' ? localStorage : null
      const skHex = storage?.getItem('zn_sk')
      let sk = skHex ? Uint8Array.from(skHex.match(/.{2}/g).map(b => parseInt(b, 16))) : null
      if (!sk) {
        sk = NostrTools.generateSecretKey()
        storage?.setItem('zn_sk', Array.from(sk).map(b => b.toString(16).padStart(2, '0')).join(''))
        storage?.setItem('zn_pk', NostrTools.getPublicKey(sk))
      }
      const pubkey = NostrTools.getPublicKey(sk)
      const event = NostrTools.finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [], content: challenge }, sk)
      this.send(MSG.NOSTR_AUTH_RESPONSE, { pubkey, sig: event.sig, id: event.id, created_at: event.created_at, kind: event.kind, tags: event.tags })
    } catch (e) { console.error('[client] nostr auth challenge response failed:', e?.message || e); this.callbacks.onMessageError('nostrAuth', e) }
  }

  _handleSessionTokens(type, result) {}

  _onSnapshot(data, msgType) {
    // reject out-of-order SNAPSHOT (reordered packet) to avoid overwriting fresh state; STATE_CORRECTION/RECOVERY exempt (legitimately can carry an older tick)
    const incomingTick = data.tick || 0
    if (msgType === MSG.SNAPSHOT && this.lastSnapshotTick && incomingTick < this.lastSnapshotTick) return
    this.lastSnapshotTick = this.currentTick = incomingTick
    const snapshotForBuffer = this._snapProc.processSnapshot(data, this.currentTick)
    const smoothInterp = this._msgHandler.getSmoothInterp()
    if (smoothInterp) smoothInterp.addSnapshot(snapshotForBuffer)
    const predEngine = this._msgHandler.getPredEngine()
    if (this.playerId && this.config.predictionEnabled && predEngine) {
      const localState = this._snapProc.getPlayerState(this.playerId)
      if (localState) predEngine.onServerSnapshot({ players: [localState] }, this.currentTick)
    }
    const pArr = this.state.players; pArr.length = 0
    for (const v of this._snapProc.getAllPlayerStates().values()) pArr.push(v)
    const eArr = this.state.entities; eArr.length = 0
    for (const v of this._snapProc.getAllEntities().values()) eArr.push(v)
    // Player-LOD DOT-tier crowd aggregate (see SnapshotProcessor.js/SnapshotEncoder.js buildCrowdDots):
    // passed straight through onto this.state so app.js's onStateUpdate (and thus tickPlayerAnimators'
    // playerLOD.tick call) can reach it. Present only on snapshots the server actually tiered; absent
    // (undefined) is the normal case for a non-tiered/legacy snapshot, and callers already treat an
    // absent/empty dots as "use the client-side fallback aggregation" (see PlayerLOD.js installPlayerLOD).
    this.state.dots = snapshotForBuffer.dots
    this.callbacks.onSnapshot(data)
    // onStateUpdate can throw (render work); uncaught it wedges the loading screen on the first snapshot, so catch+drop this frame rather than re-invoke
    try { this.callbacks.onStateUpdate(this.state) }
    catch (e) { console.error('[client] onStateUpdate failed:', e?.message || e); this.callbacks.onMessageError('stateUpdate', e) }
  }

  // clientTime is expressed in ESTIMATED SERVER CLOCK time (raw Date.now() +
  // the NTP-style clock offset), not raw local wall clock -- the server can
  // then compute latencyMs as a real one-way network-delay estimate
  // (serverNow - clientTime) instead of conflating unsynced client/server
  // clock skew with actual travel time.
  sendFire(data) {
    const cs = this._msgHandler.getClockSync?.()
    const clientTime = cs ? cs.getEstimatedServerTime() : Date.now()
    this.send(MSG.APP_EVENT, { type: 'fire', shooterId: this.playerId, clientTime, ...data })
  }
  sendReload() { this.send(MSG.APP_EVENT, { type: 'reload', playerId: this.playerId }) }
  sendLaunch(data) { this.send(MSG.APP_EVENT, { type: 'launch', senderId: this.playerId, ...data }) }
  sendEmote(code) { this.send(MSG.APP_EVENT, { type: 'emote', senderId: this.playerId, code }) }

  getSmoothState(now) { const si = this._msgHandler.getSmoothInterp(); return si ? si.getDisplayState(now) : this.state }
  getRTT() { return this._msgHandler.getRTT() }
  getOneWayDelay() { return this._msgHandler.getOneWayDelay?.() || 0 }
  // {[playerId]: rttMs}, server-measured, broadcast ~1Hz. See client/HostMigration.js.
  getPeerRttTable() { return this._msgHandler.getPeerRttTable?.() || {} }
  getBufferHealth() { return this._msgHandler.getBufferHealth() }
  getLocalState() { const pred = this._msgHandler.getPredEngine(); return this.config.predictionEnabled && pred ? pred.localState : this._snapProc.getPlayerState(this.playerId) }
  // display-only smoothed state for the local player; logic/aim/spawn must keep using getLocalState
  getRenderState() { const pred = this._msgHandler.getPredEngine(); return this.config.predictionEnabled && pred ? (pred.getRenderState() || pred.localState) : this.getLocalState() }
  getRemoteState(id) { return this._snapProc.getPlayerState(id) }
  getAllStates() { return this._snapProc.getAllPlayerStates() }
  getEntity(id) { return this._snapProc.getEntity(id) }
  getAllEntities() { return this._snapProc.getAllEntities() }
}
