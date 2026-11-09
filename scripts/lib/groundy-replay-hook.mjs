import { writeFileSync } from 'node:fs'
import { installSpecifierHooks } from './install-specifier-hooks.mjs'

await installSpecifierHooks()
const { PredictionEngine } = await import('../../src/client/PredictionEngine.js')
const { PlayerManager } = await import('../../src/netcode/PlayerManager.js')
const { NetworkState } = await import('../../src/netcode/NetworkState.js')
const { PhysicsIntegration } = await import('../../src/netcode/PhysicsIntegration.js')

const RECORD_PATH = process.env.GROUNDY_RECORD || ''
const INJECT_M = Number(process.env.GROUNDY_INJECT_M || 0)
const records = []
const engineIds = new WeakMap()
let engineCount = 0
const idOf = engine => {
  if (!engineIds.has(engine)) engineIds.set(engine, engineCount++)
  return engineIds.get(engine)
}
const proto = PredictionEngine.prototype
const realOnServerSnapshot = proto.onServerSnapshot
const realRebaseAndReplay = proto._rebaseAndReplay

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

const SPIKE_MIN_M = 0.0008
const SPIKE_MAX_M = 0.0025
const mirrorTracks = new WeakMap()

const observeMirrorStep = (track, state) => {
  const cur = { y: state.position[1], og: !!state.onGround }
  const { prev2, prev1 } = track
  if (prev2 && prev1 && prev1.og) {
    const up = prev1.y - prev2.y, down = cur.y - prev1.y
    if (up >= SPIKE_MIN_M && up <= SPIKE_MAX_M && down <= -SPIKE_MIN_M) records.push({ kind: 'spike', engine: track.engine, upM: up, downM: down, t: performance.now() })
  }
  track.prev2 = prev1
  track.prev1 = cur
}

const entryWithSequence = (engine, sequence) => {
  for (const e of engine.inputHistory) if (e.sequence === sequence) return e
  return null
}

const INJECT_EVERY = Number(process.env.GROUNDY_INJECT_EVERY || 25)
const localAckCounts = new WeakMap()

const injectedSnapshot = (engine, snapshot) => {
  if (!INJECT_M || !Array.isArray(snapshot.players)) return snapshot
  const players = snapshot.players.map(p => {
    if (!p || p.id !== engine.localPlayerId || !p.position || p.position.length !== 3) return p
    const count = (localAckCounts.get(engine) || 0) + 1
    localAckCounts.set(engine, count)
    if (count % INJECT_EVERY !== 0) return p
    return { ...p, position: [p.position[0], p.position[1] + INJECT_M, p.position[2]] }
  })
  return { ...snapshot, players }
}

proto.onServerSnapshot = function (snapshot, tick) {
  this.__ackTick = tick
  return realOnServerSnapshot.call(this, injectedSnapshot(this, snapshot), tick)
}

const realReconcile = proto._reconcile
proto._reconcile = function (serverPlayer) {
  const before = this._lastAckedSeq
  this.__ackBefore = before
  realReconcile.call(this, serverPlayer)
  records.push({ kind: 'ack', engine: idOf(this), ackSeq: serverPlayer.inputSequence, before, applied: this._lastAckedSeq !== before, ackedTicks: serverPlayer.inputSequence - before, tick: this.__ackTick, t: performance.now() })
}

const queueDepthNow = new Map()
const queueDepthByTick = new Map()
let livePlayerManager = null

const realGetInputs = PlayerManager.prototype.getInputs
PlayerManager.prototype.getInputs = function (playerId) {
  livePlayerManager = this
  const inputs = realGetInputs.call(this, playerId)
  queueDepthNow.set(playerId, inputs ? inputs.length : 0)
  return inputs
}

const realUpdatePlayer = NetworkState.prototype.updatePlayer
NetworkState.prototype.updatePlayer = function (playerId, ...rest) {
  if (queueDepthNow.has(playerId)) {
    if (!queueDepthByTick.has(playerId)) queueDepthByTick.set(playerId, new Map())
    queueDepthByTick.get(playerId).set(this.tick, queueDepthNow.get(playerId))
  }
  return realUpdatePlayer.call(this, playerId, ...rest)
}

const serverQueueDepthAt = (playerId, tick) => queueDepthByTick.get(playerId)?.get(tick) ?? null

const serverCalls = new Map()
const callLogs = new Map()
const realUpdatePlayerPhysics = PhysicsIntegration.prototype.updatePlayerPhysics
const FREEZE_NEUTRAL = process.env.GROUNDY_FREEZE_NEUTRAL === '1'
PhysicsIntegration.prototype.updatePlayerPhysics = function (playerId, state, deltaTime) {
  const neutral = (livePlayerManager?.getPlayer(playerId)?.starvedSteps || 0) > 0
  if (FREEZE_NEUTRAL && neutral) return undefined
  const before = [state.position[0], state.position[1], state.position[2]]
  const out = realUpdatePlayerPhysics.call(this, playerId, state, deltaTime)
  const seq = livePlayerManager?.getPlayer(playerId)?.ackSequence
  if (seq == null) return out
  const position = [state.position[0], state.position[1], state.position[2]]
  const key = `${playerId}|${seq}`
  if (!serverCalls.has(key)) serverCalls.set(key, [])
  serverCalls.get(key).push({ dt: deltaTime, position, neutral })
  if (!callLogs.has(playerId)) callLogs.set(playerId, [])
  callLogs.get(playerId).push({ seq, before, after: position, neutral })
  return out
}

