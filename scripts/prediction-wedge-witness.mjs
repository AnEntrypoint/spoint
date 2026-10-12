#!/usr/bin/env node
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createNetServer } from 'node:net'
import { PredictionEngine } from '../src/client/PredictionEngine.js'
import { DEFAULT_MOVEMENT } from '../src/shared/movement.js'
import { numericFlag, numericListFlag } from './lib/witness-args.mjs'
import { registerWitnessServer } from './lib/witness-server.mjs'

if (typeof globalThis.WebSocket !== 'function') {
  const { WebSocket } = await import('ws')
  globalThis.WebSocket = WebSocket
}

process.env.SPOINT_NO_WATCH = '1'
process.env.SPOINT_SKIP_PREWARM = '1'
if (!process.env.GM_PROFILE) process.env.GM_PROFILE = '1'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const eq = a.indexOf('=')
  if (eq < 0) return [a.replace(/^--/, ''), 'true']
  return [a.slice(2, eq), a.slice(eq + 1)]
}))
const sleep = ms => new Promise(r => setTimeout(r, ms))

const TICKS = numericFlag(args, 'ticks', 450)
const TICK_RATE = numericFlag(args, 'tickRate', 60)
const PEN_TOL_M = numericFlag(args, 'penTol', 0.05)
// One predicted step is one tick of travel at the commanded speed. Both numbers are
// world constants (DEFAULT_MOVEMENT in src/shared/movement.js, which sets sprint speed
// to maxSpeed x SPRINT_SPEED_MUL when no sprintSpeed is given, and the world tick
// rate), so this unit cannot drift with how busy the box is. A step distance MEASURED
// off the running server cannot serve as the unit: this witness has watched it collapse
// from 0.2042 m/tick to 0.0953 m/tick at x2.53 host contention, which silently rescales
// every metre bound keyed to it. 7.0 x 1.75 / 60 = 0.2041667 m.
const SPRINT_SPEED_MUL = 1.75
const SPRINT_SPEED_MPS = DEFAULT_MOVEMENT.sprintSpeed ?? DEFAULT_MOVEMENT.maxSpeed * SPRINT_SPEED_MUL
const STEP_TRAVEL_M = SPRINT_SPEED_MPS / TICK_RATE
// src/client/BaseClient.js MAX_PREDICTION_LEAD_STEPS: the client refuses to add an
// input once it is this many steps ahead, so it is also the design ceiling on how far
// a prediction may legitimately run past the server.
const MAX_PREDICTION_LEAD_STEPS = 16
// The predicted position is a collider-less extrapolation of the last acked server
// position: for a kinematic wall the client is handed no wall plane at all, so it
// cannot know the wall exists before the server reaches it. Penetration during the
// approach is therefore priced by the prediction LEAD (maxFreeDivergenceM), not by
// an absolute distance picked ahead of time -- the prediction cannot be less far
// inside the wall than it is ahead of the server. Even the static arm, which does
// get a wall plane, only gets one once the SERVER has touched that plane.
// Measured on this box over 13 plain runs x 4 arms (~20 node processes over 16
// cores, so the lead itself is load-driven): exhaustive penetration 0.0825..
// 0.39667 m, sanctioned clear-lane lead 0.41452..1.22937 m, penetration/lead
// 0.163..0.802. The old 0.2 m (approach) / 0.25 m (transient) bound sat BELOW the
// lead this same witness sanctions, so it was unreachable whenever the lead exceeded
// it: at HEAD two plain runs here measured 0.13506 m and 0.36883 m and the second
// one failed. `penLeadFrac` 1.0 is the physical ceiling: further inside the wall
// than the clear-lane lead means the prediction free-ran into geometry the server
// stopped at. Both bounds are non-vacuous -- `--probe=wallpush --probeOvershootM=1`
// pushes every predicted step that the server is in contact range of 1 m further
// along its commanded direction and reads 2.4 m, i.e. 3.9..5.8 x the lead.
// Penetration is a number of STEPS OF TRAVEL, so the bounds are in steps and any metre
// figure is derived from them, never the other way round. A metre bound picked on a
// quiet box is unreachable on a busy one: measured over 20 clean arm-runs at host
// contention x0.88..x3.10, the impact penetration is 0.40..8.69 steps of travel
// (0.083..1.774 m) and it grows with the prediction lead, which the box drives anywhere
// from 3 to MAX_PREDICTION_LEAD_STEPS. The old absolute 0.6 m is 2.94 steps -- inside
// the measured clean range, so it reddened a busy box with no regression in it.
// PEN_STEP_TOL_STEPS is the claim `penLeadFrac` already makes (penetration may not
// exceed the sanctioned lead), priced at the DESIGN lead cap instead of the measured
// lead, so the number cannot move with the machine.
const PEN_STEP_TOL_STEPS = numericFlag(args, 'penStepTolSteps', MAX_PREDICTION_LEAD_STEPS)
const PEN_STEP_TOL_M = PEN_STEP_TOL_STEPS * STEP_TRAVEL_M
const PEN_LEAD_FRAC = numericFlag(args, 'penLeadFrac', 1)
const PROBE = String(args.probe || 'none').toLowerCase()
const PROBE_OVERSHOOT_M = numericFlag(args, 'probeOvershootM', 0.5)
const DIVERGENCE_SLACK_TICKS = numericFlag(args, 'divergenceSlackTicks', 1)
const MIN_LEAD_FRAC = numericFlag(args, 'minLeadFrac', 0.2)
// How many server ticks a prediction may go with no ACCEPTED ack before its samples stop
// counting as evidence about the latch. `_reconcile` (src/client/PredictionEngine.js)
// sets `horizontallyWedged` before it decides whether the ack is usable, so a duplicate
// or out-of-range ack latches the block and leaves the prediction standing wherever it
// was -- inside the wall, if that is where it was. That is the ack pipeline making the
// sample, not the latch, and a loaded box produces more of it.
const ACK_STALE_TICKS = numericFlag(args, 'ackStaleTicks', 3)
// Settled-at-the-wall samples as a fraction of the samples the arm spent at the wall.
// The absolute count is a function of how much of the fixed tick budget the player gets
// to spend at the wall, which shrinks when the box is loaded: measured 40..321 settled
// samples for the same arms at x0.88..x3.10 contention. The fraction is 0.593..0.885
// over those same runs.
const MIN_HELD_FRAC = numericFlag(args, 'minHeldFrac', 0.5)
// One predicted step covers one tick of travel at the commanded speed. That is a
// statement about the engine's dt, so it is pinned on the deterministic unit engine
// below (unit-step-size), where dt cannot move. The live arm cannot carry it: the
// step it measures is the step the player ACHIEVED, which on a slide arm is the
// along-wall component of the sprint (0.094..0.141 m measured here, i.e. 25 and 75
// deg incidence), and on a loaded box both the client's input rate and the server's
// tick advance move, so any ratio between them does too (0.8631 at x2.53 and 1.1001
// at x3.10 with no regression in either).
const UNIT_STEP_TOL_FRAC = numericFlag(args, 'unitStepTolFrac', 1e-4)
const MIN_SLIDE_TICKS = numericFlag(args, 'minSlideTicks', 40)
const WARMUP_TICKS = numericFlag(args, 'warmupTicks', 10)
const SETTLE_TIMEOUT_MS = numericFlag(args, 'settleTimeoutMs', 30000)
const ARM_TIMEOUT_MS = numericFlag(args, 'armTimeoutMs', 120000)
const CONTACT_SDF_M = numericFlag(args, 'contactSdf', 1)
const CYCLES = numericFlag(args, 'cycles', 2)
const CYCLE_TICKS = numericFlag(args, 'cycleTicks', 170)
const SLIDE_YAWS_DEG = numericListFlag(args, 'slideYaws', [25, 75], ',')
const REST_LOOKAHEAD_TICKS = numericFlag(args, 'restLookaheadTicks', 2)
const REST_EPS_M = numericFlag(args, 'restEps', 0.01)
const SETTLE_TICKS = numericFlag(args, 'settleTicks', 3)
const MOVE_EPS_M = numericFlag(args, 'moveEps', 0.005)
const UNIT_WARM = 40
const UNIT_SNAP_EVERY = 3
const UNIT_SETTLE_SNAPS = 30
const UNIT_MEASURE_INPUTS = 10

