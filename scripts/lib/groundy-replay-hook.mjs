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
const realUpdatePlayerPhysics = PhysicsIntegration.prototype.updatePlayerPhysics
PhysicsIntegration.prototype.updatePlayerPhysics = function (playerId, state, deltaTime) {
  const out = realUpdatePlayerPhysics.call(this, playerId, state, deltaTime)
  const seq = livePlayerManager?.getPlayer(playerId)?.ackSequence
  if (seq == null) return out
  const key = `${playerId}|${seq}`
  if (!serverCalls.has(key)) serverCalls.set(key, [])
  serverCalls.get(key).push({ dt: deltaTime, position: [state.position[0], state.position[1], state.position[2]] })
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
    t: performance.now()
  })
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
        serverCallDts: calls.map(c => c.dt),
        serverCallPositions: calls.map(c => c.position)
      }
    })
  }
}

process.on('exit', () => {
  attachTraces()
  if (RECORD_PATH) writeFileSync(RECORD_PATH, JSON.stringify(records))
})
