#!/usr/bin/env node
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createNetServer } from 'node:net'
import { PredictionEngine } from '../src/client/PredictionEngine.js'

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

const TICKS = Number(args.ticks || 450)
const PEN_TOL_M = Number(args.penTol || 0.05)
const APPROACH_PEN_TOL_M = Number(args.approachPenTol || 0.2)
const APPROACH_OVER_TOL_MAX = Number(args.approachOverTolMax || 2)
const TRANSIENT_PEN_TOL_M = Number(args.transientPenTol || 0.25)
const DIVERGENCE_CAP_M = Number(args.divergenceCap || 1)
const MIN_LEAD_FRAC = Number(args.minLeadFrac || 0.2)
const MIN_HELD_TICKS = Number(args.minHeldTicks || 60)
const MIN_SLIDE_TICKS = Number(args.minSlideTicks || 40)
const WARMUP_TICKS = Number(args.warmupTicks || 10)
const SETTLE_TIMEOUT_MS = Number(args.settleTimeoutMs || 30000)
const ARM_TIMEOUT_MS = Number(args.armTimeoutMs || 120000)
const CONTACT_SDF_M = Number(args.contactSdf || 1)
const CYCLES = Number(args.cycles || 2)
const CYCLE_TICKS = Number(args.cycleTicks || 170)
const SLIDE_YAWS_DEG = (args.slideYaws || '25,75').split(',').map(Number)
const SAMPLE_MS = 4
const REST_LOOKAHEAD_MS = Number(args.restLookaheadMs || 30)
const REST_EPS_M = Number(args.restEps || 0.01)
const SETTLE_MS = Number(args.settleMs || 40)
const MOVE_EPS_M = Number(args.moveEps || 0.005)
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
const PEN_M = 12
const WALLS = [
  { id: 'wall-n', c: [0, 2, -PEN_M], h: [20, 3, 0.5] },
  { id: 'wall-s', c: [0, 2, PEN_M], h: [20, 3, 0.5] },
  { id: 'wall-e', c: [PEN_M, 2, 0], h: [0.5, 3, 20] },
  { id: 'wall-w', c: [-PEN_M, 2, 0], h: [0.5, 3, 20] },
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
    tickRate: 60,
    gravity: [0, -9.81, 0],
    spawnPoint: [0, 5, 0],
    entities: [
      { id: 'floor', app: 'box-static', position: FLOOR.c, config: { hx: FLOOR.h[0], hy: FLOOR.h[1], hz: FLOOR.h[2] } },
      ...WALLS.map(w => ({ id: w.id, app: 'box-static', position: w.c, config: { hx: w.h[0], hy: w.h[1], hz: w.h[2] }, bodyType: cfg.wallBody })),
    ],
  }

  const server = await createServer({
    port,
    tickRate: worldDef.tickRate,
    appsDirs: [resolve(SDK_ROOT, 'apps'), resolve(SDK_ROOT, 'src', 'stdlib-apps')],
    sdkRoot: SDK_ROOT,
    gravity: worldDef.gravity,
    staticDirs: [],
    storageDir: resolve(SDK_ROOT, 'data', 'prediction-wedge-witness'),
  })
  await server.loadWorld(worldDef)
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
    const acksAtStart = pred.stats.acks
    const correctionsAtStart = pred.stats.corrections

    tickSystem.onTick(() => {
      tickCount++
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
      samples.push({
        tick: tickCount,
        serverSdf: round(ss, 6),
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
      if (samples.length > TICKS) samples.shift()
    })

    let armLive = false
    const srvHist = []
    const sampler = setInterval(() => {
      if (!armLive || !pred.localState) return
      const p = pred.localState.position
      const sp = player.state.position
      const serverSdf = nearestSdf([sp[0], sp[1], sp[2]])
      const pen = Math.max(0, -nearestSdf([p[0], p[1], p[2]]))
      stepPens.push({ t: Date.now(), pen, serverSdf, sp: [sp[0], sp[1], sp[2]], walls: pred.walls ? pred.walls.length : 0, wedged: pred.horizontallyWedged ? 1 : 0 })
    }, SAMPLE_MS)
    sampler.unref?.()

    let phaseTick = 0
    const stopInput = client.startInputLoop(() => {
      if (CYCLES > 1 && cfg.slide !== true) {
        const phase = Math.floor(phaseTick++ / CYCLE_TICKS) % 2
        return { forward: phase === 0, backward: phase === 1, sprint: true, yaw: 0, pitch: 0 }
      }
      return { forward: true, sprint: true, yaw: cfg.yaw, pitch: 0 }
    })
    const startTick = tickCount
    armLive = true
    const t0 = Date.now()
    while (tickCount - startTick < TICKS && Date.now() - t0 < ARM_TIMEOUT_MS) await sleep(2)
    armLive = false
    clearInterval(sampler)
    stopInput()
    const ticks = tickCount - startTick

    const post = samples.slice(WARMUP_TICKS)
    const restAt = stepPens.map((s, i) => {
      let moved = 0
      for (let j = i + 1; j < stepPens.length && stepPens[j].t - s.t <= REST_LOOKAHEAD_MS; j++) {
        moved = Math.max(moved, Math.hypot(stepPens[j].sp[0] - s.sp[0], stepPens[j].sp[2] - s.sp[2]))
      }
      return moved < REST_EPS_M
    })
    const atWallIdx = stepPens.map((s, i) => i).filter(i => stepPens[i].serverSdf <= CONTACT_SDF_M)
    const settledAt = stepPens.map((s, i) => {
      if (!restAt[i]) return false
      let j = i
      while (j > 0 && s.t - stepPens[j - 1].t <= SETTLE_MS) j--
      if (j === 0) return false
      for (let k = j - 1; k <= i; k++) if (!restAt[k]) return false
      return true
    })
    const stopped = atWallIdx.filter(i => settledAt[i]).map(i => stepPens[i])
    const transient = atWallIdx.filter(i => restAt[i] && !settledAt[i]).map(i => stepPens[i])
    const moving = atWallIdx.filter(i => !restAt[i]).map(i => stepPens[i])
    const maxPen = arr => (arr.length ? Math.max(...arr.map(s => s.pen)) : NaN)
    const overTol = arr => arr.filter(s => s.pen > PEN_TOL_M).length
    const heldDiv = post.filter(s => s.serverSdf <= CONTACT_SDF_M).map(s => s.divergence ?? 0)
    const freeDiv = post.filter(s => s.serverSdf > CONTACT_SDF_M).map(s => s.divergence ?? 0)

    const clearLane = post.filter(s => s.serverSdf > CONTACT_SDF_M)
    const movingAtWall = post.filter(s => s.serverSdf <= CONTACT_SDF_M && s.serverStepM > MOVE_EPS_M)
    const predStepSum = movingAtWall.reduce((a, s) => a + (s.predStepM ?? 0), 0)
    const serverStepSum = movingAtWall.reduce((a, s) => a + (s.serverStepM ?? 0), 0)

    const out = {
      arm: cfg.name,
      wallBody: cfg.wallBody,
      slide: cfg.slide === true,
      yawDeg: round(cfg.yaw * 180 / Math.PI, 2),
      ticks,
      groundedAtStart: grounded,
      samplesAtWall: atWallIdx.length,
      stoppedAtWall: stopped.length,
      movingAtWall: movingAtWall.length,
      transientAtWall: transient.length,
      heldMaxPenetrationM: round(maxPen(stopped), 5),
      heldMeanPenetrationM: round(mean(stopped.map(s => s.pen)), 5),
      heldSamplesOverTol: overTol(stopped),
      transientMaxPenetrationM: round(maxPen(transient), 5),
      transientSamplesOverTol: overTol(transient),
      approachMaxPenetrationM: round(maxPen(moving), 5),
      approachSamplesOverTol: overTol(moving),
      stoppedSamplesWithNoWallPlane: stopped.filter(s => s.walls === 0).length,
      stoppedSamplesWedged: stopped.filter(s => s.wedged === 1).length,
      wallPlaneTicks: post.filter(s => (s.walls ?? 0) > 0).length,
      wedgeFlagTicks: post.filter(s => s.wedged).length,
      clearLaneTicks: clearLane.length,
      clearLaneWedgeTicks: clearLane.filter(s => s.wedged).length,
      movingWedgedFrac: round(movingAtWall.length ? movingAtWall.filter(s => s.wedged).length / movingAtWall.length : NaN, 4),
      predStepSumM: round(predStepSum, 4),
      serverStepSumM: round(serverStepSum, 4),
      predStepRatio: round(predStepSum / Math.max(1e-9, serverStepSum), 4),
      meanDivergenceMovingM: round(mean(movingAtWall.map(s => s.divergence ?? 0)), 5),
      meanLeadTicks: round(mean(movingAtWall.map(s => s.lead ?? 0)), 2),
      serverPathM: round(serverPathM, 4),
      predPathM: round(predPathM, 4),
      pathRatio: round(predPathM / Math.max(1e-9, serverPathM), 4),
      maxHeldDivergenceM: round(heldDiv.length ? Math.max(...heldDiv) : NaN, 5),
      maxFreeDivergenceM: round(freeDiv.length ? Math.max(...freeDiv) : NaN, 5),
      acksDuringArm: (pred.stats.acks ?? 0) - acksAtStart,
      correctionsDuringArm: (pred.stats.corrections ?? 0) - correctionsAtStart,
    }
    return out
  } finally {
    try { await server.stop?.() } catch {}
  }
}