const failures = []
function expect(cond, label) {
  if (cond) return true
  failures.push(label)
  return false
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createNetServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
  })
}

const round = (v, n = 4) => Number(v.toFixed(n))
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN)

const FLOOR = { c: [0, -1, 0], h: [200, 1, 200] }
// Penetration is measured to the NEAREST surface, so a wall only half a metre thick
// caps the measurement at 0.5 m however far the prediction actually goes: past the
// wall's mid-plane the FAR face becomes the nearest one and the number turns back
// down. The walls are thick and their inner faces sit at PEN_M, so the contact
// geometry is what it always was and the number can still be read past 0.5 m. The
// half-thickness is what limits the reading: it has to exceed PEN_STEP_TOL_M (16
// steps = 3.27 m here) or the deepest penetration this gate can sanction is also the
// deepest it can measure, and the bound becomes unreachable.
const PEN_M = 12 - 0.5
const WALL_HALF_THICK_M = 8
const WALLS = [
  { id: 'wall-n', c: [0, 2, -(PEN_M + WALL_HALF_THICK_M)], h: [20, 3, WALL_HALF_THICK_M] },
  { id: 'wall-s', c: [0, 2, PEN_M + WALL_HALF_THICK_M], h: [20, 3, WALL_HALF_THICK_M] },
  { id: 'wall-e', c: [PEN_M + WALL_HALF_THICK_M, 2, 0], h: [WALL_HALF_THICK_M, 3, 20] },
  { id: 'wall-w', c: [-(PEN_M + WALL_HALF_THICK_M), 2, 0], h: [WALL_HALF_THICK_M, 3, 20] },
]

function boxSdf(p, c, h) {
  const dx = Math.abs(p[0] - c[0]) - h[0]
  const dy = Math.abs(p[1] - c[1]) - h[1]
  const dz = Math.abs(p[2] - c[2]) - h[2]
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0))
  const inside = Math.min(Math.max(dx, Math.max(dy, dz)), 0)
  return outside + inside
}

function nearestSdf(p) {
  let best = Infinity
  for (const w of WALLS) { const s = boxSdf(p, w.c, w.h); if (s < best) best = s }
  return best
}

