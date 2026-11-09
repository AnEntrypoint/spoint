import { writeFileSync } from 'node:fs'
import { installSpecifierHooks } from './install-specifier-hooks.mjs'

await installSpecifierHooks()
const { PredictionEngine } = await import('../../src/client/PredictionEngine.js')

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

proto.onServerSnapshot = function (snapshot, tick) {
  this.__ackTick = tick
  if (INJECT_M && Array.isArray(snapshot.players)) {
    const players = snapshot.players.map(p => {
      if (!p || p.id !== this.localPlayerId || !p.position || p.position.length !== 3) return p
      const count = (localAckCounts.get(this) || 0) + 1
      localAckCounts.set(this, count)
      if (count % INJECT_EVERY !== 0) return p
      return { ...p, position: [p.position[0], p.position[1] + INJECT_M, p.position[2]] }
    })
    return realOnServerSnapshot.call(this, { ...snapshot, players }, tick)
  }
  return realOnServerSnapshot.call(this, snapshot, tick)
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

proto._rebaseAndReplay = function (server, predictedAtAck, recordCorrection = true) {
  let last = null
  for (const e of this.inputHistory) last = e
  const before = last ? [last.position[0], last.position[1], last.position[2]] : null
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
    path: [...this.inputHistory].map(e => [e.sequence, e.position[0], e.position[1], e.position[2]]),
    ackTick: this.__ackTick,
    ackSeq: server.inputSequence,
    lastSeq: last.sequence,
    playerId: this.localPlayerId,
    t: performance.now()
  })
}

process.on('exit', () => {
  if (RECORD_PATH) writeFileSync(RECORD_PATH, JSON.stringify(records))
})
