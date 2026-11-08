import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

await installSpecifierHooks()
const { PredictionEngine } = await import('../src/client/PredictionEngine.js')

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log('check ' + name + ': ' + (ok ? 'ok' : 'FAIL') + (detail ? ' (' + detail + ')' : ''))
}

const TICK_RATE = 60
const GROUND_Y = 0
const TICKS = 8
const ACK_INDEX = 2
const ACK_ERR_M = 0.03
const OFFSET_TOLERANCE_M = 0.001
const LIVE_PUSH_MIN_M = 0.005
const NEAR_PEER = [0.35, 0, 0.1]
const FAR_PEER = [0.35, 0, 3]

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
    out.push({ forward: rng() < 0.7, backward: false, left: rng() < 0.2, right: rng() < 0.2, analogForward: 1, analogRight: 0, sprint: false, crouch: false, jump: false, yaw: rng() * Math.PI })
  }
  return out
}

function engine() {
  const e = new PredictionEngine(TICK_RATE)
  e.setGroundProvider(() => GROUND_Y)
  e.init(1, { position: [0, GROUND_Y, 0], velocity: [0, 0, 0] })
  return e
}

const peersAt = position => new Map([[2, { position: [...position], velocity: [0, 0, 0] }]])
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

function liveRun(peers) {
  const inputs = makeInputs(TICKS, 7)
  const client = engine()
  client.setPeers(peers)
  const seqs = []
  const livePos = new Map()
  let ackSnap = null
  for (let t = 0; t < TICKS; t++) {
    const seq = client.addInput(inputs[t])
    seqs.push(seq)
    livePos.set(seq, [...client.localState.position])
    if (t === ACK_INDEX) ackSnap = { id: 1, position: [...client.localState.position], rotation: [0, 0, 0, 1], velocity: [...client.localState.velocity], onGround: client.localState.onGround, health: 100, inputSequence: seq }
  }
  return { client, seqs, livePos, ackSnap }
}

function replayOffsetsAfterAck(peersBefore, peersAtAck) {
  const { client, seqs, livePos, ackSnap } = liveRun(peersBefore)
  client.setPeers(peersAtAck)
  const shifted = { ...ackSnap, position: [ackSnap.position[0], ackSnap.position[1], ackSnap.position[2] + ACK_ERR_M] }
  client.onServerSnapshot({ players: [shifted] }, TICKS)
  const ackSeq = seqs[ACK_INDEX]
  const offsets = []
  for (const e of client.inputHistory) if (e.sequence > ackSeq) offsets.push(dist(e.position, livePos.get(e.sequence)))
  return { client, ackSeq, offsets }
}

const bare = liveRun(null)
const near = liveRun(peersAt(NEAR_PEER))
let livePush = 0
for (const seq of near.seqs) livePush = Math.max(livePush, dist(near.livePos.get(seq), bare.livePos.get(bare.seqs[near.seqs.indexOf(seq)])))
check('a nearby peer pushes the live path away from the path with no peer', livePush >= LIVE_PUSH_MIN_M, 'max live push ' + livePush.toFixed(4) + ' m')

const control = replayOffsetsAfterAck(peersAt(NEAR_PEER), peersAt(NEAR_PEER))
check('the ack is accepted and the entries after it are replayed', control.client._lastAckedSeq === control.ackSeq && control.offsets.length === TICKS - 1 - ACK_INDEX, 'replayed ' + control.offsets.length + ' entries')
const controlDev = Math.max(...control.offsets.map(o => Math.abs(o - ACK_ERR_M)))
check('control: peer unchanged, every replayed entry carries exactly the acknowledged error', controlDev <= OFFSET_TOLERANCE_M, 'max deviation ' + controlDev.toFixed(6) + ' m')

const moved = replayOffsetsAfterAck(peersAt(NEAR_PEER), peersAt(FAR_PEER))
const movedDev = Math.max(...moved.offsets.map(o => Math.abs(o - ACK_ERR_M)))
check('peer moved before the ack, every replayed entry still carries exactly the acknowledged error', movedDev <= OFFSET_TOLERANCE_M, 'max deviation ' + movedDev.toFixed(6) + ' m, offsets ' + moved.offsets.map(o => o.toFixed(4)).join(' '))

const failed = checks.filter(c => !c.ok)
console.log(String(checks.length - failed.length) + '/' + String(checks.length) + ' checks passed')
if (failed.length) {
  console.log('RESULT: FAIL ' + failed.length + ' check(s): ' + failed.map(c => c.name).join('; '))
  await exitAfterQuiesce(1)
} else {
  console.log('RESULT: PASS every replayed entry after an ack keeps exactly the acknowledged error, whether or not the nearby peer moved before the ack (' + checks.length + ' checks)')
  await exitAfterQuiesce(0)
}