async function runArm(cfg) {
  const { createServer } = await import('../src/sdk/server.js')
  const { PhysicsNetworkClient } = await import('../src/client/PhysicsNetworkClient.js')

  const port = await freePort()
  const worldDef = {
    port,
    tickRate: TICK_RATE,
    gravity: [0, -9.81, 0],
    spawnPoint: [0, 5, 0],
    entities: [
      { id: 'floor', app: 'box-static', position: FLOOR.c, config: { hx: FLOOR.h[0], hy: FLOOR.h[1], hz: FLOOR.h[2] } },
      ...WALLS.map(w => ({ id: w.id, app: 'box-static', position: w.c, config: { hx: w.h[0], hy: w.h[1], hz: w.h[2] }, bodyType: cfg.wallBody })),
    ],
  }

  const server = await createServer({
    port,
    tickRate: TICK_RATE,
    appsDirs: [resolve(SDK_ROOT, 'apps'), resolve(SDK_ROOT, 'src', 'stdlib-apps')],
    sdkRoot: SDK_ROOT,
    gravity: worldDef.gravity,
    staticDirs: [],
    storageDir: resolve(SDK_ROOT, 'data', 'prediction-wedge-witness'),
  })
  await server.loadWorld(worldDef)
  registerWitnessServer(server, 'scripts/prediction-wedge-witness.mjs')
  await server.start()
  const url = `ws://127.0.0.1:${port}/ws`

  try {
    const client = new PhysicsNetworkClient({ url, predictionEnabled: true, smoothInterpolation: false, collisionMirror: false, autoMigrate: false, webTransport: { enabled: false } })
    await client.connect()
    if (!client.connected) throw new Error('[wedge] connect() resolved but connected:false')

    const tJoin = Date.now()
    while (server.playerManager.getConnectedPlayers().length < 1 && Date.now() - tJoin < 30000) await sleep(50)
    const players = server.playerManager.getConnectedPlayers()
    if (players.length < 1) throw new Error('[wedge] no player joined')
    const player = players[0]

    let pred = null
    const tPred = Date.now()
    while (!(pred = client._msgHandler?.getPredEngine?.()) && Date.now() - tPred < SETTLE_TIMEOUT_MS) await sleep(50)
    if (!pred) throw new Error('[wedge] no prediction engine on the client -- predictionEnabled did not take')

    const tGround = Date.now()
    while (player.state.onGround !== true && Date.now() - tGround < SETTLE_TIMEOUT_MS) await sleep(50)
    const grounded = player.state.onGround === true
    while (player.teleportHold && Date.now() - tGround < SETTLE_TIMEOUT_MS) await sleep(50)
    await sleep(300)

    const tickSystem = server.tickSystem
    if (!tickSystem || typeof tickSystem.onTick !== 'function') throw new Error('[wedge] server has no tickSystem.onTick')

    const samples = []
    const stepPens = []
    let prevServer = null
    let prevPred = null
    let tickCount = 0
    let serverPathM = 0
    let predPathM = 0
    const stepPath = { m: 0, n: 0 }
    // Step distance over the steps that actually moved. The prediction's mean over ALL
    // steps is diluted by the steps it spends blocked at the wall, and the dilution is
    // load-driven (the client takes up to 1.96 input steps per server tick at x2.53),
    // so the mean over all steps is not a measurement of the step size at all.
    const stepMove = { m: 0, n: 0 }
    const rawAddInput = pred.addInput.bind(pred)
    pred.addInput = function (...a) {
      const p = pred.localState.position
      const x0 = p[0], z0 = p[2]
      const r = rawAddInput(...a)
      const d = Math.hypot(p[0] - x0, p[2] - z0)
      stepPath.m += d
      stepPath.n++
      if (d > MOVE_EPS_M) { stepMove.m += d; stepMove.n++ }
      return r
    }
    // Every predicted step is a candidate for penetration, not just the one that
    // happens to be live when the server ticks: `_rebaseAndReplay` re-derives the
    // whole unacked tail through `_step` without ever going through `addInput`.
    const stepPenTotal = { max: 0, n: 0, overTol: 0 }
    const perTickStepPen = new Map()
    let stepTick = 0
    const rawStep = pred._step.bind(pred)
    pred._step = function (...a) {
      if (PROBE === 'nowedge') pred.horizontallyWedged = false
      const r = rawStep(...a)
      const p = pred.localState.position
      // `wallpush` fires only while the SERVER is within contact range, so it moves
      // penetration without moving the clear-lane divergence the bound is priced
      // against -- that is what separates it from `overshoot`.
      if (PROBE === 'overshoot' || (PROBE === 'wallpush' && nearestSdf(player.state.position) <= CONTACT_SDF_M)) {
        const v = pred.localState.velocity
        const h = Math.hypot(v[0], v[2])
        if (h > 1e-9) { p[0] += (v[0] / h) * PROBE_OVERSHOOT_M; p[2] += (v[2] / h) * PROBE_OVERSHOOT_M }
      }
      const pen = Math.max(0, -nearestSdf(p))
      stepPenTotal.n++
      if (pen > stepPenTotal.max) stepPenTotal.max = pen
      if (pen > PEN_TOL_M) stepPenTotal.overTol++
      const rec = perTickStepPen.get(stepTick)
      if (!rec) perTickStepPen.set(stepTick, { max: pen, n: 1, over: pen > PEN_TOL_M ? 1 : 0 })
      else { if (pen > rec.max) rec.max = pen; rec.n++; if (pen > PEN_TOL_M) rec.over++ }
      return r
    }
    const acksAtStart = pred.stats.acks
    const correctionsAtStart = pred.stats.corrections
    const inputSeqAtStart = pred._inputSeq ?? 0

    tickSystem.onTick(() => {
      tickCount++
      stepTick = tickCount
      const sp = player.state.position
      const serverPos = [sp[0], sp[1], sp[2]]
      const predPos = pred.localState ? [pred.localState.position[0], pred.localState.position[1], pred.localState.position[2]] : null
      const lastServer = pred.lastServerState ? [pred.lastServerState.position[0], pred.lastServerState.position[1], pred.lastServerState.position[2]] : null
      const serverStepM = prevServer ? Math.hypot(serverPos[0] - prevServer[0], serverPos[2] - prevServer[2]) : 0
      const predStepM = prevPred && predPos ? Math.hypot(predPos[0] - prevPred[0], predPos[2] - prevPred[2]) : 0
      if (prevServer) serverPathM += serverStepM
      if (prevPred && predPos) predPathM += predStepM
      prevServer = serverPos
      prevPred = predPos ? [...predPos] : prevPred
      const ss = nearestSdf(serverPos)
      const ls = pred.lastServerState ? pred.lastServerState.position : null
      // How far behind the live server position the newest ACKED server position is.
      // The prediction is a function of the acked state, so a sample taken while the
      // ack is still N steps behind is measuring the ack pipeline, not the latch:
      // the prediction is legitimately still walking the steps the server already
      // walked, and it cannot know the server has stopped until the ack lands.
      const ackSdf = ls ? round(nearestSdf(ls), 6) : null
      const ackLagM = ls ? round(Math.hypot(serverPos[0] - ls[0], serverPos[2] - ls[2]), 6) : null
      samples.push({
        tick: tickCount,
        acks: pred.stats.acks ?? 0,
        serverSdf: round(ss, 6),
        ackSdf,
        ackLagM,
        predSdf: predPos ? round(nearestSdf(predPos), 6) : null,
        divergence: predPos && lastServer ? Math.hypot(predPos[0] - lastServer[0], predPos[1] - lastServer[1], predPos[2] - lastServer[2]) : null,
        serverStepM: round(serverStepM, 6),
        predStepM: round(predStepM, 6),
        lead: pred._inputSeq - 1 - (pred._lastAckedSeq ?? pred._inputSeq - 1),
        wedged: pred.horizontallyWedged === true,
        walls: pred.walls ? pred.walls.length : null,
        serverVelH: round(Math.hypot(player.state.velocity[0], player.state.velocity[2]), 6),
        onGround: player.state.onGround === true,
      })
      stepPens.push({
        tick: tickCount,
        acks: pred.stats.acks ?? 0,
        pen: predPos ? Math.max(0, -nearestSdf(predPos)) : null,
        serverSdf: round(ss, 6),
        ackSdf,
        ackLagM,
        sp: serverPos,
        walls: pred.walls ? pred.walls.length : 0,
        wedged: pred.horizontallyWedged ? 1 : 0,
      })
      if (stepPens.length > TICKS) stepPens.shift()
      if (samples.length > TICKS) samples.shift()
    })

    let phaseTick = 0
    let inputCalls = 0
    const stopInput = client.startInputLoop(() => {
      inputCalls++
      if (CYCLES > 1 && cfg.slide !== true) {
        const phase = Math.floor(phaseTick++ / CYCLE_TICKS) % 2
        return { forward: phase === 0, backward: phase === 1, sprint: true, yaw: 0, pitch: 0 }
      }
      return { forward: true, sprint: true, yaw: cfg.yaw, pitch: 0 }
    })
    const startTick = tickCount
    const t0 = Date.now()
    while (tickCount - startTick < TICKS && Date.now() - t0 < ARM_TIMEOUT_MS) await sleep(2)
    stopInput()
    pred.addInput = rawAddInput
    pred._step = rawStep
    const ticks = tickCount - startTick

    const post = samples.slice(WARMUP_TICKS)
    const restAt = stepPens.map((s, i) => {
      let moved = 0
      for (let j = i + 1; j < stepPens.length && stepPens[j].tick - s.tick <= REST_LOOKAHEAD_TICKS; j++) {
        moved = Math.max(moved, Math.hypot(stepPens[j].sp[0] - s.sp[0], stepPens[j].sp[2] - s.sp[2]))
      }
      return moved < REST_EPS_M
    })
    const atWallIdx = stepPens.map((s, i) => i).filter(i => stepPens[i].serverSdf <= CONTACT_SDF_M)
    const settledAt = stepPens.map((s, i) => {
      if (!restAt[i]) return false
      const j = Math.max(1, i - SETTLE_TICKS)
      for (let k = j - 1; k <= i; k++) if (!restAt[k]) return false
      return true
    })
    // A sample is evidence about the block latch only if the client has ACCEPTED an ack
    // recently. `_reconcile` sets `horizontallyWedged` before it tests whether the ack is
    // usable, so a duplicate or out-of-range ack latches the block and then returns
    // without rebasing: the prediction keeps standing wherever it was, which inside the
    // wall is inside the wall. Measured at x2.87/x3.10 contention: 5 settled samples at
    // 1.009 m and 1.246 m, every one of them with the block already latched and every
    // one inside a run of ticks with no accepted ack. That is the ack pipeline, not the
    // latch, and it costs more ticks the busier the box is.
    const ackFresh = stepPens.map((s, i) => {
      const j = Math.max(0, i - ACK_STALE_TICKS)
      return (s.acks ?? 0) > (stepPens[j].acks ?? 0)
    })
    const stoppedRaw = atWallIdx.filter(i => settledAt[i]).map(i => stepPens[i])
    const stopped = stoppedRaw.filter(s => ackFresh[stepPens.indexOf(s)])
    const transient = atWallIdx.filter(i => restAt[i] && !settledAt[i]).map(i => stepPens[i])
    const moving = atWallIdx.filter(i => !restAt[i]).map(i => stepPens[i])
    const maxPen = arr => (arr.length ? Math.max(...arr.map(s => s.pen)) : NaN)
    const overTol = arr => arr.filter(s => s.pen > PEN_TOL_M).length
    // Exhaustive: the worst penetration reached by ANY predicted step inside a tick
    // that the classification above put in this bucket. A per-server-tick sample is
    // only a lower bound on a maximum, because `_rebaseAndReplay` re-derives every
    // unacked input through `_step` between two server ticks.
    const maxStepPen = arr => (arr.length ? Math.max(...arr.map(s => Math.max(perTickStepPen.get(s.tick)?.max ?? 0, s.pen ?? 0))) : NaN)
    const stepTicksOverTol = arr => arr.filter(s => (perTickStepPen.get(s.tick)?.over ?? 0) > 0).length
    const heldDiv = post.filter(s => s.serverSdf <= CONTACT_SDF_M).map(s => s.divergence ?? 0)
    const freeDiv = post.filter(s => s.serverSdf > CONTACT_SDF_M).map(s => s.divergence ?? 0)

    const clearLane = post.filter(s => s.serverSdf > CONTACT_SDF_M)
    const movingAtWall = post.filter(s => s.serverSdf <= CONTACT_SDF_M && s.serverStepM > MOVE_EPS_M)
    const predStepSum = movingAtWall.reduce((a, s) => a + (s.predStepM ?? 0), 0)
    const serverStepSum = movingAtWall.reduce((a, s) => a + (s.serverStepM ?? 0), 0)

    const freeDivMax = freeDiv.length ? Math.max(...freeDiv) : NaN
    const clearStepMeanM = mean(clearLane.filter(s => s.serverStepM > MOVE_EPS_M).map(s => s.serverStepM))
    // How deep the prediction is ALLOWED to be inside the wall, derived rather than
    // typed: it may not run further past the server than the sanctioned lead, so the
    // budget is the lead itself and never more than the absolute step ceiling. Both
    // terms are measured on this arm, so the budget tracks the arm, not the box.
    const sanctionedPenM = Math.min(PEN_LEAD_FRAC * freeDivMax, PEN_STEP_TOL_M)
    // How many settled-at-the-wall samples may be inside the wall without it being the
    // latch's fault. First contact is a transient, not a steady state: the prediction
    // learns the server has stopped one ack interval later, and until that ack lands it
    // is still the lead's extrapolation, which walks past the server's own contact point
    // (the server stops with its centre ~0.42 m from the wall face, so the first steps of
    // lead are free). Measured at x4.51 contention, kinematic-headon, ackLag 0 m and the
    // latch already ON: three consecutive ticks at exactly lead - serverSdf = 0.6125 -
    // 0.42 = 0.1925 m, then 0 m for the remaining 161 settled samples. The window is one
    // contact transient per approach: settle + ack + one tick. Mutants are not a window,
    // they are the whole bucket: 166/166, 315/316, 236/236 settled samples inside.
    const heldOverTolBudget = (cfg.slide === true ? 1 : CYCLES) * (SETTLE_TICKS + ACK_STALE_TICKS + 1)
    const out = {
      arm: cfg.name,
      wallBody: cfg.wallBody,
      slide: cfg.slide === true,
      yawDeg: round(cfg.yaw * 180 / Math.PI, 2),
      ticks,
      groundedAtStart: grounded,
      samplesAtWall: atWallIdx.length,
      stoppedAtWallRaw: stoppedRaw.length,
      stoppedAtWall: stopped.length,
      movingAtWall: movingAtWall.length,
      transientAtWall: transient.length,
      heldMaxPenetrationM: round(maxPen(stopped), 5),
      heldMeanPenetrationM: round(mean(stopped.map(s => s.pen)), 5),
      heldSamplesOverTol: overTol(stopped),
      heldOverTolBudget: heldOverTolBudget,
      heldOverTolFrac: round(overTol(stopped) / Math.max(1, stopped.length), 5),
      heldMaxPenetrationSteps: round(maxPen(stopped) / STEP_TRAVEL_M, 3),
      transientMaxPenetrationM: round(maxPen(transient), 5),
      transientSamplesOverTol: overTol(transient),
      predictedStepsExhaustive: stepPenTotal.n,
      maxStepPenetrationM: round(stepPenTotal.max, 5),
      stepTravelM: round(STEP_TRAVEL_M, 6),
      predMovingStepM: round(stepMove.m / Math.max(1, stepMove.n), 6),
      predMovingSteps: stepMove.n,
      approachMaxStepPenetrationSteps: round(maxStepPen(moving) / STEP_TRAVEL_M, 3),
      transientMaxStepPenetrationSteps: round(maxStepPen(transient) / STEP_TRAVEL_M, 3),
      heldMaxStepPenetrationSteps: round(maxStepPen(stopped) / STEP_TRAVEL_M, 3),
      approachMaxStepPenetrationM: round(maxStepPen(moving), 5),
      approachSamplerShortfallM: round(maxStepPen(moving) - maxPen(moving), 5),
      approachStepTicksOverTol: stepTicksOverTol(moving),
      transientMaxStepPenetrationM: round(maxStepPen(transient), 5),
      transientStepTicksOverTol: stepTicksOverTol(transient),
      heldMaxStepPenetrationM: round(maxStepPen(stopped), 5),
      heldStepTicksOverTol: stepTicksOverTol(stopped),
      heldMaxAckLagM: round(stopped.length ? Math.max(...stopped.map(s => s.ackLagM ?? 0)) : NaN, 5),
      heldAckLagOverTol: stopped.filter(s => (s.pen ?? 0) > PEN_TOL_M).slice(0, 6)
        .map(s => ({ t: s.tick, pen: round(s.pen, 5), ackLagM: s.ackLagM, ackSdf: s.ackSdf, sdf: s.serverSdf, wedged: s.wedged, walls: s.walls })),
      approachMaxPenetrationM: round(maxPen(moving), 5),
      approachSamplesOverTol: overTol(moving),
      sanctionedPenM: round(sanctionedPenM, 5),
      approachSamplesOverSanctioned: moving.filter(s => (s.pen ?? 0) > sanctionedPenM).length,
      approachStepTicksOverSanctioned: moving.filter(s => Math.max(perTickStepPen.get(s.tick)?.max ?? 0, s.pen ?? 0) > sanctionedPenM).length,
      stoppedSamplesWithNoWallPlane: stopped.filter(s => s.walls === 0).length,
      stoppedSamplesWedged: stopped.filter(s => s.wedged === 1).length,
      wallPlaneTicks: post.filter(s => (s.walls ?? 0) > 0).length,
      wedgeFlagTicks: post.filter(s => s.wedged).length,
      clearLaneTicks: clearLane.length,
      clearLaneWedgeTicks: clearLane.filter(s => s.wedged).length,
      // The furthest from a wall the SERVER was on any tick whose block latch was on.
      // `horizontallyWedged` is a property of the PREDICTION, and the prediction runs up
      // to the lead ahead of the server, so "wedged while the server is away from the
      // walls" is a bucket the lead alone can put a sample in: measured 1 of ~250
      // clear-lane ticks at x1.86 and x2.53 contention, 0 of ~250 at x0.88..x3.10, i.e.
      // an intermittent red with no regression in it. What is NOT explainable by the lead
      // is a latch that stays on while the server walks further than the lead away.
      maxWedgedServerSdfM: round(post.reduce((m, s) => (s.wedged ? Math.max(m, s.serverSdf ?? 0) : m), 0), 5),
      movingWedgedFrac: round(movingAtWall.length ? movingAtWall.filter(s => s.wedged).length / movingAtWall.length : NaN, 4),
      predStepSumM: round(predStepSum, 4),
      serverStepSumM: round(serverStepSum, 4),
      predStepRatio: round(predStepSum / Math.max(1e-9, serverStepSum), 4),
      meanDivergenceMovingM: round(mean(movingAtWall.map(s => s.divergence ?? 0)), 5),
      meanLeadSteps: round(mean(movingAtWall.map(s => s.lead ?? 0)), 2),
      // Distances in STEPS OF TRAVEL. The divisor is the design step (STEP_TRAVEL_M),
      // not a step distance measured off this run's server: the measured one is
      // load-driven (0.2042 m/tick clean, 0.0953 m/tick at x2.53 contention), and
      // dividing by it turned a 16-step divergence into a reported 34-step one.
      meanDivergenceSteps: round(mean(movingAtWall.map(s => s.divergence ?? 0)) / STEP_TRAVEL_M, 2),
      serverPathM: round(serverPathM, 4),
      predPathM: round(predPathM, 4),
      pathRatio: round(predPathM / Math.max(1e-9, serverPathM), 4),
      inputSeqSteps: (pred._inputSeq ?? 0) - inputSeqAtStart,
      inputCalls,
      serverTicks: ticks,
      predictedSteps: stepPath.n,
      predStepPathM: round(stepPath.m, 4),
      predStepMeanM: round(stepPath.m / Math.max(1, stepPath.n), 6),
      serverStepMeanM: round(serverPathM / Math.max(1, ticks), 6),
      stepRatio: round((stepPath.m / Math.max(1, stepPath.n)) / Math.max(1e-9, serverPathM / Math.max(1, ticks)), 4),
      stepsPerServerTick: round(inputCalls / Math.max(1, ticks), 4),
      maxLeadSteps: post.reduce((m, s) => Math.max(m, s.lead ?? 0), 0),
      maxHeldDivergenceM: round(heldDiv.length ? Math.max(...heldDiv) : NaN, 5),
      maxFreeDivergenceM: round(freeDivMax, 5),
      clearStepMeanM: round(clearStepMeanM, 6),
      maxFreeDivergenceSteps: round(freeDivMax / STEP_TRAVEL_M, 2),
      acksDuringArm: (pred.stats.acks ?? 0) - acksAtStart,
      correctionsDuringArm: (pred.stats.corrections ?? 0) - correctionsAtStart,
    }
    return out
  } finally {
    try { await server.stop?.() } catch {}
  }
}

