import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createNetServer } from 'node:net'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

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

const PLAYERS = Number(args.players || 64)
const RADIUS_KM = Number(args.radiusKm || 52)
const DROP_M = Number(args.dropM || 120)
const TICKS = Number(args.ticks || 120)
const REPS = Number(args.reps || 10)
const WORLD = args.world || 'tps-game'
const INJECT = args.inject || 'none'
const OUT = args.out || null
const LANDING_MIN = Number(args.landingMin || 24)
const REUSE_DIVISOR = Number(args.reuseDivisor || 8)
const ARM_TIMEOUT_MS = Number(args.armTimeoutMs || 180000)
const LANDING_TIMEOUT_MS = Number(args.landingTimeoutMs || 180000)
const LANDING_DROP_M = Number(args.landingDropM || 4)
const LANDING_CELL_M = Number(args.landingCellM || 18)
const LANDING_RADIUS_KM = Number(args.landingRadiusKm ?? 0)

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

function quantile(sorted, p) {
  if (sorted.length === 0) return NaN
  const i = (sorted.length - 1) * p
  const lo = Math.floor(i), hi = Math.ceil(i)
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
}
function spread(values) {
  const s = values.slice().sort((a, b) => a - b)
  return { median: quantile(s, 0.5), q1: quantile(s, 0.25), q3: quantile(s, 0.75), iqr: quantile(s, 0.75) - quantile(s, 0.25), min: s[0], max: s[s.length - 1] }
}
const round = (v, n = 6) => Number(v.toFixed(n))

const { resetSurfaceSolveStats, surfaceSolveStats } = await import('../src/terrain/PlanetFrame.js')
const { AIRBORNE_GROUND_RELEASE_MIN_M } = await import('../src/terrain/TerrainPhysics.js')

