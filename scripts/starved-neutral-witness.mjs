import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

await installSpecifierHooks()
const { processPlayerMovement } = await import('../src/sdk/TickHandler.js')
const { PredictionEngine } = await import('../src/client/PredictionEngine.js')
const { applyMovement, DEFAULT_MOVEMENT } = await import('../src/shared/movement.js')
const { STARVED_NEUTRAL_KEEPS_HORIZONTAL_VELOCITY } = await import('../src/shared/starvedNeutral.js')

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const TICK_RATE = 60
const DT = 1 / TICK_RATE
const HOLD_TICKS = Math.max(1, Math.round(TICK_RATE * 0.25))
const WALK_TICKS = 6
const NEUTRAL_TICKS = 12
const STILL_EPS_M = 1e-9
const COAST_MIN_M = 0.05

function serverHarness() {
  const queue = []
  const player = {
    id: 1,
    state: { position: [0, 0, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], onGround: true, groundNormal: null, health: 100, crouch: 0, lookPitch: 0, lookYaw: 0, expr: 0, weapon: 0 },
    ackSequence: 10,
    inputSequence: 10,
    hasSentInput: true,
    lastInput: null,
  }
  const physicsIntegration = {
    updatePlayerPhysics(_id, st, dt) {
      st.position[0] += st.velocity[0] * dt
      st.position[2] += st.velocity[2] * dt
    },
    setCrouch() {},
  }
  const deps = {
    playerManager: { getInputs: () => queue, getMovementOverride: () => null },
    physicsIntegration,
    lagCompensator: { recordPlayerPosition() {} },
    networkState: { setPushWindow() {}, updatePlayer() {} },
    applyMovement,
    movement: { ...DEFAULT_MOVEMENT },
    eventLog: null,
    transformRingWriter: null,
    starveHoldTicks: HOLD_TICKS,
  }
  return { player, queue, deps }
}

const server = serverHarness()
for (let i = 0; i < WALK_TICKS; i++) server.queue.push({ sequence: 11 + i, data: { forward: true, yaw: 0 } })
let tick = 1
for (let i = 0; i < WALK_TICKS; i++, tick++) processPlayerMovement([server.player], server.deps, tick, DT, new Map())
const walkStart = server.player.state.position
const walked = Math.hypot(walkStart[0], walkStart[2])
check('walking moves the character before the input stops', walked > 0.5, `walked ${walked.toFixed(3)} m`)

let holdMaxM = 0
for (let i = 0; i < HOLD_TICKS; i++, tick++) {
  const before = [...server.player.state.position]
  processPlayerMovement([server.player], server.deps, tick, DT, new Map())
  const p = server.player.state.position
  holdMaxM = Math.max(holdMaxM, Math.hypot(p[0] - before[0], p[2] - before[2]))
}
check('the starved hold leaves the character in place', holdMaxM <= STILL_EPS_M, `max ${holdMaxM}`)

const neutralDisp = []
const neutralVel = []
for (let i = 0; i < NEUTRAL_TICKS; i++, tick++) {
  const before = [...server.player.state.position]
  processPlayerMovement([server.player], server.deps, tick, DT, new Map())
  const p = server.player.state.position
  neutralDisp.push(Math.hypot(p[0] - before[0], p[2] - before[2]))
  neutralVel.push(Math.hypot(server.player.state.velocity[0], server.player.state.velocity[2]))
}

if (!STARVED_NEUTRAL_KEEPS_HORIZONTAL_VELOCITY) {
  check('server: a neutral step after the hold moves nothing horizontally', Math.max(...neutralDisp) <= STILL_EPS_M, `max ${Math.max(...neutralDisp)}`)
  check('server: a neutral step after the hold leaves zero horizontal velocity', Math.max(...neutralVel) <= STILL_EPS_M, `max ${Math.max(...neutralVel)}`)
} else {
  check('server: the reversal switch restores the post-hold coast', neutralDisp[0] >= COAST_MIN_M, `first neutral step ${neutralDisp[0].toFixed(4)} m`)
}

const engine = new PredictionEngine(TICK_RATE)
engine.setGroundProvider(() => 0)
engine.init(1, { position: [0, 0, 0], velocity: [0, 0, 0] })
engine.localState.velocity[0] = 12.9
const predicted = {
  position: [0, 0, 0],
  velocity: [12.9, 0, 0],
  onGround: true,
  groundY: 0,
  move: { ...engine.localState },
  data: { forward: false, yaw: 0, pitch: 0, crouch: false, expr: 0 },
}
const ack = { position: [0, 0, 0], starvedSteps: NEUTRAL_TICKS, pushWindow: null, pushAckSeq: 0, groundNormal: null }
engine._rollForwardAcked(ack, predicted)
const rolledM = Math.hypot(engine.localState.position[0], engine.localState.position[2])
const rolledVel = Math.hypot(engine.localState.velocity[0], engine.localState.velocity[2])

if (!STARVED_NEUTRAL_KEEPS_HORIZONTAL_VELOCITY) {
  check('client: the roll-forward through the starved count moves nothing horizontally', rolledM <= STILL_EPS_M, `moved ${rolledM}`)
  check('client: the roll-forward through the starved count leaves zero horizontal velocity', rolledVel <= STILL_EPS_M, `velocity ${rolledVel}`)
} else {
  check('client: the reversal switch restores the roll-forward coast', rolledM >= COAST_MIN_M, `moved ${rolledM.toFixed(4)} m`)
}

const failed = checks.filter(c => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map(c => c.name).join('; ')}`)
  await exitAfterQuiesce(1)
} else {
  const rule = STARVED_NEUTRAL_KEEPS_HORIZONTAL_VELOCITY ? 'keeps the post-hold coast' : 'carries zero horizontal velocity'
  console.log(`RESULT: PASS the starved neutral step ${rule} on the server and in the client roll-forward (constant ${STARVED_NEUTRAL_KEEPS_HORIZONTAL_VELOCITY})`)
  await exitAfterQuiesce(0)
}