function unitEngine() {
  const pe = new PredictionEngine(60)
  pe.init('u1', { position: [0, 0, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0] })
  return pe
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

const ARMS = [
  { name: 'static-headon', wallBody: 'static', yaw: 0, slide: false },
  { name: 'kinematic-headon', wallBody: 'kinematic', yaw: 0, slide: false },
  ...SLIDE_YAWS_DEG.map(d => ({ name: `kinematic-slide-${d}`, wallBody: 'kinematic', yaw: d * Math.PI / 180, slide: true })),
]

const results = []
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
  unitAirborneArm(),
  unitAckClampArm(),
]
for (const u of unitResults) console.log('[wedge-unit] ' + JSON.stringify(u))

for (const o of results) {
  const p = o.arm + ': '
  expect(o.groundedAtStart, p + 'the player was standing on the floor before the arm started')
  expect(Number.isFinite(o.serverPathM) && o.serverPathM > 5, p + `the player walked a real distance: serverPath ${o.serverPathM} m`)
  expect(o.pathRatio >= 0.9 && o.pathRatio <= 1.1, p + `the predicted path length tracked the server path length: ratio ${o.pathRatio} (pred ${o.predPathM} m, server ${o.serverPathM} m)`)
  expect(Number.isFinite(o.maxFreeDivergenceM) && o.maxFreeDivergenceM <= DIVERGENCE_CAP_M, p + `clear-lane divergence stayed bounded: max ${o.maxFreeDivergenceM} m (cap ${DIVERGENCE_CAP_M} m)`)
  expect(o.acksDuringArm > 0, p + `the arm really reconciled against server snapshots: ${o.acksDuringArm} acks`)
  expect(o.heldSamplesOverTol === 0, p + `the predicted position never settled inside the wall: ${o.heldSamplesOverTol} of ${o.stoppedAtWall} settled samples over ${PEN_TOL_M} m (max ${o.heldMaxPenetrationM} m)`)
  expect(o.approachSamplesOverTol <= APPROACH_OVER_TOL_MAX, p + `the predicted position did not keep entering the wall while the server was still approaching it: ${o.approachSamplesOverTol} of ${o.movingAtWall} moving samples over ${PEN_TOL_M} m (max ${o.approachMaxPenetrationM} m)`)
  expect(Number.isFinite(o.approachMaxPenetrationM) && o.approachMaxPenetrationM <= APPROACH_PEN_TOL_M, p + `the impact spike stayed inside its documented bound: max ${o.approachMaxPenetrationM} m (tol ${APPROACH_PEN_TOL_M} m)`)
  expect(Number.isFinite(o.transientMaxPenetrationM) && o.transientMaxPenetrationM <= TRANSIENT_PEN_TOL_M, p + `the one-ack-lag penetration stayed inside its documented bound: max ${o.transientMaxPenetrationM} m over ${o.transientAtWall} transient samples (tol ${TRANSIENT_PEN_TOL_M} m)`)
  expect(o.clearLaneWedgeTicks === 0, p + `the block never latched away from the walls: ${o.clearLaneWedgeTicks} of ${o.clearLaneTicks} clear-lane samples wedged`)
  if (o.wallBody === 'kinematic') {
    expect(o.wallPlaneTicks === 0, p + `a non-static wall sends the client no wall plane: ${o.wallPlaneTicks} ticks with a cached plane`)
  }
  if (o.slide) {
    expect(o.movingAtWall >= MIN_SLIDE_TICKS, p + `the player kept sliding along the wall for at least ${MIN_SLIDE_TICKS} samples at the wall: ${o.movingAtWall}`)
    expect(o.pathRatio >= 0.9, p + `the predicted path tracked the server while sliding: ratio ${o.pathRatio}`)
    expect(Number.isFinite(o.meanDivergenceMovingM) && o.meanDivergenceMovingM >= MIN_LEAD_FRAC * o.maxFreeDivergenceM, p + `prediction kept leading while the server slid: mean divergence while moving ${o.meanDivergenceMovingM} m, ${round(o.meanDivergenceMovingM / Math.max(1e-9, o.maxFreeDivergenceM), 3)} of the ${o.maxFreeDivergenceM} m clear-lane lead (floor ${MIN_LEAD_FRAC})`)
    expect(Number.isFinite(o.meanDivergenceMovingM) && o.meanDivergenceMovingM <= DIVERGENCE_CAP_M, p + `sliding divergence stayed bounded: mean ${o.meanDivergenceMovingM} m (cap ${DIVERGENCE_CAP_M} m)`)
  } else {
    expect(o.stoppedAtWall >= MIN_HELD_TICKS, p + `the player was held against the wall for at least ${MIN_HELD_TICKS} samples: ${o.stoppedAtWall}`)
    expect(Number.isFinite(o.heldMaxPenetrationM) && o.heldMaxPenetrationM <= PEN_TOL_M, p + `the predicted position never stayed inside the wall the player is held against: max ${o.heldMaxPenetrationM} m over ${o.stoppedAtWall} settled samples at the wall (tol ${PEN_TOL_M} m)`)
  }
}

const byArm = Object.fromEntries(unitResults.map(u => [u.arm, u]))
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

if (failures.length) {
  for (const f of failures) console.log('FAIL: ' + f)
  console.log('RESULT: FAIL')
  process.exit(1)
}
console.log('RESULT: PASS')
process.exit(0)