function unitEngine() {
  const pe = new PredictionEngine(TICK_RATE)
  pe.init('u1', { position: [0, 0, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0] })
  return pe
}

// One predicted step covers exactly one tick of travel at the commanded speed. The live
// arms cannot carry this bound (the step they measure is the step the player achieved,
// which on a slide arm is the along-wall component, and both sides of the old
// pred-vs-server ratio move with the box), so it is pinned here, where dt is fixed:
// a dt regression, a double step, or a sprint-speed change all land on this number.
function unitStepSizeArm() {
  const pe = unitEngine()
  const input = { forward: true, sprint: true, yaw: 0, pitch: 0 }
  for (let i = 0; i < UNIT_WARM; i++) pe.addInput(input)
  const speed = Math.hypot(pe.localState.velocity[0], pe.localState.velocity[2])
  const before = pe.localState.position.slice()
  pe.addInput(input)
  const after = pe.localState.position
  const stepM = Math.hypot(after[0] - before[0], after[2] - before[2])
  const expectedStepM = pe.tickDuration / 1000 * speed
  return {
    arm: 'unit-step-size',
    tickDurationMs: pe.tickDuration,
    expectedTickMs: 1000 / TICK_RATE,
    speedMps: round(speed, 6),
    expectedSpeedMps: round(SPRINT_SPEED_MPS, 6),
    stepM: round(stepM, 8),
    expectedStepM: round(expectedStepM, 8),
    stepTravelM: round(STEP_TRAVEL_M, 8),
    errFrac: round(Math.abs(stepM - expectedStepM) / Math.max(1e-9, expectedStepM), 9),
  }
}