const realSetCollisionMirror = proto.setCollisionMirror
proto.setCollisionMirror = function (mirror) {
  realSetCollisionMirror.call(this, mirror)
  const m = this._mirror
  if (!m || mirrorTracks.has(m)) return
  const track = { engine: idOf(this), prev1: null, prev2: null }
  mirrorTracks.set(m, track)
  const realStep = m.step
  m.step = function (state, input, dt, gravityY, wasGrounded) {
    realStep.call(this, state, input, dt, gravityY, wasGrounded)
    observeMirrorStep(track, state)
  }
}

const pathOf = engine => [...engine.inputHistory].map(e => [e.sequence, e.position[0], e.position[1], e.position[2]])

proto._rebaseAndReplay = function (server, predictedAtAck, recordCorrection = true) {
  let last = null
  for (const e of this.inputHistory) last = e
  const before = last ? [last.position[0], last.position[1], last.position[2]] : null
  const prePath = pathOf(this)
  const wedge = { horizontallyWedged: !!this.horizontallyWedged, blockedByServer: !!this._blockedByServer, wedgeNormal: [...this.wedgeNormal] }
  const push = { serverPushWindow: this.lastServerState?.pushWindow ?? null, pushAckSeq: this.lastServerState?.pushAckSeq ?? null }
  realRebaseAndReplay.call(this, server, predictedAtAck, recordCorrection)
  if (!last) return
  const after = entryWithSequence(this, last.sequence)
  if (!after) return
  const reference = predictedAtAck ?? server
  const errM = recordCorrection ? distance(server.position, reference.position) : null
  const offsetM = distance(before, after.position)
  let inContact = false
  for (const e of this.inputHistory) if (this._pushForSequence(e.sequence)) { inContact = true; break }
  records.push({
    kind: recordCorrection ? 'correction' : 'resync',
    engine: idOf(this),
    seq: last.sequence,
    errM,
    offsetM,
    growthM: recordCorrection ? offsetM - errM : null,
    jumpM: this.stats.lastCorrectionM,
    serverGroundY: server.onGround || this.verticallyBlocked ? server.position[1] : null,
    predictedGroundY: predictedAtAck && Number.isFinite(predictedAtAck.groundY) ? predictedAtAck.groundY : null,
    serverOnGround: !!server.onGround,
    verticallyBlocked: !!this.verticallyBlocked,
    injectedM: INJECT_M,
    inContact,
    path: pathOf(this),
    prePath,
    ackPosition: [server.position[0], server.position[1], server.position[2]],
    wedge,
    push,
    ackTick: this.__ackTick,
    ackSeq: server.inputSequence,
    ackAdvance: server.inputSequence - this.__ackBefore,
    serverQueueDepth: serverQueueDepthAt(this.localPlayerId, this.__ackTick),
    lastSeq: last.sequence,
    playerId: this.localPlayerId,
    clientPushes: [...this.inputHistory].map(e => { const w = this._pushForSequence(e.sequence); return [e.sequence, w ? [...w] : null] }),
    t: performance.now()
  })
}

const residualAgainst = (trace, referenceOf) => {
  let worst = null
  for (const t of trace) {
    const reference = referenceOf(t)
    if (!t.post || !reference) continue
    const m = distance(t.post, reference)
    if (worst === null || m > worst) worst = m
  }
  return worst
}

const pushMatches = (disp, w) => {
  if (!disp) return null
  const cx = w ? w[0] : 0, cz = w ? w[1] : 0
  return Math.abs(disp[0] - cx) <= 1e-5 && Math.abs(disp[1]) <= 1e-5 && Math.abs(disp[2] - cz) <= 1e-5
}

const pushProbe = (r, trace) => {
  const log = callLogs.get(r.playerId) ?? []
  const firstAt = new Map()
  log.forEach((c, i) => { if (!firstAt.has(c.seq)) firstAt.set(c.seq, i) })
  const pushOf = new Map(r.clientPushes)
  for (const e of trace) {
    const i = firstAt.get(e.seq)
    const nxt = i === undefined ? undefined : log[i + 1]
    e.serverPostPush = nxt ? nxt.before : null
    e.serverPushDisp = nxt ? [nxt.before[0] - log[i].after[0], nxt.before[1] - log[i].after[1], nxt.before[2] - log[i].after[2]] : null
    e.clientPush = pushOf.get(e.seq) ?? null
    e.pushMatch = pushMatches(e.serverPushDisp, e.clientPush)
  }
  r.residualPostPushM = residualAgainst(trace, e => e.serverPostPush)
  r.unreferencedEntries = trace.filter(e => !e.serverPostPush).length
}

const attachTraces = () => {
  for (const r of records) {
    if (r.kind !== 'correction' && r.kind !== 'resync') continue
    const pre = new Map(r.prePath.map(([seq, x, y, z]) => [seq, [x, y, z]]))
    r.trace = r.path.filter(([seq]) => seq > r.ackSeq).map(([seq, x, y, z]) => {
      const calls = serverCalls.get(`${r.playerId}|${seq}`) ?? []
      const last = calls.length ? calls[calls.length - 1].position : null
      return {
        seq,
        pre: pre.get(seq) ?? null,
        post: [x, y, z],
        server: last,
        serverCallCount: calls.length,
        neutralCalls: calls.filter(c => c.neutral).length,
        serverCallDts: calls.map(c => c.dt),
        serverCallPositions: calls.map(c => c.position),
        serverFirst: calls.length ? calls[0].position : null
      }
    })
    r.residualPrePushM = residualAgainst(r.trace, t => t.serverFirst)
    r.ackKeyCalls = (serverCalls.get(`${r.playerId}|${r.ackSeq}`) ?? []).length
    pushProbe(r, r.trace)
    r.residualM = r.residualPostPushM
  }
}

process.on('exit', () => {
  attachTraces()
  if (RECORD_PATH) writeFileSync(RECORD_PATH, JSON.stringify(records))
})