async function main() {
  const { createServer } = await import('../src/sdk/server.js')
  const { PhysicsNetworkClient } = await import('../src/client/PhysicsNetworkClient.js')
  const { loadWorldModule } = await import('../src/sdk/WorldLocator.js')

  const port = await freePort()
  const worldDef = await loadWorldModule(resolve(SDK_ROOT, 'apps', 'world', WORLD + '.js'))
  worldDef.entities = (worldDef.entities || []).filter(e => e && e.app === 'terrain')
  worldDef.terrain = { ...(worldDef.terrain || {}), vegetation: null }
  worldDef.spawnPoint = [0, 5, 0]

  const server = await createServer({
    port,
    tickRate: worldDef.tickRate || 60,
    appsDirs: [resolve(SDK_ROOT, 'apps'), resolve(SDK_ROOT, 'src', 'stdlib-apps')],
    sdkRoot: SDK_ROOT,
    gravity: worldDef.gravity,
    staticDirs: [],
    storageDir: resolve(SDK_ROOT, 'data', 'airborne-ground-solve-throttle-witness'),
  })
  await server.loadWorld(worldDef)
  await server.start()
  const physics = server.physics
  const pi = server.physicsIntegration
  const url = `ws://127.0.0.1:${port}/ws`

  const clients = []
  for (let i = 0; i < PLAYERS; i++) clients.push(new PhysicsNetworkClient({ url, predictionEnabled: false, smoothInterpolation: false, collisionMirror: false, webTransport: { enabled: false } }))
  const connectFailures = []
  await Promise.all(clients.map(c => c.connect().catch(e => connectFailures.push(e))))
  if (connectFailures.length) { console.error(`[airborne] ${connectFailures.length} of ${clients.length} client(s) failed to connect to ${url}: ${connectFailures[0].name}: ${connectFailures[0].message}`); process.exit(1) }
  const tJoin = Date.now()
  while (server.playerManager.getConnectedPlayers().length < PLAYERS && Date.now() - tJoin < 60000) await sleep(50)
  const players = server.playerManager.getConnectedPlayers()
  let inputStops = null
  function startInputs() {
    if (inputStops) return
    inputStops = clients.map(c => c.startInputLoop(() => ({ forward: true, sprint: true, yaw: 0, pitch: 0 })))
  }
  function stopInputs() {
    if (!inputStops) return
    for (const stop of inputStops) { try { stop() } catch {} }
    inputStops = null
  }
  await sleep(300)

  let tickCount = 0
  let physicsPhaseMs = 0
  let landingPhase = false
  const landingDiffs = []
  const injectedDiffs = []
  let diffTarget = landingDiffs
  const emptyVerify = () => ({ verifySamples: 0, maxServedVsExactM: Infinity, sumServedVsExactM: 0, reused: 0, minAboveM: Infinity, samplesWithinSupportM: 0, maxDeltaWithinSupportM: 0 })
  let landingVerify = emptyVerify()
  let injectedVerify = emptyVerify()
  const prevGrounded = new Map()
  const groundAt = new Map()
  const homeXZ = new Map()

  const tickSystem = server.tickSystem || null
  if (!tickSystem || typeof tickSystem.onTick !== 'function') throw new Error('[witness] server has no tickSystem.onTick -- cannot count ticks')
  process.on('uncaughtException', e => console.error('[witness] uncaught in tick path: ' + (e && e.stack || e)))
  process.on('unhandledRejection', e => console.error('[witness] unhandled rejection: ' + (e && e.stack || e)))
  const hb = setInterval(() => console.error(`[witness] HB y=${round(players[0].state.position[1],3)} vy=${round(players[0].state.velocity[1],3)} og=${players[0].state.onGround} g=${round(physics.terrainHeightAt(players[0].state.position[0],players[0].state.position[2]),3)} cur=${tickSystem.currentTick} cb=${tickCount} state=${tickSystem._state} sched=${tickSystem.schedulerStats ? tickSystem.schedulerStats.ticks : -1} dil=${tickSystem.dilationFactor}`), 500)
  hb.unref?.()

  tickSystem.onTick(() => {
    tickCount++
    if (!landingPhase) return
    for (const p of players) {
      const st = p.state
      const grounded = !!st.onGround
      const was = prevGrounded.get(p) === true
      if (grounded && !was) {
        const x = st.position[0], z = st.position[2]
        const reuse = physics.groundSolveReuse
        const throttled = physics.terrainHeightAt(x, z)
        if (reuse) reuse.setEnabled(false)
        const reference = physics.terrainHeightAt(x, z)
        if (reuse) reuse.setEnabled(true)
        if (Number.isFinite(throttled) && Number.isFinite(reference)) diffTarget.push(Math.abs(throttled - reference))
      }
      prevGrounded.set(p, grounded)
    }
  })

  const origUpdatePlayer = pi.updatePlayerPhysics.bind(pi)
  const origKillPlane = pi._killPlaneY.bind(pi)
  let killPlaneCalls = 0
  let killPlaneSolves = 0
  let killPlaneCallsTotal = 0
  let updateCalls = 0
  let armUpdateCalls = 0
  let crouchCalls = 0
  const origSetCrouch = pi.setCrouch.bind(pi)
  pi.setCrouch = function (...a) { crouchCalls++; return origSetCrouch(...a) }
  pi._killPlaneY = function (x, z) {
    killPlaneCalls++
    killPlaneCallsTotal++
    const before = surfaceSolveStats().solves
    const r = origKillPlane(x, z)
    killPlaneSolves += surfaceSolveStats().solves - before
    return r
  }
  pi.updatePlayerPhysics = function (playerId, state, deltaTime) {
    const t0 = performance.now()
    const r = origUpdatePlayer(playerId, state, deltaTime)
    physicsPhaseMs += performance.now() - t0
    updateCalls++
    armUpdateCalls++
    return r
  }

  function placeAll(cx, cz, cellM, liftM) {
    const side = Math.ceil(Math.sqrt(PLAYERS))
    for (let i = 0; i < players.length; i++) {
      const p = players[i]
      const gx = i % side, gz = (i / side) | 0
      const x = cx + (gx - (side - 1) / 2) * cellM
      const z = cz + (gz - (side - 1) / 2) * cellM
      const g = physics.terrainHeightAt(x, z)
      const ground = Number.isFinite(g) ? g : 0
      groundAt.set(p, ground)
      homeXZ.set(p, [x, z])
      const pos = [x, ground + liftM, z]
      p.state.position[0] = pos[0]; p.state.position[1] = pos[1]; p.state.position[2] = pos[2]
      p.state.velocity[0] = 0; p.state.velocity[1] = 0; p.state.velocity[2] = 0
      p.state.onGround = false
      prevGrounded.set(p, false)
      try { pi.setPlayerPosition(p.id, pos) } catch {}
    }
  }

  const cx = RADIUS_KM * 1000
  const armSite = { x: cx, z: 0, cell: 30, lift: DROP_M }
  const landingSite = { x: LANDING_RADIUS_KM * 1000, z: 0, cell: LANDING_CELL_M, lift: LANDING_DROP_M }

  const streamer = physics._terrainStreamer || null
  const covered = () => !streamer || typeof streamer.coversPosition !== 'function' || players.every(p => streamer.coversPosition(p.state.position[0], p.state.position[2]))

  function reliftAt(liftM) {
    for (const p of players) {
      const ground = groundAt.get(p)
      const home = homeXZ.get(p)
      if (home) { p.state.position[0] = home[0]; p.state.position[2] = home[1] }
      p.state.position[1] = ground + liftM
      p.state.velocity[0] = 0; p.state.velocity[1] = 0; p.state.velocity[2] = 0
      p.state.onGround = false
      prevGrounded.set(p, false)
      try { pi.setPlayerPosition(p.id, [p.state.position[0], p.state.position[1], p.state.position[2]]) } catch {}
    }
  }

  async function waitColliderLive(budgetMs) {
    const w = Date.now()
    while (Date.now() - w < budgetMs) {
      reliftAt(0.05)
      const t = Date.now()
      while (Date.now() - t < 1500) {
        await sleep(50)
        const grounded = players.filter(p => p.state.onGround).length
        if (grounded * 20 >= players.length * 19) return true
      }
    }
    return false
  }

  async function armLandingDrop() {
    reliftAt(landingSite.lift)
    const w = Date.now()
    while (players.some(p => p.state.onGround) && Date.now() - w < 5000) await sleep(20)
    for (const p of players) prevGrounded.set(p, !!p.state.onGround)
  }

  const reuseEarly = physics.groundSolveReuse || null
  placeAll(landingSite.x, landingSite.z, landingSite.cell, landingSite.lift)
  const landingColliderLive = await waitColliderLive(LANDING_TIMEOUT_MS)
  await armLandingDrop()
  if (reuseEarly) reuseEarly.resetStats()
  startInputs()
  landingPhase = true
  if (reuseEarly) reuseEarly.setVerifyReuse(true)
  resetSurfaceSolveStats()
  const landingStart = tickCount
  const landingWait = Date.now()
  while (diffTarget.length < LANDING_MIN && Date.now() - landingWait < LANDING_TIMEOUT_MS && tickCount - landingStart < 6000) await sleep(50)
  landingPhase = false
  if (reuseEarly) { landingVerify = reuseEarly.stats(); reuseEarly.setVerifyReuse(false) }
  stopInputs()
  const landingWaitMs = Date.now() - landingWait

  placeAll(armSite.x, armSite.z, armSite.cell, armSite.lift)
  const armWait = Date.now()
  while (!covered() && Date.now() - armWait < 180000) await sleep(250)
  while (players.some(p => !!p.teleportHold) && Date.now() - armWait < 180000) await sleep(100)
  const armCoverWaitMs = Date.now() - armWait
  const chartLocalRadiusM = Math.hypot(players[0].state.position[0], players[0].state.position[2])

  const before = { solvesPerPlayerTick: [], physicsMsPerTick: [], pathM: [], maxReuseM: [], reuseFrac: [], speedMps: [], physicsMsPerUpdate: [], solvesPerUpdate: [] }
  const after = { solvesPerPlayerTick: [], physicsMsPerTick: [], pathM: [], maxReuseM: [], reuseFrac: [], speedMps: [], physicsMsPerUpdate: [], solvesPerUpdate: [] }
  const reuse = reuseEarly
  if (reuse && INJECT === 'zero') reuse.setDistanceOverrideM(0)
  if (reuse && INJECT === 'infinite') reuse.setDistanceOverrideM(Infinity)

  const sampleState = { last: null }
  function beginSample() {
    sampleState.last = players.map(p => [p.state.position[0], p.state.position[2], p.state.position[1]])
    sampleState.path = 0
    sampleState.pathV = 0
    sampleState.hvSum = 0
    sampleState.fwd = 0
    sampleState.samples = 0
  }
  tickSystem.onTick(() => {
    if (!sampleState.last) return
    for (let i = 0; i < players.length; i++) {
      const p = players[i]
      const l = sampleState.last[i]
      sampleState.path += Math.hypot(p.state.position[0] - l[0], p.state.position[2] - l[1])
      sampleState.pathV = (sampleState.pathV || 0) + Math.abs(p.state.position[1] - l[2])
      sampleState.vySum = (sampleState.vySum || 0) + Math.abs(p.state.velocity[1])
      sampleState.hvSum = (sampleState.hvSum || 0) + Math.hypot(p.state.velocity[0], p.state.velocity[2])
      if (p.lastInput && p.lastInput.forward) sampleState.fwd = (sampleState.fwd || 0) + 1
      l[0] = p.state.position[0]; l[1] = p.state.position[2]; l[2] = p.state.position[1]
    }
    sampleState.samples = (sampleState.samples || 0) + 1
  })

  let groundedSamples = 0
  for (let rep = 0; rep < REPS; rep++) {
    for (const arm of ['before', 'after']) {
      for (const p of players) {
        const ground = groundAt.get(p)
        const home = homeXZ.get(p)
        if (home) { p.state.position[0] = home[0]; p.state.position[2] = home[1] }
        p.state.position[1] = ground + DROP_M
        p.state.velocity[0] = 0; p.state.velocity[1] = 0; p.state.velocity[2] = 0
        p.state.onGround = false
        prevGrounded.set(p, false)
        try { pi.setPlayerPosition(p.id, [p.state.position[0], p.state.position[1], p.state.position[2]]) } catch {}
      }
      if (reuse) reuse.setEnabled(arm === 'after')
      startInputs()
      await sleep(60)
      resetSurfaceSolveStats()
      if (reuse) reuse.resetStats()
      physicsPhaseMs = 0
      killPlaneCalls = 0
      killPlaneSolves = 0
      armUpdateCalls = 0
      beginSample()
      const t0 = performance.now()
      const startTick = tickCount
      while (tickCount - startTick < TICKS && performance.now() - t0 < ARM_TIMEOUT_MS) await sleep(1)
      const ticks = Math.max(1, tickCount - startTick)
      const elapsedMs = Math.max(1, performance.now() - t0)
      console.error(`[witness] arm=${arm} rep=${rep} ticks=${ticks} cbStart=${startTick} cbNow=${tickCount} cur=${tickSystem.currentTick} solves=${surfaceSolveStats().solves} armUpdates=${armUpdateCalls} path=${sampleState.path}`)
      const stats = surfaceSolveStats()
      const rs = reuse ? reuse.stats() : null
      for (const p of players) if (p.state.onGround) groundedSamples++
      const row = arm === 'before' ? before : after
      row.solvesPerPlayerTick.push(stats.solves / (players.length * ticks))
      row.physicsMsPerTick.push(physicsPhaseMs / ticks)
      row.physicsMsPerUpdate.push(physicsPhaseMs / Math.max(1, armUpdateCalls))
      row.solvesPerUpdate.push(stats.solves / Math.max(1, armUpdateCalls))
      row.pathM.push(sampleState.path / players.length)
      row.pathVM = (row.pathVM || 0) + (sampleState.pathV || 0) / players.length
      row.vySum = (row.vySum || 0) + (sampleState.vySum || 0)
      row.speedMps.push((sampleState.path / players.length) / (elapsedMs / 1000))
      row.maxReuseM.push(rs ? rs.maxReuseM : 0)
      row.reuseFrac.push(rs && rs.served ? rs.reused / rs.served : 0)
      row.maxReuseRatio = Math.max(row.maxReuseRatio || 0, rs ? rs.maxReuseRatio : 0)
      row.maxRatioToDerived = Math.max(row.maxRatioToDerived || 0, rs ? rs.maxRatioToDerived : 0)
      row.limitMinM = Math.min(row.limitMinM === undefined ? Infinity : row.limitMinM, rs ? rs.limitMinM : Infinity)
      row.limitMaxM = Math.max(row.limitMaxM || 0, rs ? rs.limitMaxM : 0)
      row.armTicks = (row.armTicks || 0) + ticks
      row.hvSum = (row.hvSum || 0) + (sampleState.hvSum || 0)
      row.fwdTicks = (row.fwdTicks || 0) + (sampleState.fwd || 0)
      row.hvSamples = (row.hvSamples || 0) + (sampleState.samples || 0) * players.length
      row.killPlaneCalls = (row.killPlaneCalls || 0) + killPlaneCalls
      row.killPlaneSolves = (row.killPlaneSolves || 0) + killPlaneSolves
      row.groundedExact = (row.groundedExact || 0) + (rs ? rs.groundedExact : 0)
      row.groundedServed = (row.groundedServed || 0) + (rs ? rs.groundedServed : 0)
      row.served = (row.served || 0) + (rs ? rs.served : 0)
      row.reused = (row.reused || 0) + (rs ? rs.reused : 0)
      row.exact = (row.exact || 0) + (rs ? rs.exact : 0)
      row.ticks = (row.ticks || 0) + ticks
      row.armUpdateCalls = (row.armUpdateCalls || 0) + armUpdateCalls
      row.onGroundSum = (row.onGroundSum || 0) + players.reduce((n, p) => n + (p.state.onGround ? 1 : 0), 0)
      row.heightAboveGroundM = players[0].state.position[1] - (physics.terrainHeightAt(players[0].state.position[0], players[0].state.position[2]) || 0)
      const endAbove = players[0].state.position[1] - (physics.terrainHeightAt(players[0].state.position[0], players[0].state.position[2]) || 0)
      const endHorizontal = Math.hypot(players[0].state.velocity[0], players[0].state.velocity[2])
      const endDescent = Math.max(Math.abs(players[0].state.velocity[1]), 0.5)
      row.derivedLimits = (row.derivedLimits || []).concat([endHorizontal * (endAbove / endDescent) / REUSE_DIVISOR])
      row.endHorizontal = (row.endHorizontal || 0) + endHorizontal
      row.endDescent = (row.endDescent || 0) + endDescent
      row.endAbove = (row.endAbove || 0) + endAbove
    }
  }
  stopInputs()
  diffTarget = injectedDiffs
  placeAll(landingSite.x, landingSite.z, landingSite.cell, landingSite.lift)
  const injectColliderLive = await waitColliderLive(LANDING_TIMEOUT_MS)
  await armLandingDrop()
  if (reuse) reuse.resetStats()
  startInputs()
  landingPhase = true
  if (reuse) reuse.setVerifyReuse(true)
  const injStart = tickCount
  const injWait = Date.now()
  while ((injectedDiffs.length < LANDING_MIN || (reuse && INJECT !== 'zero' && reuse.stats().verifySamples < LANDING_MIN)) && Date.now() - injWait < LANDING_TIMEOUT_MS && tickCount - injStart < 6000) await sleep(50)
  landingPhase = false
  stopInputs()
  if (reuse) { injectedVerify = reuse.stats(); reuse.setVerifyReuse(false) }
  const injectedWaitMs = Date.now() - injWait
  if (reuse) { reuse.setEnabled(true); reuse.setDistanceOverrideM(null) }

  const beforeSolves = spread(before.solvesPerPlayerTick)
  const afterSolves = spread(after.solvesPerPlayerTick)
  const beforeMs = spread(before.physicsMsPerTick)
  const afterMs = spread(after.physicsMsPerTick)
  const beforeMsPerUpdate = spread(before.physicsMsPerUpdate)
  const afterMsPerUpdate = spread(after.physicsMsPerUpdate)
  const beforeSolvesPerUpdate = spread(before.solvesPerUpdate)
  const afterSolvesPerUpdate = spread(after.solvesPerUpdate)
  const afterPath = spread(after.pathM)
  const afterSpeed = spread(after.speedMps)
  const afterReuseM = spread(after.maxReuseM)
  const measuredDescentMps = after.hvSamples ? after.vySum / after.hvSamples : NaN
  const measuredVelocityMps = after.hvSamples ? after.hvSum / after.hvSamples : NaN
  const measuredDisplacementMps = afterPath.median / (TICKS / (worldDef.tickRate || 60))
  const measuredRemainingHeightM = after.heightAboveGroundM
  const fallTimeS = Math.sqrt(2 * DROP_M / Math.abs(Number(worldDef.gravity) || 18))
  const endDerivedLimitM = after.derivedLimits ? spread(after.derivedLimits).median : NaN
  const derivedLimitM = endDerivedLimitM

  const reduction = afterSolves.median > 0 ? beforeSolves.median / afterSolves.median : Infinity
  const landingSpread = landingDiffs.length ? spread(landingDiffs) : { median: NaN, max: NaN }
  const injectedSpread = injectedDiffs.length ? spread(injectedDiffs) : { median: NaN, max: NaN }

  const out = {
    arm: INJECT,
    world: WORLD,
    players: players.length,
    chartLocalRadiusM: round(chartLocalRadiusM, 1),
    dropM: DROP_M,
    ticksPerArm: TICKS,
    reps: REPS,
    throttleInstalled: !!reuse,
    beforeSolvesPerPlayerTick: { median: round(beforeSolves.median), iqr: round(beforeSolves.iqr), q1: round(beforeSolves.q1), q3: round(beforeSolves.q3) },
    afterSolvesPerPlayerTick: { median: round(afterSolves.median), iqr: round(afterSolves.iqr), q1: round(afterSolves.q1), q3: round(afterSolves.q3) },
    solvesReductionX: Number.isFinite(reduction) ? round(reduction, 3) : null,
    solvesEliminatedFraction: round(1 - afterSolves.median / Math.max(1e-12, beforeSolves.median), 6),
    beforePhysicsMsPerTick: { median: round(beforeMs.median, 5), iqr: round(beforeMs.iqr, 5), q1: round(beforeMs.q1, 5), q3: round(beforeMs.q3, 5) },
    afterPhysicsMsPerTick: { median: round(afterMs.median, 5), iqr: round(afterMs.iqr, 5), q1: round(afterMs.q1, 5), q3: round(afterMs.q3, 5) },
    beforePhysicsMsPerUpdate: { median: round(beforeMsPerUpdate.median, 5), iqr: round(beforeMsPerUpdate.iqr, 5) },
    afterPhysicsMsPerUpdate: { median: round(afterMsPerUpdate.median, 5), iqr: round(afterMsPerUpdate.iqr, 5) },
    beforeSolvesPerUpdate: { median: round(beforeSolvesPerUpdate.median, 5), iqr: round(beforeSolvesPerUpdate.iqr, 5) },
    afterSolvesPerUpdate: { median: round(afterSolvesPerUpdate.median, 5), iqr: round(afterSolvesPerUpdate.iqr, 5) },
    displacementSpeedMps: { median: round(afterSpeed.median, 4), iqr: round(afterSpeed.iqr, 4) },
    measuredVelocityMps: round(measuredVelocityMps, 4),
    measuredPathPerPlayerM: { median: round(afterPath.median, 3) },
    reuseDivisor: REUSE_DIVISOR,
    derivedLimitM: round(derivedLimitM, 4),
    derivedLimitInputs: {
      measuredEndVelocityMps: round((after.endHorizontal || 0) / REPS, 4),
      measuredEndDescentMps: round((after.endDescent || 0) / REPS, 4),
      measuredEndAboveM: round((after.endAbove || 0) / REPS, 4),
      formula: 'horizontalSpeedMps * (heightAboveCachedGroundM / max(|descentMps|, 0.5)) / reuseDivisor',
      minDescentFloorMps: 0.5,
    },
    maxAirborneReuseM: { median: round(afterReuseM.median, 4), max: round(afterReuseM.max, 4) },
    observedLimitM: { min: round(after.limitMinM === Infinity ? NaN : after.limitMinM, 6), max: round(after.limitMaxM || 0, 4) },
    worstReuseToLimitRatio: round(after.maxReuseRatio || 0, 6),
    airborneReuseFraction: round((after.reused || 0) / Math.max(1, after.served || 0), 5),
    groundedExactSolves: after.groundedExact || 0,
    groundedServedQueries: after.groundedServed || 0,
    killPlaneCallsBefore: before.killPlaneCalls || 0,
    killPlaneSolvesBefore: before.killPlaneSolves || 0,
    killPlaneCallsAfter: after.killPlaneCalls || 0,
    killPlaneSolvesAfter: after.killPlaneSolves || 0,
    updateCalls: updateCalls,
    killPlaneCallsTotal: killPlaneCallsTotal,
    totalTicks: tickCount,
    playerBodies: pi.playerBodies ? pi.playerBodies.size : -1,
    armCoverWaitMs: armCoverWaitMs,
    diagBefore: { ticks: before.armTicks || 0, armUpdateCalls: before.armUpdateCalls || 0, onGroundSum: before.onGroundSum || 0, heightAboveGroundM: round(before.heightAboveGroundM || 0, 3) },
    diagAfter: { ticks: after.armTicks || 0, armUpdateCalls: after.armUpdateCalls || 0, onGroundSum: after.onGroundSum || 0, heightAboveGroundM: round(after.heightAboveGroundM || 0, 3) },
    diagPlayer: { teleportHold: players.filter(p => !!p.teleportHold).length, lastInputNull: players.filter(p => !p.lastInput).length, yaw: players[0]?.lastInput?.yaw ?? null, forward: players[0]?.lastInput?.forward ?? null, vx: round(players[0].state.velocity[0], 4), vz: round(players[0].state.velocity[2], 4) },
    crouchCalls: crouchCalls,
    meanHorizontalSpeedMps: round((after.hvSum || 0) / Math.max(1, after.hvSamples || 0), 4),
    forwardInputTicks: after.fwdTicks || 0,
    connectedNow: server.playerManager.getConnectedPlayers().length,
    clientsOpen: clients.filter(c => !!c.connected).length,
    landingRadiusKm: LANDING_RADIUS_KM,
    landingDropM: LANDING_DROP_M,
    landingSamples: landingDiffs.length,
    landingDiffM: { median: round(landingSpread.median, 10), max: round(landingSpread.max, 10) },
    releaseBandM: AIRBORNE_GROUND_RELEASE_MIN_M,
    landingVerify: {
      verifySamples: landingVerify.verifySamples || 0,
      maxServedVsExactM: round(landingVerify.maxServedVsExactM === Infinity ? NaN : landingVerify.maxServedVsExactM, 8),
      meanServedVsExactM: round((landingVerify.sumServedVsExactM || 0) / Math.max(1, landingVerify.verifySamples || 0), 8),
      minAboveM: round(landingVerify.minAboveM === Infinity ? NaN : landingVerify.minAboveM, 6),
      maxRatioToDerived: round(landingVerify.maxRatioToDerived || 0, 6),
      groundedServed: landingVerify.groundedServed || 0,
      groundedExact: landingVerify.groundedExact || 0,
    },
    injectedSamples: injectedDiffs.length,
    injectedDiffM: { median: round(injectedSpread.median, 10), max: round(injectedSpread.max, 10) },
    injectedVerify: {
      verifySamples: injectedVerify.verifySamples || 0,
      maxServedVsExactM: round(injectedVerify.maxServedVsExactM === Infinity ? NaN : injectedVerify.maxServedVsExactM, 8),
      minAboveM: round(injectedVerify.minAboveM === Infinity ? NaN : injectedVerify.minAboveM, 6),
      maxRatioToDerived: round(injectedVerify.maxRatioToDerived || 0, 6),
      groundedServed: injectedVerify.groundedServed || 0,
      groundedExact: injectedVerify.groundedExact || 0,
    },
    landingWaitMs: landingWaitMs,
    injectedWaitMs: injectedWaitMs,
    landingColliderLive: landingColliderLive,
    injectColliderLive: injectColliderLive,
    groundedSamplesDuringArms: groundedSamples,
    tickRate: worldDef.tickRate || 60,
    dilationFactor: tickSystem.dilationFactor ?? null,
  }

  expect(out.players === PLAYERS, `all ${PLAYERS} players connected, got ${out.players}`)
  expect(before.armTicks >= TICKS * REPS && after.armTicks >= TICKS * REPS, `every arm ran at least ${TICKS} ticks: before ${before.armTicks} after ${after.armTicks} of ${TICKS * REPS}`)
  expect((before.armUpdateCalls || 0) >= PLAYERS * TICKS * REPS * 0.9, `the unthrottled arm stepped every player every tick: ${before.armUpdateCalls} of ${PLAYERS * TICKS * REPS}`)
  expect((after.armUpdateCalls || 0) >= PLAYERS * TICKS * REPS * 0.9, `the throttled arm stepped every player every tick: ${after.armUpdateCalls} of ${PLAYERS * TICKS * REPS}`)
  expect(reduction >= 5, `solves per player per tick drop at least 5x: before median ${beforeSolves.median} after median ${afterSolves.median} (${reduction}x)`)
  expect(afterMs.median < beforeMs.median, `physics phase ms per tick drops: before median ${beforeMs.median} after median ${afterMs.median}`)
  expect(landingDiffs.length >= LANDING_MIN, `at least ${LANDING_MIN} touchdowns observed, got ${landingDiffs.length}`)
  expect(Number.isFinite(landingSpread.max) && landingSpread.max <= 1e-4, `the ground height served at touchdown is within 1e-4 m of an unthrottled solve at the same position: max ${landingSpread.max}`)
  expect((landingVerify.groundedServed || 0) === (landingVerify.groundedExact || 0), `every ground query for a player in contact with the ground was a cold solve during the landing drop: ${landingVerify.groundedServed} served, ${landingVerify.groundedExact} exact`)
  expect(Number.isFinite(landingVerify.minAboveM) && landingVerify.minAboveM >= AIRBORNE_GROUND_RELEASE_MIN_M, `no cached ground was served inside the ${AIRBORNE_GROUND_RELEASE_MIN_M} m release band during the landing drop: closest ${landingVerify.minAboveM}`)
  expect((landingVerify.maxRatioToDerived || 0) <= 1, `no cached ground was served beyond the speed-derived threshold during the landing drop: worst ratio ${landingVerify.maxRatioToDerived}`)
  expect((landingVerify.verifySamples || 0) >= LANDING_MIN, `cached airborne ground was served and audited against a cold solve at least ${LANDING_MIN} times during the landing drop: ${landingVerify.verifySamples}`)
  expect(injectedDiffs.length >= LANDING_MIN, `at least ${LANDING_MIN} touchdowns observed under ${INJECT}: got ${injectedDiffs.length}`)
  expect(Number.isFinite(injectedSpread.max) && injectedSpread.max <= 1e-4, `the ground height served at touchdown stays within 1e-4 m under ${INJECT}: max ${injectedSpread.max}`)
  expect((injectedVerify.groundedServed || 0) === (injectedVerify.groundedExact || 0), `every ground query for a grounded player stayed a cold solve under ${INJECT}: ${injectedVerify.groundedServed} served, ${injectedVerify.groundedExact} exact`)
  expect((injectedVerify.maxRatioToDerived || 0) <= 1, `no cached ground was served beyond the speed-derived threshold under ${INJECT}: worst ratio ${injectedVerify.maxRatioToDerived}`)
  expect((after.reused || 0) > 0, `the throttle reused cached airborne ground: ${after.reused}`)
  expect((before.reused || 0) === 0, `the unthrottled arm served no reused ground: ${before.reused}`)
  expect(Number.isFinite(derivedLimitM) && derivedLimitM > 0, `the reuse threshold is derived from measured player speed: ${derivedLimitM} m from ${JSON.stringify(out.derivedLimitInputs)}`)
  expect((after.maxReuseRatio || 0) <= 1, `no reuse exceeded the per-query limit in force: worst ratio ${after.maxReuseRatio}`)
  expect((after.maxRatioToDerived || 0) <= 1, `no reuse exceeded the speed-derived threshold: worst ratio ${after.maxRatioToDerived}`)
  expect((after.groundedServed || 0) === (after.groundedExact || 0), `every ground query for an on-ground player was a cold solve: ${after.groundedServed} served, ${after.groundedExact} exact`)
  expect((before.onGroundSum || 0) === 0 && (after.onGroundSum || 0) === 0, `no player was on the ground during any arm: before ${before.onGroundSum} after ${after.onGroundSum}`)
  expect(afterMs.median > 0, `physics phase measured: ${afterMs.median} ms/tick`)

  for (const c of clients) { try { c.close?.() } catch {} }
  try { await server.stop?.() } catch {}
  return out
}

const out = await main()
if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(out, null, 2))
}
console.log(JSON.stringify(out, null, 2))
if (failures.length) {
  for (const f of failures) console.log('FAIL: ' + f)
  console.log('RESULT: FAIL')
  process.exit(1)
}
console.log('RESULT: PASS')
process.exit(0)
