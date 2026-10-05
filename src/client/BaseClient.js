import { unpack } from '../protocol/msgpack.js'
import { MSG } from '../protocol/MessageTypes.js'
import { SnapshotProcessor } from './SnapshotProcessor.js'
import { MessageHandler } from './MessageHandler.js'
import { createInputStepper } from './InputStepper.js'
import { encodeInputPacket, quantizeInput } from '../protocol/InputCodec.js'
import { createChartEpochSync } from './ChartEpochSync.js'

const REDUNDANT_INPUT_RECORDS = 4
const INPUT_BUFFER_MIN_DEPTH = 1
const INPUT_BUFFER_MAX_DEPTH = 6
const JITTER_COVER = 2
const JITTER_EMA_ALPHA = 0.05
const INPUT_DEPTH_EMA_ALPHA = 0.1
const INPUT_RATE_GAIN = 0.02
const INPUT_RATE_MAX_ADJUST = 0.04

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
    this.callbacks = { onConnect: config.onConnect || (() => {}), onDisconnect: config.onDisconnect || (() => {}), onPlayerJoined: config.onPlayerJoined || (() => {}), onPlayerLeft: config.onPlayerLeft || (() => {}), onEntityAdded: config.onEntityAdded || (() => {}), onEntityRemoved: config.onEntityRemoved || (() => {}), onSnapshot: config.onSnapshot || (() => {}), onRender: config.onRender || (() => {}), onStateUpdate: config.onStateUpdate || (() => {}), onWorldDef: config.onWorldDef || (() => {}), onAppModule: config.onAppModule || (() => {}), onAssetUpdate: config.onAssetUpdate || (() => {}), onAppEvent: config.onAppEvent || (() => {}), onHotReload: config.onHotReload || (() => {}), onEditorSelect: config.onEditorSelect || (() => {}), onMessage: config.onMessage || (() => {}), onDilation: config.onDilation || (() => {}), onMessageError: config.onMessageError || (() => {}), onPeerRttTable: config.onPeerRttTable || (() => {}), onTerrainConfig: config.onTerrainConfig || (() => {}), onTerrainSculptAck: config.onTerrainSculptAck || (() => {}), onTerrainPaintBiomeAck: config.onTerrainPaintBiomeAck || (() => {}), onGrassDecalSync: config.onGrassDecalSync || (() => {}), onTerrainSculptSync: config.onTerrainSculptSync || (() => {}), onTimeOfDaySync: config.onTimeOfDaySync || (() => {}), onWeatherSync: config.onWeatherSync || (() => {}), onTeleportAck: (p) => { config.onTeleportAck?.(p); this._settleTeleportAck(p) }, onChartReanchoring: config.onChartReanchoring || (() => {}), onChartReanchor: config.onChartReanchor || (() => {}), onChartResync: config.onChartResync || (() => {}) }
    this._teleportWaiters = new Map()
    this._inputStepper = null
    this._inputRateAdjust = 0
    this._inputDepthEma = -1
    this._arrivalJitterMs = 0
    this._lastSnapArrival = 0
    this._lastSnapTick = 0
    this._plainInputSeq = 1
    this._plainInputs = []
    this.protocolRejected = null
    this._groundSurface = typeof config.predictionGroundSurface === 'function' ? config.predictionGroundSurface : null
    this._teleportReqSeq = 0
    this._snapProc = new SnapshotProcessor({ callbacks: this.callbacks })
    this._msgHandler = new MessageHandler({ ...config, callbacks: this.callbacks })
    this._chart = createChartEpochSync({
      callbacks: this.callbacks,
      holders: () => ({ pred: this._msgHandler.getPredEngine(), timeline: this._msgHandler.getTimeline(), snapProc: this._snapProc, mirror: this._msgHandler.getCollisionMirror() }),
      requestResync: epoch => this.send(MSG.CHART_REANCHOR, { epoch }),
      replayAck: ack => this._msgHandler.handleMessage(MSG.TELEPORT_ACK, ack, this._snapProc)
    })
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
      if (msg.type === MSG.CHART_REANCHOR) { this._chart.onBroadcast(msg.payload); return }
      let payload = msg.payload || {}
      if (msg.type === MSG.TELEPORT_ACK) { payload = this._chart.admitAck(payload); if (!payload) return }
      const result = this._msgHandler.handleMessage(msg.type, payload, this._snapProc)
      if (result?.protocolMismatch) { this._rejectProtocol(result.protocolMismatch); return }
      if (msg.type === MSG.HANDSHAKE_ACK || msg.type === MSG.RECONNECT_ACK) this._chart.adopt(msg.payload)
      if (result && msg.type === MSG.SNAPSHOT && !this._chart.admitSnapshot(result)) return
      if ((msg.type === MSG.HANDSHAKE_ACK || msg.type === MSG.RECONNECT_ACK) && this._groundSurface) this._msgHandler.getPredEngine()?.setGroundSurface(this._groundSurface)
      this._handleSessionTokens(msg.type, result)
      if (result && (msg.type === MSG.SNAPSHOT || msg.type === MSG.STATE_CORRECTION || msg.type === MSG.STATE_RECOVERY)) this._onSnapshot(result, msg.type)
      if (msg.type === MSG.TICK_DILATION) { this.dilationFactor = msg.payload?.factor ?? 1.0; this._msgHandler.getPredEngine()?.setDilation(this.dilationFactor); this.callbacks.onDilation(this.dilationFactor) }
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

  _rejectProtocol(message) {
    this.protocolRejected = message
    this.stopInputLoop()
    this.callbacks.onMessageError('protocol', new Error(message))
    try { this.disconnect?.() } catch (e) { console.error('[client] disconnect after protocol mismatch failed:', e?.message || e) }
  }

  setPredictionGroundSurface(surfaceHeightAt) {
    this._groundSurface = typeof surfaceHeightAt === 'function' ? surfaceHeightAt : null
    this._msgHandler.getPredEngine()?.setGroundSurface(this._groundSurface)
  }

  get inputTickRate() { return this._msgHandler.getPredEngine()?.tickRate || this.config.tickRate }

  inputPeriodMs() { return 1000 / (this.inputTickRate * (1 + this._inputRateAdjust)) }

  _trackArrivalJitter(tick) {
    const now = performance.now()
    if (this._lastSnapArrival > 0 && tick > this._lastSnapTick) {
      const expectedMs = (tick - this._lastSnapTick) * 1000 / this.inputTickRate
      const dev = Math.abs((now - this._lastSnapArrival) - expectedMs)
      this._arrivalJitterMs = this._arrivalJitterMs * (1 - JITTER_EMA_ALPHA) + dev * JITTER_EMA_ALPHA
    }
    this._lastSnapArrival = now; this._lastSnapTick = tick
  }

  inputBufferTargetDepth() {
    const tickMs = 1000 / this.inputTickRate
    return Math.max(INPUT_BUFFER_MIN_DEPTH, Math.min(INPUT_BUFFER_MAX_DEPTH, INPUT_BUFFER_MIN_DEPTH + JITTER_COVER * this._arrivalJitterMs / tickMs))
  }

  _updateInputRate(serverDepth) {
    if (!(serverDepth >= 0)) return
    this._inputDepthEma = this._inputDepthEma < 0 ? serverDepth : this._inputDepthEma * (1 - INPUT_DEPTH_EMA_ALPHA) + serverDepth * INPUT_DEPTH_EMA_ALPHA
    const err = this.inputBufferTargetDepth() - this._inputDepthEma
    this._inputRateAdjust = Math.max(-INPUT_RATE_MAX_ADJUST, Math.min(INPUT_RATE_MAX_ADJUST, err * INPUT_RATE_GAIN))
  }

  startInputLoop(produceInput) {
    this.stopInputLoop()
    this._inputStepper = createInputStepper({ getPeriodMs: () => this.inputPeriodMs(), onStep: (stepAt, periodMs) => { const input = produceInput(); if (input) this.sendInput(input, stepAt, periodMs) } })
    this._inputStepper.start()
    return () => this.stopInputLoop()
  }

  stopInputLoop() { if (this._inputStepper) { this._inputStepper.stop(); this._inputStepper = null } }

  sendInput(input, stepAt, periodMs) {
    if (this.protocolRejected) return
    const schema = this._msgHandler.getInputSchema()
    const predEngine = this._msgHandler.getPredEngine()
    const q = quantizeInput(schema, input)
    let entries
    if (this.config.predictionEnabled && predEngine) {
      predEngine.addInput(q, stepAt, periodMs)
      entries = predEngine.getUnackedInputs(REDUNDANT_INPUT_RECORDS)
    } else {
      const sequence = this._plainInputSeq++
      this._plainInputs.push({ sequence, data: q })
      if (this._plainInputs.length > REDUNDANT_INPUT_RECORDS) this._plainInputs.shift()
      entries = this._plainInputs
    }
    this.send(MSG.INPUT, encodeInputPacket(schema, entries, this._chart.epoch ?? 0))
  }

  _onSnapshot(data, msgType) {
    const incomingTick = data.tick || 0
    const isReorderedSnapshot = msgType === MSG.SNAPSHOT && this.lastSnapshotTick && incomingTick < this.lastSnapshotTick
    if (isReorderedSnapshot) return
    this.lastSnapshotTick = this.currentTick = incomingTick
    const snapshotForBuffer = this._snapProc.processSnapshot(data, this.currentTick, this.playerId)
    if (msgType === MSG.SNAPSHOT) this._msgHandler.getTimeline().addSnapshot(snapshotForBuffer, performance.now())
    const predEngine = this._msgHandler.getPredEngine()
    if (this.playerId && this.config.predictionEnabled && predEngine) {
      predEngine.setPeers(this._snapProc.getAllPlayerStates())
      const localState = this._snapProc.getPlayerState(this.playerId)
      if (localState) predEngine.onServerSnapshot({ players: [localState] }, this.currentTick)
    }
    if (msgType === MSG.SNAPSHOT) this._trackArrivalJitter(incomingTick)
    if (this.playerId && msgType === MSG.SNAPSHOT) this._updateInputRate(this._snapProc.getPlayerState(this.playerId)?.inputBuffer)
    const pArr = this.state.players; pArr.length = 0
    for (const v of this._snapProc.getAllPlayerStates().values()) pArr.push(v)
    const eArr = this.state.entities; eArr.length = 0
    for (const v of this._snapProc.getAllEntities().values()) eArr.push(v)
    this.state.dots = snapshotForBuffer.dots
    this.callbacks.onSnapshot(data)
    try { this.callbacks.onStateUpdate(this.state) }
    catch (e) { console.error('[client] onStateUpdate failed:', e?.message || e); this.callbacks.onMessageError('stateUpdate', e) }
  }

  _settleTeleportAck(ack) {
    const w = this._teleportWaiters.get(ack.reqId)
    if (!w) return
    if (!ack.ok) { this._teleportWaiters.delete(ack.reqId); clearTimeout(w.timer); w.reject(Object.assign(new Error(ack.error || 'teleport rejected'), { ack })); return }
    if (ack.op === 'probe') { this._teleportWaiters.delete(ack.reqId); clearTimeout(w.timer); w.resolve(ack); return }
    if (ack.phase === 'placed') { w.placed = ack; return }
    if (ack.phase === 'grounded') { this._teleportWaiters.delete(ack.reqId); clearTimeout(w.timer); w.resolve({ placed: w.placed, grounded: ack }) }
  }

  requestTeleport(op, spec, timeoutMs = 20000) {
    const reqId = ++this._teleportReqSeq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._teleportWaiters.delete(reqId); reject(new Error(`teleport ${op} timed out after ${timeoutMs}ms (no ack; server without relocation support or client not editor-authorised)`)) }, timeoutMs)
      this._teleportWaiters.set(reqId, { resolve, reject, timer, placed: null })
      this.send(MSG.TELEPORT, { ...spec, op, reqId, chartEpoch: this._chart.epoch ?? undefined })
    })
  }

  getViewTick(now = performance.now()) {
    return this._msgHandler.getTimeline().displayedTick(now) ?? this.lastSnapshotTick
  }

  sendFire(data) {
    this.send(MSG.APP_EVENT, { type: 'fire', shooterId: this.playerId, viewTick: this.getViewTick(), chartEpoch: this._chart.epoch ?? undefined, ...data })
  }
  sendReload() { this.send(MSG.APP_EVENT, { type: 'reload', playerId: this.playerId }) }
  sendLaunch(data) { this.send(MSG.APP_EVENT, { type: 'launch', senderId: this.playerId, chartEpoch: this._chart.epoch ?? undefined, ...data }) }
  sendEmote(code) { this.send(MSG.APP_EVENT, { type: 'emote', senderId: this.playerId, code }) }

  getChartEpoch() { return this._chart.epoch }
  getChartStats() { return { ...this._chart.stats, heldNow: this._chart.heldSnapshots } }

  getInterpolatedState(now = performance.now()) { return this._msgHandler.getTimeline().sample(now) }
  getInterpolationStats() { return this._msgHandler.getTimeline().getStats() }
  getRTT() { return this._msgHandler.getRTT() }
  getOneWayDelay() { return this._msgHandler.getOneWayDelay?.() || 0 }
  getPeerRttTable() { return this._msgHandler.getPeerRttTable?.() || {} }
  getBufferHealth() { return this._msgHandler.getBufferHealth() }
  getLocalState() { const pred = this._msgHandler.getPredEngine(); return this.config.predictionEnabled && pred ? pred.localState : this._snapProc.getPlayerState(this.playerId) }
  getRenderState(renderAt) { const pred = this._msgHandler.getPredEngine(); return this.config.predictionEnabled && pred ? (pred.getRenderState(renderAt) || pred.localState) : this.getLocalState() }
  getRemoteState(id) { return this._snapProc.getPlayerState(id) }
  getAllStates() { return this._snapProc.getAllPlayerStates() }
  getEntity(id) { return this._snapProc.getEntity(id) }
  getAllEntities() { return this._snapProc.getAllEntities() }
}
