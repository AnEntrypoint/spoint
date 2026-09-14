import { unpack } from '../protocol/msgpack.js'
import { MSG } from '../protocol/MessageTypes.js'
import { SnapshotProcessor } from './SnapshotProcessor.js'
import { MessageHandler } from './MessageHandler.js'

const COALESCE_SENTINEL = 0xff
const LEN_PREFIX_BYTES = 4
const PRE_HANDSHAKE_TICK_RATE = 60

function splitCoalesced(bytes) {
  const out = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let off = 1
  while (off < bytes.length) {
    if (off + LEN_PREFIX_BYTES > bytes.length) break
    const len = view.getUint32(off, true); off += LEN_PREFIX_BYTES
    if (off + len > bytes.length) break
    out.push(bytes.subarray(off, off + len)); off += len
  }
  return out
}

export class BaseClient {
  constructor(config = {}) {
    this.config = { tickRate: config.tickRate || PRE_HANDSHAKE_TICK_RATE, predictionEnabled: config.predictionEnabled !== false, smoothInterpolation: config.smoothInterpolation !== false, debug: config.debug || false, ...config }
    this.connected = false
    this.state = { players: [], entities: [] }
    this.currentTick = 0
    this.lastSnapshotTick = 0
    this.dilationFactor = 1.0
    this.callbacks = { onConnect: config.onConnect || (() => {}), onDisconnect: config.onDisconnect || (() => {}), onPlayerJoined: config.onPlayerJoined || (() => {}), onPlayerLeft: config.onPlayerLeft || (() => {}), onEntityAdded: config.onEntityAdded || (() => {}), onEntityRemoved: config.onEntityRemoved || (() => {}), onSnapshot: config.onSnapshot || (() => {}), onRender: config.onRender || (() => {}), onStateUpdate: config.onStateUpdate || (() => {}), onWorldDef: config.onWorldDef || (() => {}), onAppModule: config.onAppModule || (() => {}), onAssetUpdate: config.onAssetUpdate || (() => {}), onAppEvent: config.onAppEvent || (() => {}), onHotReload: config.onHotReload || (() => {}), onEditorSelect: config.onEditorSelect || (() => {}), onMessage: config.onMessage || (() => {}), onDilation: config.onDilation || (() => {}), onMessageError: config.onMessageError || (() => {}), onPeerRttTable: config.onPeerRttTable || (() => {}), onTerrainConfig: config.onTerrainConfig || (() => {}), onTerrainSculptAck: config.onTerrainSculptAck || (() => {}), onTerrainPaintBiomeAck: config.onTerrainPaintBiomeAck || (() => {}), onGrassDecalSync: config.onGrassDecalSync || (() => {}), onTerrainSculptSync: config.onTerrainSculptSync || (() => {}), onTimeOfDaySync: config.onTimeOfDaySync || (() => {}), onWeatherSync: config.onWeatherSync || (() => {}) }
    this._snapProc = new SnapshotProcessor({ callbacks: this.callbacks })
    this._msgHandler = new MessageHandler({ ...config, callbacks: this.callbacks })
  }

  get playerId() { return this._msgHandler.getPlayerId() }

  onMessage(data) {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data
    if (bytes.length > 0 && bytes[0] === COALESCE_SENTINEL) {
      for (const part of splitCoalesced(bytes)) this._handleOneMessage(part)
      return
    }
    this._handleOneMessage(bytes)
  }

  _handleOneMessage(bytes) {
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
    const incomingTick = data.tick || 0
    const isReorderedSnapshot = msgType === MSG.SNAPSHOT && this.lastSnapshotTick && incomingTick < this.lastSnapshotTick
    if (isReorderedSnapshot) return
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
    this.state.dots = snapshotForBuffer.dots
    this.callbacks.onSnapshot(data)
    try { this.callbacks.onStateUpdate(this.state) }
    catch (e) { console.error('[client] onStateUpdate failed:', e?.message || e); this.callbacks.onMessageError('stateUpdate', e) }
  }

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
  getPeerRttTable() { return this._msgHandler.getPeerRttTable?.() || {} }
  getBufferHealth() { return this._msgHandler.getBufferHealth() }
  getLocalState() { const pred = this._msgHandler.getPredEngine(); return this.config.predictionEnabled && pred ? pred.localState : this._snapProc.getPlayerState(this.playerId) }
  getRenderState() { const pred = this._msgHandler.getPredEngine(); return this.config.predictionEnabled && pred ? (pred.getRenderState() || pred.localState) : this.getLocalState() }
  getRemoteState(id) { return this._snapProc.getPlayerState(id) }
  getAllStates() { return this._snapProc.getAllPlayerStates() }
  getEntity(id) { return this._snapProc.getEntity(id) }
  getAllEntities() { return this._snapProc.getAllEntities() }
}
