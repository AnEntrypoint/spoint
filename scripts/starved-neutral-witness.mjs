import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

await installSpecifierHooks()
const { processPlayerMovement } = await import('../src/sdk/TickHandler.js')
const { PredictionEngine } = await import('../src/client/PredictionEngine.js')
const { applyMovement, DEFAULT_MOVEMENT } = await import('../src/shared/movement.js')
const { STARVED_TICKS_STEP_STATE } = await import('../src/shared/starvedNeutral.js')

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const TICK_RATE = 60
const DT = 1 / TICK_RATE
const HOLD_TICKS = Math.max(1, Math.round(TICK_RATE * 0.25))
const WALK_TICKS = 6
const STARVED_TICKS = 40
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
  let physicsCalls = 0
  const physicsIntegration = {
    updatePlayerPhysics(_id, st, dt) {
      physicsCalls++
      st.position[0] += st.velocity[0] * dt
      st.position[2] += st.velocity[2] * dt
    },
    setCrouch() {},
    physicsCalls: () => physicsCalls,
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
    tickMs: 1000 / TICK_RATE,
  }
  return { player, queue, deps, physicsIntegration }
}

const server = serverHarness()
for (let i = 0; i < WALK_TICKS; i++) server.queue.push({ sequence: 11 + i, data: { forward: true, yaw: 0 } })
let tick = 1
for (let i = 0; i < WALK_TICKS; i++, tick++) processPlayerMovement([server.player], server.deps, tick, DT, new Map())
const walkStart = server.player.state.position
const walked = Math.hypot(walkStart[0], walkStart[2])
check('walking moves the character before the input stops', walked > 0.5, `walked ${walked.toFixed(3)} m`)

const frozenAt = [...server.player.state.position]
const frozenVel = [...server.player.state.velocity]
const callsBefore = server.physicsIntegration.physicsCalls()
let starvedMaxM = 0
let starvedVelMaxDelta = 0
let starvedMaxSteps = 0
for (let i = 0; i < STARVED_TICKS; i++, tick++) {
  const before = [...server.player.state.position]
  processPlayerMovement([server.player], server.deps, tick, DT, new Map())
  const p = server.player.state.position
  starvedMaxM = Math.max(starvedMaxM, Math.hypot(p[0] - before[0], p[2] - before[2]))
  const v = server.player.state.velocity
  starvedVelMaxDelta = Math.max(starvedVelMaxDelta, Math.abs(v[0] - frozenVel[0]), Math.abs(v[2] - frozenVel[2]))
  starvedMaxSteps = Math.max(starvedMaxSteps, server.player.starvedSteps || 0)
}

if (STARVED_TICKS_STEP_STATE) {
  check('starved ticks step the character (reversal switch on)', starvedMaxM > 0, `max move ${starvedMaxM}`)
} else {
  check('starved ticks leave the character in place', starvedMaxM <= STILL_EPS_M, `max move ${starvedMaxM}`)
  check('starved ticks leave the velocity as it was when the input stopped', starvedVelMaxDelta <= STILL_EPS_M, `max delta ${starvedVelMaxDelta}`)
  check('starved ticks run no physics step', server.physicsIntegration.physicsCalls() === callsBefore, `calls ${server.physicsIntegration.physicsCalls() - callsBefore}`)
  check('starved ticks count no neutral steps on the server', starvedMaxSteps === 0, `max starvedSteps ${starvedMaxSteps}`)
  check('the frozen position is the position when the input stopped', server.player.state.position.every((c, i) => c === frozenAt[i]), `frozen at ${frozenAt.map(c => c.toFixed(3)).join(',')}`)

  server.queue.push({ sequence: 11 + WALK_TICKS, data: { forward: true, yaw: 0 } })
  const beforeResume = [...server.player.state.position]
  const callsAtResume = server.physicsIntegration.physicsCalls()
  processPlayerMovement([server.player], server.deps, tick, DT, new Map())
  const resumed = Math.hypot(server.player.state.position[0] - beforeResume[0], server.player.state.position[2] - beforeResume[2])
  check('a sequenced input resumes from the frozen state with one physics step', server.physicsIntegration.physicsCalls() - callsAtResume === 1 && resumed > 0, `calls ${server.physicsIntegration.physicsCalls() - callsAtResume}, moved ${resumed.toFixed(4)} m`)
  tick++
}

if (STARVED_TICKS_STEP_STATE) {
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
  const ack = { position: [0, 0, 0], starvedSteps: STARVED_TICKS, pushWindow: null, pushAckSeq: 0, groundNormal: null }
  engine._rollForwardAcked(ack, predicted)
  const rolledM = Math.hypot(engine.localState.position[0], engine.localState.position[2])
  check('client: the reversal switch restores the roll-forward coast', rolledM >= COAST_MIN_M, `moved ${rolledM.toFixed(4)} m`)
}

const failed = checks.filter(c => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map(c => c.name).join('; ')}`)
  await exitAfterQuiesce(1)
} else {
  const rule = STARVED_TICKS_STEP_STATE ? 'steps the character with the zeroing and neutral step (reversal)' : 'freezes the character until a sequenced input is consumed'
  console.log(`RESULT: PASS a starved tick ${rule} (constant ${STARVED_TICKS_STEP_STATE})`)
  await exitAfterQuiesce(0)
}