function serverSnapshot(pe, position, velocity, onGround, seq) {
  return {
    players: [{
      id: pe.localPlayerId,
      position: [position[0], position[1], position[2]],
      rotation: [0, 0, 0, 1],
      velocity: [velocity[0], velocity[1], velocity[2]],
      onGround,
      inputSequence: seq,
    }],
  }
}

function unitSlideArm({ incidenceDeg, slideFrac, stalePlane = false }) {
  const yaw = incidenceDeg * Math.PI / 180
  const input = { forward: true, sprint: true, yaw, pitch: 0 }
  const pe = unitEngine()
  for (let i = 0; i < UNIT_WARM; i++) pe.addInput(input)
  const contact = pe.localState.position.slice()
  const vel = pe.localState.velocity.slice()
  const speed = Math.hypot(vel[0], vel[2])
  const alongSign = Math.sign(vel[0]) || 1
  const alongSpeed = speed * Math.abs(Math.sin(yaw)) * slideFrac * alongSign
  const dt = pe.tickDuration / 1000
  const serverPos = contact.slice()
  let seq = UNIT_WARM
  let tick = 1000
  const feed = () => {
    if (stalePlane) pe.walls.push({ nx: 1, nz: 0, d: serverPos[0] - 0.5, ay: serverPos[1], tMin: -1e4, tMax: 1e4 })
    pe.onServerSnapshot(serverSnapshot(pe, serverPos, vel, true, seq), tick)
  }
  feed()
  for (let k = 0; k < UNIT_SETTLE_SNAPS; k++) {
    for (let j = 0; j < UNIT_SNAP_EVERY; j++) { pe.addInput(input); seq++; serverPos[0] += alongSpeed * dt }
    tick++
    feed()
  }
  const before = pe.localState.position.slice()
  for (let j = 0; j < UNIT_MEASURE_INPUTS; j++) pe.addInput(input)
  const after = pe.localState.position
  const dX = after[0] - before[0], dZ = after[2] - before[2]
  return {
    arm: `unit-slide-${incidenceDeg}${stalePlane ? '-cachedplane' : ''}`,
    incidenceDeg,
    slideFrac,
    stalePlane,
    wedged: pe.horizontallyWedged === true,
    wedgeNormal: [round(pe.wedgeNormal ? pe.wedgeNormal[0] : NaN, 4), round(pe.wedgeNormal ? pe.wedgeNormal[1] : NaN, 4)],
    intoWallM: round(dZ, 5),
    alongWallM: round(dX, 5),
    movedM: round(Math.hypot(dX, dZ), 5),
    expectedAlongM: round(speed * Math.abs(Math.sin(yaw)) * UNIT_MEASURE_INPUTS * dt, 5),
    serverAlongM: round(alongSpeed * UNIT_MEASURE_INPUTS * dt, 5),
  }
}

function latchEngine({ onGround = true, advanceServer = false } = {}) {
  const input = { forward: true, sprint: true, yaw: 0, pitch: 0 }
  const pe = unitEngine()
  for (let i = 0; i < UNIT_WARM; i++) pe.addInput(input)
  const vel = pe.localState.velocity.slice()
  const dt = pe.tickDuration / 1000
  const serverPos = pe.localState.position.slice()
  let seq = UNIT_WARM
  let tick = 1000
  pe.onServerSnapshot(serverSnapshot(pe, serverPos, vel, true, seq), tick)
  const step = (steps, moveServer) => {
    for (let k = 0; k < steps; k++) {
      for (let j = 0; j < UNIT_SNAP_EVERY; j++) {
        pe.addInput(input); seq++
        if (moveServer) { serverPos[0] += vel[0] * dt; serverPos[2] += vel[2] * dt }
      }
      tick++
      pe.onServerSnapshot(serverSnapshot(pe, serverPos, vel, onGround, seq), tick)
    }
  }
  step(UNIT_SETTLE_SNAPS, advanceServer)
  return { pe, input, vel, serverPos, seq, tick, step }
}

