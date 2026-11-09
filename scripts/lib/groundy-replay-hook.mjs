import { writeFileSync } from 'node:fs'
import { installSpecifierHooks } from './install-specifier-hooks.mjs'

await installSpecifierHooks()
const { PredictionEngine } = await import('../../src/client/PredictionEngine.js')
const { PlayerManager } = await import('../../src/netcode/PlayerManager.js')
const { NetworkState } = await import('../../src/netcode/NetworkState.js')
const { PhysicsIntegration } = await import('../../src/netcode/PhysicsIntegration.js')
const { applyMovement } = await import('../../src/shared/movement.js')

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
const realStep = proto._step
let activeClientSteps = null
const MOVE_FLAG_KEYS = ['coyoteRemaining', 'bufferRemaining', '_jumpHeld', '_crouchHeld', 'slideRemaining', 'sliding', '_physCrouch', '_crouchDy']
const moveFlags = state => Object.fromEntries(MOVE_FLAG_KEYS.map(k => [k, state[k] ?? null]))
proto._step = function (input, seq, groundNormal) {
  const ls = this.localState
  const probing = !!activeClientSteps && seq != null
  const dtS = (this.tickDuration * this.dilation) / 1000
  const preVel = [ls.velocity[0], ls.velocity[2]]
  const preFlags = moveFlags(ls)
  const preOnGround = !!ls.onGround
  let amVel = null
  if (probing) {
    const amState = { velocity: [...ls.velocity], onGround: ls.onGround, ...preFlags }
    applyMovement(amState, input, this.movement, dtS)
    amVel = [amState.velocity[0], amState.velocity[2]]
  }
  const pushIn = probing ? this._pushForSequence(seq) : null
  const out = realStep.call(this, input, seq, groundNormal)
  if (probing) activeClientSteps.set(seq, { yaw: input?.yaw, crouch: !!input?.crouch, sprint: !!input?.sprint, forward: !!input?.forward, left: !!input?.left, right: !!input?.right, sliding: !!ls.sliding, normal: groundNormal ? [...groundNormal] : null, vel: [ls.velocity[0], ls.velocity[2]], preVel, amVel, preFlags, preOnGround, flags: moveFlags(ls), onGround: !!ls.onGround, dt: dtS, dilation: this.dilation, path: this._env?.collider ? 'collider' : 'analytic', pushIn: pushIn ? [...pushIn] : null, movement: { ...this.movement } })
  return out
}

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
const pendingPreStep = new Map()
const realGetMovementOverride = PlayerManager.prototype.getMovementOverride
PlayerManager.prototype.getMovementOverride = function (playerId) {
  const p = this.players.get(playerId)
  if (p?.state) pendingPreStep.set(playerId, { preVel: [p.state.velocity[0], p.state.velocity[2]], preFlags: moveFlags(p.state), preOnGround: !!p.state.onGround, starves: p.inputStarves ?? 0, starvedNow: p.starvedSteps ?? 0 })
  return realGetMovementOverride.call(this, playerId)
}
const realUpdatePlayerPhysics = PhysicsIntegration.prototype.updatePlayerPhysics
const FREEZE_NEUTRAL = process.env.GROUNDY_FREEZE_NEUTRAL === '1'
PhysicsIntegration.prototype.updatePlayerPhysics = function (playerId, state, deltaTime) {
  const neutral = (livePlayerManager?.getPlayer(playerId)?.starvedSteps || 0) > 0
  const lastInput = livePlayerManager?.getPlayer(playerId)?.lastInput ?? null
  const input = lastInput ? { yaw: lastInput.yaw, crouch: !!lastInput.crouch, sprint: !!lastInput.sprint, forward: !!lastInput.forward, left: !!lastInput.left, right: !!lastInput.right } : null
  if (FREEZE_NEUTRAL && neutral) return undefined
  const before = [state.position[0], state.position[1], state.position[2]]
  const carriedVel = [state.velocity[0], state.velocity[2]]
  const flags = moveFlags(state)
  const onGroundIn = !!state.onGround
  const out = realUpdatePlayerPhysics.call(this, playerId, state, deltaTime)
  const seq = livePlayerManager?.getPlayer(playerId)?.ackSequence
  if (seq == null) return out
  const position = [state.position[0], state.position[1], state.position[2]]
  const key = `${playerId}|${seq}`
  if (!serverCalls.has(key)) serverCalls.set(key, [])
  const joltVel = [state.velocity[0], state.velocity[2]]
  const normal = Array.isArray(state.groundNormal) ? [...state.groundNormal] : null
  const pre = pendingPreStep.get(playerId) ?? null
  serverCalls.get(key).push({ dt: deltaTime, position, neutral, input, vel: carriedVel, joltVel, normal, flags, onGroundIn, onGroundOut: !!state.onGround, preVel: pre?.preVel ?? null, preFlags: pre?.preFlags ?? null, preOnGround: pre?.preOnGround ?? null, preStarves: pre?.starves ?? null })
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
  const outerSteps = activeClientSteps
  const steps = new Map()
  activeClientSteps = steps
  const wedge = { horizontallyWedged: !!this.horizontallyWedged, blockedByServer: !!this._blockedByServer, wedgeNormal: [...this.wedgeNormal] }
  const push = { serverPushWindow: this.lastServerState?.pushWindow ?? null, pushAckSeq: this.lastServerState?.pushAckSeq ?? null }
  try { realRebaseAndReplay.call(this, server, predictedAtAck, recordCorrection) } finally { activeClientSteps = outerSteps }
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
    ackVel: [server.velocity[0], server.velocity[2]],
    predictedAckVel: predictedAtAck ? [predictedAtAck.velocity[0], predictedAtAck.velocity[2]] : null,
    ackNormal: Array.isArray(server.groundNormal) ? [...server.groundNormal] : null,
    predictedAckNormal: predictedAtAck && predictedAtAck.hasNormal ? [...predictedAtAck.normal] : null,
    wedge,
    push,
    ackTick: this.__ackTick,
    ackSeq: server.inputSequence,
    ackAdvance: server.inputSequence - this.__ackBefore,
    serverQueueDepth: serverQueueDepthAt(this.localPlayerId, this.__ackTick),
    lastSeq: last.sequence,
    playerId: this.localPlayerId,
    clientSteps: [...steps.entries()],
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
      const cs = new Map(r.clientSteps ?? []).get(seq) ?? {}
      return {
        seq,
        pre: pre.get(seq) ?? null,
        post: [x, y, z],
        server: last,
        serverCallCount: calls.length,
        neutralCalls: calls.filter(c => c.neutral).length,
        serverCallDts: calls.map(c => c.dt),
        serverCallPositions: calls.map(c => c.position),
        serverFirst: calls.length ? calls[0].position : null,
        serverInput: calls.length ? calls[0].input : null,
        clientInput: new Map(r.clientSteps ?? []).get(seq) ?? null,
        serverPreVel: calls.length ? calls[0].preVel : null,
        serverPreFlags: calls.length ? calls[0].preFlags : null,
        serverPreOnGround: calls.length ? calls[0].preOnGround : null,
        serverPreStarves: calls.length ? calls[0].preStarves : null,
        serverVel: calls.length ? calls[0].vel : null,
        serverJoltVel: calls.length ? calls[0].joltVel : null,
        serverLastVel: calls.length ? calls[calls.length - 1].vel : null,
        serverNormal: calls.length ? calls[0].normal : null,
        serverFlags: calls.length ? calls[0].flags : null,
        serverOnGroundIn: calls.length ? calls[0].onGroundIn : null,
        serverDt: calls.length ? calls[0].dt : null,
        clientVel: cs.vel ?? null,
        clientNormal: cs.normal ?? null,
        clientPreVel: cs.preVel ?? null,
        clientAmVel: cs.amVel ?? null,
        clientPreFlags: cs.preFlags ?? null,
        clientFlags: cs.flags ?? null,
        clientPreOnGround: cs.preOnGround ?? null,
        clientOnGround: cs.onGround ?? null,
        clientDt: cs.dt ?? null,
        clientPath: cs.path ?? null,
        clientPushIn: cs.pushIn ?? null,
        clientMovement: cs.movement ?? null
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
