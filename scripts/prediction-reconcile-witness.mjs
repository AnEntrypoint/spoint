import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

await installSpecifierHooks()
const { PredictionEngine } = await import('../src/client/PredictionEngine.js')
const { ReconciliationEngine } = await import('../src/client/ReconciliationEngine.js')

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const TICK_RATE = 60
const TICKS = 300
const GROUND_Y = 0

function seeded(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

function makeInputs(count, seed) {
  const rng = seeded(seed)
  const out = []
  for (let i = 0; i < count; i++) {
    out.push({
      forward: rng() < 0.7,
      backward: false,
      left: rng() < 0.2,
      right: rng() < 0.2,
      analogForward: 1,
      analogRight: 0,
      sprint: false,
      crouch: false,
      jump: false,
      yaw: rng() * Math.PI,
    })
  }
  return out
}

function engine() {
  const e = new PredictionEngine(TICK_RATE)
  e.setGroundProvider(() => GROUND_Y)
  e.init(1, { position: [0, GROUND_Y, 0], velocity: [0, 0, 0] })
  return e
}

function snapshotOf(e, seq) {
  const s = e.localState
  return { id: 1, position: [...s.position], rotation: [0, 0, 0, 1], velocity: [...s.velocity], onGround: s.onGround, health: 100, inputSequence: seq }
}

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

const inputs = makeInputs(TICKS + 400, 7)

{
  const client = engine()
  const server = engine()
  let worst = 0
  for (let t = 0; t < TICKS; t++) {
    const seq = client.addInput(inputs[t])
    server.addInput(inputs[t])
    client.onServerSnapshot({ players: [snapshotOf(server, seq)] }, t)
    worst = Math.max(worst, dist(client.localState.position, server.localState.position))
  }
  check('with an exact authority every tick, the client never corrects', client.stats.corrections === 0 && worst < 1e-9, `corrections ${client.stats.corrections}, worst position error ${worst.toExponential(2)} m`)
}

{
  const client = engine()
  const server = engine()
  const snaps = new Map()
  for (let t = 0; t < 150; t++) {
    const seq = client.addInput(inputs[t])
    server.addInput(inputs[t])
    snaps.set(seq, snapshotOf(server, seq))
    client.onServerSnapshot({ players: [snaps.get(seq)] }, t)
  }
  for (let t = 150; t < 154; t++) {
    const seq = client.addInput(inputs[t])
    server.addInput(inputs[t])
    snaps.set(seq, snapshotOf(server, seq))
  }
  const latest = client._inputSeq - 1
  const ackSeq = latest - 3
  const base = snaps.get(ackSeq)
  const shifted = { ...base, position: [base.position[0] + 1, base.position[1], base.position[2]], inputSequence: ackSeq }
  const correctionsBefore = client.stats.corrections
  client.onServerSnapshot({ players: [shifted] }, 154)
  const reference = new PredictionEngine(TICK_RATE)
  reference.setGroundProvider(() => GROUND_Y)
  reference.init(1, { position: shifted.position, velocity: shifted.velocity })
  for (let s = ackSeq + 1; s <= latest; s++) reference.addInput(inputs[s - 1])
  const err = dist(client.localState.position, reference.localState.position)
  check('a corrected ack rebases onto the server state and replays the unacked inputs', client.stats.corrections === correctionsBefore + 1 && err < 1e-6, `corrections ${client.stats.corrections - correctionsBefore}, error vs replay reference ${err.toExponential(2)} m`)
  const lastAckBefore = client._lastAckedSeq
  const acksBefore = client.stats.acks
  client.onServerSnapshot({ players: [shifted] }, 155)
  check('a duplicate ack is ignored', client._lastAckedSeq === lastAckBefore && client.stats.acks === acksBefore)
  const older = snaps.get(ackSeq - 5)
  client.onServerSnapshot({ players: [older] }, 156)
  check('a stale ack older than the last acknowledged input is ignored', client._lastAckedSeq === lastAckBefore && client.stats.acks === acksBefore)
  const far = { ...snapshotOf(server, latest), inputSequence: latest + client.maxAckAdvanceTicks() + 10 }
  const posBefore = [...client.localState.position]
  client.onServerSnapshot({ players: [far] }, 157)
  check('an ack further ahead than the history can rebase is refused', client._lastAckedSeq === lastAckBefore && dist(client.localState.position, posBefore) === 0)
  const unsent = { ...snapshotOf(server, latest), inputSequence: latest + 5 }
  client.onServerSnapshot({ players: [unsent] }, 158)
  check('an ack for an input this client never sent is refused', client._lastAckedSeq === lastAckBefore && dist(client.localState.position, posBefore) === 0, `lastAcked ${client._lastAckedSeq}, sent up to ${latest}`)
  check('the input history holds exactly the inputs after the last ack', client.inputHistory.length === client.predictionLeadSteps(), `history ${client.inputHistory.length}, lead ${client.predictionLeadSteps()}`)
  check('a looked-up input is found by sequence, and an acked one is gone', client.predictedAt(latest) !== null && client.predictedAt(lastAckBefore) === null)
}

{
  const client = engine()
  const server = engine()
  const snaps = new Map()
  const overflow = client.inputHistory.capacity + 140
  for (let t = 0; t < overflow; t++) {
    const seq = client.addInput(inputs[t])
    server.addInput(inputs[t])
    snaps.set(seq, snapshotOf(server, seq))
  }
  const firstSeq = 1
  check('an overflowing history drops its oldest inputs and keeps the newest', client.inputHistory.length === client.inputHistory.capacity && client.predictedAt(firstSeq) === null && client.predictedAt(overflow) !== null, `history ${client.inputHistory.length} of ${client.inputHistory.capacity}`)
  const before = [...client.localState.position]
  client.onServerSnapshot({ players: [snaps.get(firstSeq)] }, overflow)
  const afterTrueAuthority = snaps.get(overflow)
  const gap = dist(client.localState.position, afterTrueAuthority.position)
  const jumped = dist(client.localState.position, before)
  const refused = client._lastAckedSeq === 0 && jumped === 0
  const replayedWithGap = client._lastAckedSeq === firstSeq && gap > 1e-6
  check('an ack whose following inputs were dropped from the history is not rebased with a gap in the replay', !replayedWithGap, `lastAcked ${client._lastAckedSeq}, refused ${refused}, gap to authority at tick ${overflow} ${gap.toExponential(2)} m, jump ${jumped.toExponential(2)} m`)
}

{
  const r = new ReconciliationEngine()
  r.absorb(3, 0, 4, true)
  check('a grounded offset of 5 m resets the error offset', r.errorOffset.every(v => v === 0), `offset ${JSON.stringify(r.errorOffset)}`)
  r.absorb(1, 0, 1, true)
  r.absorb(6, 0, 0, false)
  check('an airborne offset under 8 m keeps the error offset', r.errorOffset[0] === 7 && r.errorOffset[2] === 1, `offset ${JSON.stringify(r.errorOffset)}`)
  r.absorb(2, 0, 0, false)
  check('an airborne offset of 8 m resets the error offset', r.errorOffset.every(v => v === 0))
  r.absorb(1, 0, 0, true)
  r.decay(1000)
  r.decay(1080)
  const decayed = r.errorOffset[0]
  check('the error offset decays by e^-dt/0.08 s', Math.abs(decayed - Math.exp(-1)) < 1e-9, `after 80 ms ${decayed.toFixed(6)}, expected ${Math.exp(-1).toFixed(6)}`)
}

{
  const rng = seeded(11)
  const jumping = inputs.slice(0, 800).map(input => ({ ...input, jump: rng() < 0.12 }))
  const client = engine()
  const server = engine()
  const snaps = new Map()
  const n = client.inputHistory.capacity + 1
  for (let t = 0; t < n; t++) {
    const seq = client.addInput(jumping[t])
    server.addInput(jumping[t])
    snaps.set(seq, snapshotOf(server, seq))
  }
  const before = [...client.localState.position]
  client.onServerSnapshot({ players: [snaps.get(1)] }, n)
  const authority = snaps.get(n)
  const err = dist(client.localState.position, authority.position)
  check('an ack whose own prediction entry was dropped leaves the prediction matching the authority', err < 1e-6, `error ${err.toExponential(2)} m, moved ${dist(client.localState.position, before).toExponential(2)} m, lastAcked ${client._lastAckedSeq}`)
}

{
  const LEDGE_Z = 0.6
  const PIT_Y = -5000
  const pressAt = 5
  const walk = { forward: true, backward: false, left: false, right: false, analogForward: 1, analogRight: 0, sprint: false, crouch: false, jump: false, yaw: 0 }
  const press = { ...walk, jump: true }
  const pitEngine = () => {
    const e = new PredictionEngine(TICK_RATE)
    e.setGroundProvider((x, z) => (z <= LEDGE_Z ? GROUND_Y : PIT_Y))
    e.init(1, { position: [0, GROUND_Y, 0], velocity: [0, 0, 0] })
    return e
  }
  const client = pitEngine()
  const server = pitEngine()
  const total = pressAt + client.inputHistory.capacity - 1
  const snaps = new Map()
  for (let t = 0; t < total; t++) {
    const input = t + 1 === pressAt ? press : walk
    const seq = client.addInput(input)
    server.addInput(input)
    snaps.set(seq, snapshotOf(server, seq))
  }
  const ackSeq = pressAt - 1
  const dropped = client.predictedAt(ackSeq) === null && client.predictedAt(pressAt) !== null
  const authority = snaps.get(total)
  const before = [...client.localState.position]
  client.onServerSnapshot({ players: [snaps.get(ackSeq)] }, total)
  const err = dist(client.localState.position, authority.position)
  check('a jump press inside the coyote window survives an ack for the step before it, whose entry was dropped', dropped && err < 1e-6, `dropped ${dropped}, error ${err.toExponential(2)} m, moved ${dist(client.localState.position, before).toExponential(2)} m, lastAcked ${client._lastAckedSeq}`)
}

const failed = checks.filter(c => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map(c => c.name).join('; ')}`)
  await exitAfterQuiesce(1)
} else {
  console.log(`RESULT: PASS PredictionEngine and ReconciliationEngine keep prediction matched to an exact authority, rebase and replay on a corrected ack, refuse stale, duplicate and out-of-range acks, and never replay across a gap in the retained input history (${checks.length} checks)`)
  await exitAfterQuiesce(0)
}