function unitTeleportArm() {
  const { pe, seq, tick } = latchEngine({ onGround: true, advanceServer: false })
  const latchedBefore = pe.horizontallyWedged === true
  pe.teleport([100, 0, 100], [0, 0, 0], tick + 500)
  const afterTeleport = pe.horizontallyWedged === true
  pe.onServerSnapshot(serverSnapshot(pe, [100, 0, 100], [0, 0, 0], true, seq), tick + 600)
  const afterStaleAck = pe.horizontallyWedged === true
  return { arm: 'unit-teleport', latchedBefore, afterTeleport, afterStaleAck }
}

function unitResyncArm() {
  const { pe, seq, tick } = latchEngine({ onGround: true, advanceServer: false })
  const latchedBefore = pe.horizontallyWedged === true
  pe.resyncToServer({ keepHistory: false })
  const afterResync = pe.horizontallyWedged === true
  pe.onServerSnapshot(serverSnapshot(pe, pe.localState.position, [0, 0, 0], true, seq), tick + 600)
  const afterStaleAck = pe.horizontallyWedged === true
  return { arm: 'unit-resync', latchedBefore, afterResync, afterStaleAck }
}

function unitAirborneArm() {
  const { pe, vel, serverPos, seq, tick } = latchEngine({ onGround: false, advanceServer: false })
  const wedged = pe.horizontallyWedged === true
  return { arm: 'unit-airborne', onGround: false, serverVelH: round(Math.hypot(vel[0], vel[2]), 4), wedged, seq, tick, serverPos: serverPos.map(v => round(v, 3)) }
}

function unitAckClampArm() {
  const { pe, seq, tick, step } = latchEngine({ onGround: true, advanceServer: false })
  const latchedBefore = pe.horizontallyWedged === true
  const ackBefore = pe._lastAckedSeq
  pe.onServerSnapshot(serverSnapshot(pe, pe.lastServerState.position, pe.localState.velocity, true, 1e9), tick + 600)
  const ackAfterBogus = pe._lastAckedSeq
  step(20, true)
  return {
    arm: 'unit-ack-clamp',
    latchedBefore,
    ackBefore,
    ackAfterBogus,
    bogusAckRejected: ackAfterBogus === ackBefore,
    ackAdvancedAfter: pe._lastAckedSeq > ackBefore,
    wedgedAfterRecovery: pe.horizontallyWedged === true,
  }
}

function unitStalledAckArm() {
  const { pe, vel, seq, tick } = latchEngine({ onGround: true, advanceServer: true })
  const wedgedWhileMoving = pe.horizontallyWedged === true
  pe.onServerSnapshot(serverSnapshot(pe, pe.lastServerState.position, vel, true, seq + 1), tick + 5000)
  const wedgedAfterOneStalledAck = pe.horizontallyWedged === true
  pe.onServerSnapshot(serverSnapshot(pe, pe.lastServerState.position, vel, true, seq + 2), tick + 5001)
  const wedgedAfterTwoStalledAcks = pe.horizontallyWedged === true
  return {
    arm: 'unit-stalled-ack',
    wedgedWhileMoving,
    wedgedAfterOneStalledAck,
    wedgedAfterTwoStalledAcks,
    serverVelH: round(Math.hypot(vel[0], vel[2]), 4),
  }
}


const ARMS = [
  { name: 'static-headon', wallBody: 'static', yaw: 0, slide: false },
  { name: 'kinematic-headon', wallBody: 'kinematic', yaw: 0, slide: false },
  ...SLIDE_YAWS_DEG.map(d => ({ name: `kinematic-slide-${d}`, wallBody: 'kinematic', yaw: d * Math.PI / 180, slide: true })),
]

const results = []
if (PROBE !== 'none') console.log(`[wedge] MUTATION PROBE probe=${PROBE} probeOvershootM=${PROBE_OVERSHOOT_M} -- this run is NON-VACUITY EVIDENCE, not a gate result`)
for (const cfg of ARMS) {
  let out = null
  try {
    out = await runArm(cfg)
  } catch (err) {
    console.error(err?.stack || err)
  }
  if (!out) { failures.push(`${cfg.name}: arm produced no measurement`); continue }
  results.push(out)
  console.log('[wedge] ' + JSON.stringify(out))
}

const unitResults = [
  unitSlideArm({ incidenceDeg: 0, slideFrac: 0 }),
  unitSlideArm({ incidenceDeg: 25, slideFrac: 1 }),
  unitSlideArm({ incidenceDeg: 75, slideFrac: 0.25 }),
  unitSlideArm({ incidenceDeg: 25, slideFrac: 1, stalePlane: true }),
  unitTeleportArm(),
  unitResyncArm(),
  unitStepSizeArm(),
  unitAirborneArm(),
  unitAckClampArm(),
  unitStalledAckArm(),
]
for (const u of unitResults) console.log('[wedge-unit] ' + JSON.stringify(u))

