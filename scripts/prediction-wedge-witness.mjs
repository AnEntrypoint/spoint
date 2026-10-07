#!/usr/bin/env node
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createNetServer } from 'node:net'

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
const HELD_SPEED_MPS = Number(args.heldSpeed || 0.25)
const FREE_SPEED_MPS = Number(args.freeSpeed || 1)
const DIVERGENCE_CAP_M = Number(args.divergenceCap || 1)
const MIN_HELD_TICKS = Number(args.minHeldTicks || 60)
const MIN_SLIDE_TICKS = Number(args.minSlideTicks || 40)
const WARMUP_TICKS = Number(args.warmupTicks || 10)
const SETTLE_TIMEOUT_MS = Number(args.settleTimeoutMs || 30000)
const ARM_TIMEOUT_MS = Number(args.armTimeoutMs || 120000)
const CONTACT_SDF_M = Number(args.contactSdf || 1)
const CYCLES = Number(args.cycles || 2)
const CYCLE_TICKS = Number(args.cycleTicks || 170)
const SLIDE_YAW_RAD = Number(args.slideYaw || 25) * Math.PI / 180
const SAMPLE_MS = 4
const REST_LOOKAHEAD_MS = Number(args.restLookaheadMs || 30)
const REST_EPS_M = Number(args.restEps || 0.01)
const SETTLE_MS = Number(args.settleMs || 40)

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
    const dt = 1 / worldDef.tickRate

    tickSystem.onTick(() => {
      tickCount++
      const sp = player.state.position
      const serverPos = [sp[0], sp[1], sp[2]]
      const predPos = pred.localState ? [pred.localState.position[0], pred.localState.position[1], pred.localState.position[2]] : null
      const lastServer = pred.lastServerState ? [pred.lastServerState.position[0], pred.lastServerState.position[1], pred.lastServerState.position[2]] : null
      if (prevServer && predPos) serverPathM += Math.hypot(serverPos[0] - prevServer[0], serverPos[2] - prevServer[2])
      if (prevPred && predPos) predPathM += Math.hypot(predPos[0] - prevPred[0], predPos[2] - prevPred[2])
      prevServer = serverPos
      prevPred = predPos ? [...predPos] : prevPred
      const ss = nearestSdf(serverPos)
      samples.push({
        tick: tickCount,
        serverSdf: round(ss, 6),
        predSdf: predPos ? round(nearestSdf(predPos), 6) : null,
        divergence: predPos && lastServer ? Math.hypot(predPos[0] - lastServer[0], predPos[1] - lastServer[1], predPos[2] - lastServer[2]) : null,
        unacked: pred._inputSeq - 1 - (pred._lastAckedSeq ?? pred._inputSeq - 1),
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

    const out = {
      arm: cfg.name,
      wallBody: cfg.wallBody,
      yawDeg: round(cfg.yaw * 180 / Math.PI, 2),
      ticks,
      groundedAtStart: grounded,
      samplesAtWall: atWallIdx.length,
      stoppedAtWall: stopped.length,
      movingAtWall: moving.length,
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
      serverPathM: round(serverPathM, 4),
      predPathM: round(predPathM, 4),
      pathRatio: round(predPathM / Math.max(1e-9, serverPathM), 4),
      maxHeldDivergenceM: round(heldDiv.length ? Math.max(...heldDiv) : NaN, 5),
      maxFreeDivergenceM: round(freeDiv.length ? Math.max(...freeDiv) : NaN, 5),
      correctionsDuringArm: (samples.at(-1)?.corrections ?? 0) - (samples[0]?.corrections ?? 0),
    }
    return out
  } finally {
    try { await server.stop?.() } catch {}
  }
}

const ARMS = [
  { name: 'static-headon', wallBody: 'static', yaw: 0, slide: false },
  { name: 'kinematic-headon', wallBody: 'kinematic', yaw: 0, slide: false },
  { name: 'kinematic-slide', wallBody: 'kinematic', yaw: SLIDE_YAW_RAD, slide: true },
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

for (const o of results) {
  const p = o.arm + ': '
  expect(o.groundedAtStart, p + 'the player was standing on the floor before the arm started')
  expect(Number.isFinite(o.serverPathM) && o.serverPathM > 5, p + `the player walked a real distance: serverPath ${o.serverPathM} m`)
  expect(o.pathRatio >= 0.9 && o.pathRatio <= 1.1, p + `the predicted path length tracked the server path length: ratio ${o.pathRatio} (pred ${o.predPathM} m, server ${o.serverPathM} m)`)
  expect(Number.isFinite(o.maxFreeDivergenceM) && o.maxFreeDivergenceM <= DIVERGENCE_CAP_M, p + `clear-lane divergence stayed bounded: max ${o.maxFreeDivergenceM} m (cap ${DIVERGENCE_CAP_M} m)`)
  if (o.wallBody === 'kinematic') {
    expect(o.wallPlaneTicks === 0, p + `a non-static wall sends the client no wall plane: ${o.wallPlaneTicks} ticks with a cached plane`)
  }
  if (o.arm === 'kinematic-slide') {
    expect(o.movingAtWall >= MIN_SLIDE_TICKS, p + `the player kept sliding along the wall for at least ${MIN_SLIDE_TICKS} samples at the wall: ${o.movingAtWall}`)
    expect(o.pathRatio >= 0.9, p + `the predicted path tracked the server while sliding: ratio ${o.pathRatio}`)
    const restMax = Math.max(Number.isFinite(o.heldMaxPenetrationM) ? o.heldMaxPenetrationM : 0, Number.isFinite(o.transientMaxPenetrationM) ? o.transientMaxPenetrationM : 0)
    expect(restMax <= PEN_TOL_M, p + `the predicted position stopped entering the wall once the server was held: max ${round(restMax, 5)} m over ${o.stoppedAtWall + o.transientAtWall} samples at rest (tol ${PEN_TOL_M} m)`)
  } else {
    expect(o.stoppedAtWall >= MIN_HELD_TICKS, p + `the player was held against the wall for at least ${MIN_HELD_TICKS} samples: ${o.stoppedAtWall}`)
    expect(Number.isFinite(o.heldMaxPenetrationM) && o.heldMaxPenetrationM <= PEN_TOL_M, p + `the predicted position never stayed inside the wall the player is held against: max ${o.heldMaxPenetrationM} m over ${o.stoppedAtWall} settled samples at the wall (tol ${PEN_TOL_M} m)`)
  }
}

if (failures.length) {
  for (const f of failures) console.log('FAIL: ' + f)
  console.log('RESULT: FAIL')
  process.exit(1)
}
console.log('RESULT: PASS')
process.exit(0)