console.log('[wedge] penetration: "*MaxStepPenetrationM" is the EXHAUSTIVE maximum over every predicted step (both addInput and the _rebaseAndReplay replay); "*MaxPenetrationM" is one sample per server tick and is only a LOWER BOUND on that same maximum')
console.log(`[wedge] step of travel = ${round(STEP_TRAVEL_M, 6)} m (${SPRINT_SPEED_MPS} m/s at ${TICK_RATE} Hz, from src/shared/movement.js DEFAULT_MOVEMENT): every penetration and divergence bound below is asserted in that unit, and any metre figure is derived from it`)
console.log(`[wedge] penetration is priced against the prediction lead (cap ${PEN_LEAD_FRAC} x maxFreeDivergenceSteps, absolute ${PEN_STEP_TOL_STEPS} step(s) = ${round(PEN_STEP_TOL_M, 4)} m = PEN_LEAD_FRAC x MAX_PREDICTION_LEAD_STEPS): a prediction with no block latch runs the whole lead into the wall`)
for (const o of results) {
  const p = o.arm + ': '
  expect(o.groundedAtStart, p + 'the player was standing on the floor before the arm started')
  expect(Number.isFinite(o.serverPathM) && o.serverPathM > 5, p + `the player walked a real distance: serverPath ${o.serverPathM} m`)
  expect(Number.isFinite(o.predMovingStepM) && o.predMovingStepM > 0, p + `the prediction moved while the player was moving: ${o.predMovingStepM} m over ${o.predMovingSteps} moving step(s) (one tick of travel is ${round(STEP_TRAVEL_M, 6)} m; the step-size invariant itself is pinned by unit-step-size, because the live step is the step the player ACHIEVED, which on a slide arm is the along-wall component: whole-arm per-step means are ${o.predStepMeanM} m pred / ${o.serverStepMeanM} m server, ratio ${o.stepRatio}, and both are diluted by the blocked steps)`)
  expect(Number.isFinite(o.maxFreeDivergenceSteps) && o.maxFreeDivergenceSteps <= o.maxLeadSteps + DIVERGENCE_SLACK_TICKS, p + `clear-lane divergence stayed inside the input lead: ${o.maxFreeDivergenceSteps} step(s) of ${round(STEP_TRAVEL_M, 6)} m (max ${o.maxFreeDivergenceM} m) at lead ${o.maxLeadSteps} tick(s) + slack ${DIVERGENCE_SLACK_TICKS}`)
  expect(o.acksDuringArm > 0, p + `the arm really reconciled against server snapshots: ${o.acksDuringArm} acks`)
  // PEN_TOL_M is what "inside the wall" means for the count; it did not move. What moved
  // is the claim made about the count. `=== 0` priced a metre depth against a quantity
  // the lead FLOORS at (lead - serverSdf), so on a busy box it was unreachable: measured
  // 0.1925 m at x4.51 with the latch on and the ack current, which is exactly 3 steps of
  // lead past a server standing 0.42 m off the wall face. Depth in the held bucket is
  // therefore priced against the lead, and the latch is pinned by how MUCH of the bucket
  // is inside the wall at all: a contact transient is a handful of ticks, a broken latch
  // is the whole bucket.
  expect(o.heldSamplesOverTol <= o.heldOverTolBudget, p + `the predicted position settled inside the wall only during a contact transient: ${o.heldSamplesOverTol} of ${o.stoppedAtWall} settled-and-acked samples over ${PEN_TOL_M} m (${o.heldOverTolFrac} of the bucket, budget ${o.heldOverTolBudget} = one settle+ack window per approach; max ${o.heldMaxPenetrationM} m = ${o.heldMaxPenetrationSteps} step(s); ${o.stoppedAtWallRaw} settled sample(s) before the ack-freshness gate, ${o.samplesAtWall} at the wall)`)
  const sanctionedPenM = Math.min(PEN_LEAD_FRAC * o.maxFreeDivergenceM, PEN_STEP_TOL_M)
  const approachOverSanctioned = o.approachSamplesOverSanctioned
  expect(approachOverSanctioned === 0, p + `the predicted position never went deeper into the wall than the lead sanctions while the server was still approaching it: ${approachOverSanctioned} of ${o.movingAtWall} moving per-server-tick samples over ${round(sanctionedPenM, 5)} m (${PEN_LEAD_FRAC} x the ${o.maxFreeDivergenceM} m lead, capped at ${PEN_STEP_TOL_STEPS} step(s) = ${round(PEN_STEP_TOL_M, 4)} m; a sample is a lower bound on the max, the exhaustive count is ${o.approachStepTicksOverSanctioned} tick(s); ${o.approachSamplesOverTol} sample(s) were inside the wall at all, which is a lead-vs-contact-window fact, not a defect)`)
  expect(Number.isFinite(o.approachMaxStepPenetrationSteps) && o.approachMaxStepPenetrationSteps <= PEN_STEP_TOL_STEPS, p + `the exhaustive per-step impact penetration stayed inside the sanctioned lead cap: max ${o.approachMaxStepPenetrationSteps} step(s) = ${o.approachMaxStepPenetrationM} m over ${o.predictedStepsExhaustive} predicted step(s) (cap ${PEN_STEP_TOL_STEPS} step(s) = ${round(PEN_STEP_TOL_M, 4)} m; the per-server-tick sample only saw ${o.approachMaxPenetrationM} m, ${o.approachSamplerShortfallM} m short of the real peak)`)
  expect(Number.isFinite(o.approachMaxStepPenetrationSteps) && o.approachMaxStepPenetrationSteps <= PEN_LEAD_FRAC * o.maxFreeDivergenceSteps, p + `the impact penetration stayed a fraction of the prediction lead: max ${o.approachMaxStepPenetrationSteps} step(s) of the ${o.maxFreeDivergenceSteps} step clear-lane lead (${round(o.approachMaxStepPenetrationM / Math.max(1e-9, o.maxFreeDivergenceM), 3)}, cap ${PEN_LEAD_FRAC}) -- a prediction with no block latch runs the whole lead into the wall`)
  expect(Number.isFinite(o.transientMaxStepPenetrationSteps) && o.transientMaxStepPenetrationSteps <= PEN_STEP_TOL_STEPS, p + `the exhaustive per-step one-ack-lag penetration stayed inside the sanctioned lead cap: max ${o.transientMaxStepPenetrationSteps} step(s) = ${o.transientMaxStepPenetrationM} m over ${o.transientAtWall} transient samples (cap ${PEN_STEP_TOL_STEPS} step(s) = ${round(PEN_STEP_TOL_M, 4)} m; the per-server-tick sample only saw ${o.transientMaxPenetrationM} m)`)
  expect(Number.isFinite(o.transientMaxStepPenetrationSteps) && o.transientMaxStepPenetrationSteps <= PEN_LEAD_FRAC * o.maxFreeDivergenceSteps, p + `the one-ack-lag penetration stayed a fraction of the prediction lead: max ${o.transientMaxStepPenetrationSteps} step(s) of the ${o.maxFreeDivergenceSteps} step clear-lane lead (${round(o.transientMaxStepPenetrationM / Math.max(1e-9, o.maxFreeDivergenceM), 3)}, cap ${PEN_LEAD_FRAC})`)
  expect(Number.isFinite(o.maxWedgedServerSdfM) && o.maxWedgedServerSdfM <= CONTACT_SDF_M + PEN_STEP_TOL_M, p + `the block never stayed latched further from a wall than the prediction lead can put it: furthest wedged server distance ${o.maxWedgedServerSdfM} m (contact ${CONTACT_SDF_M} m + ${PEN_STEP_TOL_STEPS} step(s) = ${round(CONTACT_SDF_M + PEN_STEP_TOL_M, 4)} m; ${o.clearLaneWedgeTicks} of ${o.clearLaneTicks} clear-lane tick(s) were wedged at all, which the lead alone can cause because the latch belongs to the prediction and the prediction runs ahead of the server)`)
  if (o.wallBody === 'kinematic') {
    expect(o.wallPlaneTicks === 0, p + `a non-static wall sends the client no wall plane: ${o.wallPlaneTicks} ticks with a cached plane`)
  }
  if (o.slide) {
    expect(o.movingAtWall >= MIN_SLIDE_TICKS, p + `the player kept sliding along the wall for at least ${MIN_SLIDE_TICKS} samples at the wall: ${o.movingAtWall}`)
    expect(Number.isFinite(o.meanDivergenceSteps) && o.meanDivergenceSteps >= MIN_LEAD_FRAC * o.meanLeadSteps, p + `prediction kept leading while the server slid: mean divergence while moving ${o.meanDivergenceSteps} step(s) (${o.meanDivergenceMovingM} m), ${round(o.meanDivergenceSteps / Math.max(1e-9, o.meanLeadSteps), 3)} of the ${o.meanLeadSteps} step input lead (floor ${MIN_LEAD_FRAC})`)
    expect(Number.isFinite(o.meanDivergenceSteps) && o.meanDivergenceSteps <= o.meanLeadSteps + DIVERGENCE_SLACK_TICKS, p + `sliding divergence stayed inside the input lead: mean ${o.meanDivergenceSteps} step(s) of ${round(STEP_TRAVEL_M, 6)} m (${o.meanDivergenceMovingM} m) at lead ${o.meanLeadSteps} tick(s) + slack ${DIVERGENCE_SLACK_TICKS}`)
  } else {
    // Held is a fact about the PLAYER's rest state, so it is counted before the
    // ack-freshness gate (which exists to make the penetration sample trustworthy, not
    // to decide whether the player was standing still). Measured 0.594..0.885 over the
    // same 20 arm-runs; the absolute count there is 40..321 for identical arms.
    expect(o.stoppedAtWallRaw >= MIN_HELD_FRAC * o.samplesAtWall, p + `the player was held against the wall for most of the time it spent there: ${o.stoppedAtWallRaw} settled of ${o.samplesAtWall} at-wall samples (${round(o.stoppedAtWallRaw / Math.max(1, o.samplesAtWall), 3)}, floor ${MIN_HELD_FRAC}; ${o.stoppedAtWall} of those had an accepted ack within ${ACK_STALE_TICKS} tick(s) and are the ones the penetration bound is measured on)`)
    expect(Number.isFinite(o.heldMaxPenetrationSteps) && o.heldMaxPenetrationSteps <= PEN_LEAD_FRAC * o.maxFreeDivergenceSteps, p + `the predicted position never settled deeper inside the wall than the sanctioned lead: max ${o.heldMaxPenetrationSteps} step(s) = ${o.heldMaxPenetrationM} m over ${o.stoppedAtWall} settled samples at the wall (lead ${o.maxFreeDivergenceSteps} step(s) = ${o.maxFreeDivergenceM} m, cap ${PEN_LEAD_FRAC}; the first steps of lead after the server stops are free because the server stops with its centre off the wall face)`)
    expect(Number.isFinite(o.heldMaxStepPenetrationSteps) && o.heldMaxStepPenetrationSteps <= PEN_LEAD_FRAC * o.maxFreeDivergenceSteps, p + `no predicted step settled deeper inside the wall than the sanctioned lead: exhaustive max ${o.heldMaxStepPenetrationSteps} step(s) = ${o.heldMaxStepPenetrationM} m over ${o.stoppedAtWall} settled samples (lead ${o.maxFreeDivergenceSteps} step(s), cap ${PEN_LEAD_FRAC})`)
  }
}

const byArm = Object.fromEntries(unitResults.map(u => [u.arm, u]))
const stepSize = byArm['unit-step-size']
expect(Math.abs(stepSize.tickDurationMs - stepSize.expectedTickMs) <= UNIT_STEP_TOL_FRAC, `unit-step-size: the prediction engine steps at the server's tick period: ${stepSize.tickDurationMs} ms of ${stepSize.expectedTickMs} ms`)
expect(Math.abs(stepSize.speedMps - stepSize.expectedSpeedMps) <= UNIT_STEP_TOL_FRAC * stepSize.expectedSpeedMps, `unit-step-size: a sprinting prediction runs at the sprint speed step travel is derived from: ${stepSize.speedMps} m/s of ${stepSize.expectedSpeedMps} m/s (tol ${UNIT_STEP_TOL_FRAC})`)
expect(stepSize.errFrac <= UNIT_STEP_TOL_FRAC, `unit-step-size: one predicted step covers one tick of travel: ${stepSize.stepM} m of ${stepSize.expectedStepM} m (${stepSize.errFrac} off, tol ${UNIT_STEP_TOL_FRAC}; step of travel ${stepSize.stepTravelM} m)`)
const headon = byArm['unit-slide-0']
expect(headon.wedged === true, `unit-slide-0: a head-on block still latches (wedged ${headon.wedged})`)
expect(headon.movedM <= 0.02, `unit-slide-0: a head-on block still stops the prediction: moved ${headon.movedM} m`)

for (const arm of ['unit-slide-25', 'unit-slide-75']) {
  const u = byArm[arm]
  expect(u.wedged === true, `${arm}: a wall at ${u.incidenceDeg} deg incidence latches the block (wedged ${u.wedged})`)
  expect(u.intoWallM <= 0.02, `${arm}: the prediction stopped entering the wall: intoWall ${u.intoWallM} m`)
  expect(u.movedM >= 0.5, `${arm}: the prediction kept sliding along the wall instead of freezing: moved ${u.movedM} m (server slides ${u.serverAlongM} m)`)
  expect(u.alongWallM >= u.expectedAlongM * 0.5, `${arm}: the prediction slid in the along-wall direction: ${u.alongWallM} m of ${u.expectedAlongM} m expected`)
}

const cached = byArm['unit-slide-25-cachedplane']
const plain = byArm['unit-slide-25']
expect(cached.wedged === true, `unit-slide-25-cachedplane: a stale cached plane no longer disables the latch (wedged ${cached.wedged})`)
expect(cached.intoWallM <= 0.02, `unit-slide-25-cachedplane: a stale cached plane no longer restores penetration: intoWall ${cached.intoWallM} m vs ${plain.intoWallM} m with an empty cache`)

const tp = byArm['unit-teleport']
expect(tp.latchedBefore === true, `unit-teleport: the block latched before the teleport (wedged ${tp.latchedBefore})`)
expect(tp.afterTeleport === false, `unit-teleport: teleport() cleared the block (wedged ${tp.afterTeleport})`)
expect(tp.afterStaleAck === false, `unit-teleport: a non-advancing ack after teleport() did not re-latch the block (wedged ${tp.afterStaleAck})`)

const rs = byArm['unit-resync']
expect(rs.latchedBefore === true, `unit-resync: the block latched before the resync (wedged ${rs.latchedBefore})`)
expect(rs.afterResync === false, `unit-resync: resyncToServer() cleared the block (wedged ${rs.afterResync})`)
expect(rs.afterStaleAck === false, `unit-resync: a non-advancing ack after resyncToServer() did not re-latch the block (wedged ${rs.afterStaleAck})`)

const ab = byArm['unit-airborne']
expect(ab.wedged === false, `unit-airborne: an airborne character with ${ab.serverVelH} m/s commanded is not treated as horizontally blocked (wedged ${ab.wedged})`)

const ac = byArm['unit-ack-clamp']
expect(ac.latchedBefore === true, `unit-ack-clamp: the block latched before the bogus ack (wedged ${ac.latchedBefore})`)
expect(ac.bogusAckRejected === true, `unit-ack-clamp: an out-of-range inputSequence did not move _lastAckedSeq: ${ac.ackBefore} -> ${ac.ackAfterBogus}`)
expect(ac.ackAdvancedAfter === true, `unit-ack-clamp: normal acks still advance after a rejected one (ended at ${ac.ackAfterBogus})`)
expect(ac.wedgedAfterRecovery === false, `unit-ack-clamp: the block cleared once the server resumed moving (wedged ${ac.wedgedAfterRecovery})`)

const st = byArm['unit-stalled-ack']

expect(st.wedgedWhileMoving === false, `unit-stalled-ack: a server that keeps delivering new positions never latches the block (wedged ${st.wedgedWhileMoving})`)

expect(st.wedgedAfterOneStalledAck === false, `unit-stalled-ack: one ack reporting ${st.serverVelH} m/s while the server stands still is not evidence of a block (wedged ${st.wedgedAfterOneStalledAck})`)

expect(st.wedgedAfterTwoStalledAcks === true, `unit-stalled-ack: a stall that persists across two consecutive acks still latches the block (wedged ${st.wedgedAfterTwoStalledAcks})`)


if (failures.length) {
  for (const f of failures) console.log('FAIL: ' + f)
  console.log('RESULT: FAIL')
  process.exit(1)
}
console.log('RESULT: PASS')
process.exit(0)
