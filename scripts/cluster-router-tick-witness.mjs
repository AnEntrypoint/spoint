#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { RegionRouter } from '../src/sharding/RegionRouter.js'
import { createClusterManager } from '../src/sharding/ClusterManager.js'
import { ClusterConfigError } from '../src/shared/clusterConfig.js'
import { locateWorld, loadWorldModule } from '../src/sdk/WorldLocator.js'

const TAG = '[cluster-router-tick]'
const SDK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v = 'true'] = a.replace(/^--/, '').split('=')
  return [k, v]
}))
function numberFlag(name, fallback) {
  const raw = args[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`${TAG} --${name} needs a finite number, got "${raw}"`)
  return value
}
const MODE = ['realtime', 'live'].includes(args.mode) ? args.mode : 'sim'
const SECONDS = numberFlag('seconds', 600)
const PLAYERS = 64
const RADIUS_M = 63600
const ANCHOR = [0.9, 0.1, 0.4]
const REGION = '0,0'
const CELL_SIZE = 1e6
const BOX = [500, 7500]
const WALK_STEP_MS = 50

const failures = []
let measurements = 0
function expect(label, ok, detail) {
  measurements++
  if (ok) return
  failures.push(label)
  process.stderr.write(`${TAG} FAIL ${label}${detail === undefined ? '' : ` (${detail})`}\n`)
}

const degOf = r => r * 180 / Math.PI
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const clamp1 = x => Math.max(-1, Math.min(1, x))
function centroidOf(dirs) {
  let x = 0, y = 0, z = 0
  for (const d of dirs) { x += d[0]; y += d[1]; z += d[2] }
  const l = Math.hypot(x, y, z)
  return l > 0 ? [x / l, y / l, z / l] : dirs[0]
}

let seed = 20261009
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }

function worldDefWith(clusters, extra = {}) {
  return {
    name: 'cluster-router-witness',
    terrain: { seed: 11, radius: RADIUS_M, anchorDir: ANCHOR, clusters },
    relevanceRadius: 200,
    maxWeaponRangeM: 0,
    ...extra,
  }
}

function stubWorldFactory(ledger) {
  return {
    async createWorld(clusterId, descriptor) {
      ledger.created.push(clusterId)
      return { clusterId, anchorDir: descriptor.anchorDir }
    },
    async destroyWorld(clusterId) { ledger.destroyed.push(clusterId) },
  }
}

function stubRegionWorker(router, regionId) {
  return {
    pid: process.pid,
    send(msg) {
      if (msg.type !== 'CLIENT_CONNECT') return
      setImmediate(() => router._handleWorkerMessage(regionId, {
        type: 'CLIENT_CONNECTED', region: regionId, requestId: msg.requestId, localPlayerId: msg.routerPlayerId,
      }))
    },
    kill() {},
  }
}

function fakeSocket() {
  return { readyState: 1, on() {}, send() {}, close() { this.readyState = 3 } }
}

function pickWaypoint(p) {
  p.tx = BOX[0] + rnd() * (BOX[1] - BOX[0])
  p.tz = BOX[0] + rnd() * (BOX[1] - BOX[0])
  p.speed = 1 + rnd() * 7
}

function makeWalkers() {
  const walkers = []
  for (let i = 0; i < PLAYERS; i++) {
    const p = { x: BOX[0] + rnd() * (BOX[1] - BOX[0]), z: BOX[0] + rnd() * (BOX[1] - BOX[0]), tx: 0, tz: 0, speed: 0 }
    pickWaypoint(p)
    walkers.push(p)
  }
  return walkers
}

function advance(walkers, dtS) {
  for (const p of walkers) {
    const dx = p.tx - p.x
    const dz = p.tz - p.z
    const dist = Math.hypot(dx, dz)
    const step = p.speed * dtS
    if (dist <= step) {
      p.x = p.tx
      p.z = p.tz
      pickWaypoint(p)
    } else {
      p.x += dx / dist * step
      p.z += dz / dist * step
    }
  }
}

function observe(manager, config) {
  const cosStay = Math.cos(Math.min(Math.PI, config.memberRadiusM * config.stayFactor / config.radius))
  const o = {
    assignments: 0, reportedHandoffs: 0, observedChanges: 0, mergeInduced: 0, hysteretic: 0,
    stayViolations: [], flaps: 0, merges: 0, worstDeg: 0, unanchored: 0, rejected: 0,
    prevOf: new Map(), prevMembers: new Map(), lastChange: new Map(),
  }
  manager.onAssignment(result => {
    const dirOf = id => manager.dirOf(id)
    const merged = new Set()
    for (const e of result.events) {
      if (e.type === 'merge') { merged.add(e.from); o.merges++ }
      else if (e.type === 'handoff') o.reportedHandoffs++
    }
    o.rejected += result.rejected.length
    for (const [p, to] of result.clusterOf) {
      if (!o.prevOf.has(p)) continue
      const from = o.prevOf.get(p)
      if (from === to) continue
      const viaMerge = merged.has(from)
      o.observedChanges++
      if (viaMerge) o.mergeInduced++
      else {
        o.hysteretic++
        const oldDirs = (o.prevMembers.get(from) || []).map(dirOf).filter(Boolean)
        const dp = dirOf(p)
        const centre = oldDirs.length ? centroidOf(oldDirs) : null
        if (!centre || !(dot(dp, centre) < cosStay)) {
          o.stayViolations.push({ assignment: o.assignments, p, from, to, cosToOldCentre: centre ? dot(dp, centre) : null })
        }
      }
      const last = o.lastChange.get(p)
      if (!viaMerge && last && !last.viaMerge && last.assignment === o.assignments - 1 && last.from === to && last.to === from) o.flaps++
      o.lastChange.set(p, { assignment: o.assignments, from, to, viaMerge })
    }
    for (const c of result.clusters) {
      if (!c.anchorDir) { o.unanchored++; continue }
      for (const m of c.memberIds) {
        const d = dirOf(m)
        if (!d) continue
        const deg = degOf(Math.acos(clamp1(dot(d, c.anchorDir))))
        if (deg > o.worstDeg) o.worstDeg = deg
      }
    }
    o.prevOf = new Map(result.clusterOf)
    o.prevMembers = new Map(result.clusters.map(c => [c.id, c.memberIds.slice()]))
    o.assignments++
  })
  return o
}

function withClusterSpec(worldDef, spec) {
  const entities = Array.isArray(worldDef.entities) ? worldDef.entities : []
  const idx = entities.findIndex(e => e && e.app === 'terrain' && e.config)
  if (idx >= 0) {
    const next = entities.slice()
    next[idx] = { ...entities[idx], config: { ...entities[idx].config, clusters: spec } }
    return { ...worldDef, entities: next }
  }
  return { ...worldDef, terrain: { ...(worldDef.terrain || {}), clusters: spec } }
}

async function liveMain(shipped) {
  const { WebSocket } = await import('ws')
  const PORT = numberFlag('port', 38765)
  const ledger = { created: [], destroyed: [] }
  const router = new RegionRouter({
    worldDef: withClusterSpec(shipped, { enabled: true }), port: PORT, cellSize: 512,
    clusterWorldFactory: stubWorldFactory(ledger),
  })
  expect('live router takes its tick period from the resolved cluster cadence', router.clusters !== null && router.clusters.periodMs === 1000 / router.clusters.config.hz, `periodMs=${router.clusters?.periodMs}`)
  let reports = 0
  let lastEntries = []
  const recordPositions = router._recordPlayerPositions.bind(router)
  router._recordPlayerPositions = (regionId, entries) => {
    reports++
    if (entries?.length) lastEntries = entries
    recordPositions(regionId, entries)
  }
  let ws = null
  try {
    await router.spawnRegions(['0,0'])
    await router.start()
    ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?spawnX=100&spawnZ=100`)
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const registerDeadline = performance.now() + 10000
    while (router.players.size === 0 && performance.now() < registerDeadline) await sleep(100)
    expect('the router registers the real client socket', router.players.size === 1, `players=${router.players.size}`)
    // The worker joins a silent socket after its peek grace (1.5 s); the reports then carry its player.
    const reportsAtStart = reports
    const windowStart = performance.now()
    await sleep(3000)
    const rate = (reports - reportsAtStart) / ((performance.now() - windowStart) / 1000)
    expect('the real worker reports at the router-chosen cadence (2-4 Hz)', rate >= 1.9 && rate <= 4.2, `rate=${rate.toFixed(2)}`)
    const joined = lastEntries[0] ?? null
    expect('the real worker reports the joined player at finite chart-local coordinates', joined !== null && Number.isFinite(joined.x) && Number.isFinite(joined.z), `entries=${JSON.stringify(lastEntries.slice(0, 2))}`)
    const [routerId, routerPlayer] = [...router.players][0] ?? [null, null]
    if (routerPlayer) {
      // Known pre-existing defect (RegionWorkerEntry CLIENT_CONNECT answers with the last existing worker-local id,
      // before the peek grace joins the player): this check fails until the connect path reports the joined id.
      expect('CLIENT_CONNECTED names the joined player worker-local id (pre-existing connect defect)', joined !== null && routerPlayer.localPlayerId === joined.playerId, `localPlayerId=${routerPlayer.localPlayerId} joined=${joined?.playerId}`)
      // Witness-supplied mapping from the worker's own report, so the tick and hosting checks still run.
      if (joined !== null) routerPlayer.localPlayerId = joined.playerId
      router._clusterTick()
      expect('the router tick assigns the real-worker player to a cluster (id from the worker report)', router.clusters.manager.clusterOf(routerId) !== null)
      await router.clusters.coordinator.settle()
      expect('the hosting layer created a world for that cluster', ledger.created.length > 0, `created=${ledger.created.length}`)
    }
  } catch (e) {
    expect('the live run completes without error', false, e?.message || String(e))
  } finally {
    if (ws) ws.close()
    await router.stop()
  }
  console.log(`${TAG} ${JSON.stringify({ mode: 'live', port: PORT, positionReports: reports, created: ledger.created.length })}`)
  console.log(`${TAG} RESULT: ${failures.length === 0 ? 'PASS' : 'FAIL'} ${measurements - failures.length} of ${measurements} measurements`)
  process.exitCode = failures.length === 0 ? 0 : 1
}

async function main() {
  if (MODE === 'live') {
    const location = await locateWorld({ project: SDK_ROOT, sdkRoot: SDK_ROOT, name: process.env.WORLD || null })
    if (!location.path) { expect('a shipped world is present for the live run', false); return }
    return liveMain(await loadWorldModule(location.path))
  }
  let simNow = 0
  const clock = MODE === 'sim' ? () => simNow : () => performance.now()
  const ledger = { created: [], destroyed: [] }
  const shared = { now: clock, clusterWorldFactory: stubWorldFactory(ledger), cellSize: CELL_SIZE }

  const router = new RegionRouter({ worldDef: worldDefWith({ enabled: true }), ...shared })
  const { config, manager, coordinator, host } = router.clusters

  expect('cadence is inside 2-4 Hz by default', config.hz >= 2 && config.hz <= 4, `hz=${config.hz}`)
  expect('linkM defaults to 1000 m', config.linkM === 1000, `linkM=${config.linkM}`)
  expect('memberRadiusM derives from the 2.26 deg cell (about 2508 m)', Math.abs(config.memberRadiusM - 2508) < 5, `memberRadiusM=${config.memberRadiusM}`)
  expect('stay and join factors are exposed on the config', config.stayFactor === 1.25 && config.joinFactor === 0.8, `stay=${config.stayFactor} join=${config.joinFactor}`)
  expect('the router exposes its cluster stats for /debug/router', router._clusterStats().hz === config.hz)

  const refusals = [
    ['cluster-link-below-relevance-ring', worldDefWith({ enabled: true, linkM: 500 })],
    ['cluster-link-below-weapon-range', worldDefWith({ enabled: true }, { maxWeaponRangeM: 5000 })],
    ['cluster-radius-exceeds-walkable-chart', worldDefWith({ enabled: true, memberRadiusM: 40000 })],
  ]
  for (const [code, worldDef] of refusals) {
    let got = 'no error'
    try { new RegionRouter({ worldDef, ...shared }) } catch (e) { got = e instanceof ClusterConfigError ? e.code : `unnamed: ${e?.message}` }
    expect(`router refuses ${code} at load`, got === code, got)
  }
  {
    let got = 'no error'
    try { new RegionRouter({ worldDef: worldDefWith({ enabled: true }), cellSize: CELL_SIZE, now: clock }) } catch (e) { got = e?.code ?? `unnamed: ${e?.message}` }
    expect('router refuses clusters without a server config or world factory', got === 'cluster-server-config-missing', got)
  }

  const shippedLocation = await locateWorld({ project: SDK_ROOT, sdkRoot: SDK_ROOT, name: process.env.WORLD || null })
  if (!shippedLocation.path) expect('a shipped world is present to check against', false)
  else {
    const shipped = await loadWorldModule(shippedLocation.path)
    const shippedRouter = new RegionRouter({ worldDef: shipped, cellSize: CELL_SIZE })
    expect(`shipped world ${shippedLocation.name} leaves clusters off`, shippedRouter.clusters === null)
    shippedRouter.startClusterTicks()
    expect(`shipped world ${shippedLocation.name} starts no cluster tick`, shippedRouter._clusterTimer === null)
  }

  {
    const warnings = []
    const realWarn = console.warn
    console.warn = (...parts) => warnings.push(parts.join(' '))
    let threw = null
    let probeResult = null
    try {
      const probe = createClusterManager({ config, now: () => 0 })
      probe.setPlayerDir('north', [0, 1, 0])
      probe.setPlayerDir('south', [0, -1, 0])
      probe.setPlayerDir('zero', [0, 0, 0])
      probe.setPlayerDir('nan', [Number.NaN, 0, 0])
      for (let i = 0; i < 3; i++) probeResult = probe.step({ force: true })
    } catch (e) {
      threw = e
    } finally {
      console.warn = realWarn
    }
    expect('antipodal and rejected inputs never throw', threw === null, threw?.message)
    expect('the antipodal pair forms two clusters', probeResult?.clusters.length === 2, `clusters=${probeResult?.clusters.length}`)
    expect('each rejected input is logged once across repeated steps', warnings.length === 2, `warnings=${warnings.length}`)
  }

  router.workers.set(REGION, { proc: stubRegionWorker(router, REGION), ready: true, region: REGION })
  const walkers = makeWalkers()
  const routerIds = []
  for (const p of walkers) routerIds.push(await router._onSocketConnect(fakeSocket(), [p.x, 5, p.z]))
  expect(`all ${PLAYERS} players connect through the real connect path`, router.players.size === PLAYERS && routerIds.every(id => id != null), `players=${router.players.size}`)

  const reportPositions = () => router._handleWorkerMessage(REGION, {
    type: 'PLAYER_POSITIONS', region: REGION,
    entries: routerIds.map((id, i) => ({ playerId: id, x: walkers[i].x, z: walkers[i].z })),
  })
  const o = observe(manager, config)
  const bound = degOf(Math.asin(Math.min(1, config.memberRadiusM * config.stayFactor / config.radius))) + config.cellWorstDeg

  let measuredHz = null
  if (MODE === 'sim') {
    const periodMs = router.clusters.periodMs
    const stepsPerTick = Math.round(periodMs / WALK_STEP_MS)
    const ticks = Math.round(SECONDS * 1000 / periodMs)
    for (let k = 0; k < ticks; k++) {
      for (let s = 0; s < stepsPerTick; s++) { simNow += WALK_STEP_MS; advance(walkers, WALK_STEP_MS / 1000) }
      reportPositions()
      router._clusterTick()
      await new Promise(resolve => setImmediate(resolve))
    }
    measuredHz = manager.stats.steps / SECONDS
  } else {
    let last = performance.now()
    const walkTimer = setInterval(() => { const t = performance.now(); advance(walkers, (t - last) / 1000); last = t }, WALK_STEP_MS)
    const reportTimer = setInterval(reportPositions, router.clusters.periodMs)
    const stepsBefore = manager.stats.steps
    const started = performance.now()
    router.startClusterTicks()
    await new Promise(resolve => setTimeout(resolve, SECONDS * 1000))
    router.stopClusterTicks()
    clearInterval(walkTimer)
    clearInterval(reportTimer)
    measuredHz = (manager.stats.steps - stepsBefore) / ((performance.now() - started) / 1000)
  }

  let settleError = null
  try { await coordinator.settle() } catch (e) { settleError = e }
  expect('the coordinator applied every assignment without a failure', settleError === null, settleError?.message)

  const stats = manager.stats
  const expectedSteps = Math.round(SECONDS * 1000 / router.clusters.periodMs)
  expect('members stay within the stated bound of their cluster anchor', o.worstDeg <= bound, `worst=${o.worstDeg.toFixed(3)} bound=${bound.toFixed(3)}`)
  expect('handoffs equal the observed membership changes exactly', stats.handoffs === o.observedChanges && o.reportedHandoffs === o.observedChanges, `manager=${stats.handoffs} reported=${o.reportedHandoffs} observed=${o.observedChanges}`)
  expect('every hysteretic handoff left the old stay band', o.stayViolations.length === 0, `violations=${o.stayViolations.length} first=${JSON.stringify(o.stayViolations[0] ?? null)}`)
  expect('no player flapped A to B to A on consecutive assignments without a merge', o.flaps === 0, `flaps=${o.flaps}`)
  expect('the run exercised handoffs and merges', o.observedChanges > 0 && o.merges > 0, `handoffs=${o.observedChanges} merges=${o.merges}`)
  expect('the run exercised hysteretic (non-merge) handoffs, so the stay-band check is not vacuous', o.hysteretic > 0, `hysteretic=${o.hysteretic}`)
  expect('no simulated player was rejected from the assignment', o.rejected === 0, `rejected=${o.rejected}`)
  expect('every cluster carries a lattice anchor', o.unanchored === 0, `unanchored=${o.unanchored}`)
  expect('assignments ran at the configured cadence', MODE !== 'sim' || stats.steps === expectedSteps, `steps=${stats.steps} expected=${expectedSteps}`)
  expect('measured cadence is inside 2-4 Hz', MODE !== 'realtime' || (measuredHz >= 2 && measuredHz <= 4), `measured=${measuredHz?.toFixed(3)}`)
  expect('cluster worlds were created through the hosting layer', ledger.created.length > 0, `created=${ledger.created.length}`)

  const summary = {
    mode: MODE, seconds: SECONDS, players: router.players.size, hz: config.hz,
    measuredHz: measuredHz === null ? null : Number(measuredHz.toFixed(3)),
    assignments: stats.steps, merges: o.merges,
    handoffs: { manager: stats.handoffs, observed: o.observedChanges, mergeInduced: o.mergeInduced, hysteretic: o.hysteretic, flaps: o.flaps, stayViolations: o.stayViolations.length },
    worstMemberDeg: Number(o.worstDeg.toFixed(3)), boundDeg: Number(bound.toFixed(3)),
    clustersNow: manager.last?.clusters.length ?? 0, host: host.stats, refusals: coordinator.refusals.length,
    worldsCreated: ledger.created.length, worldsDestroyed: ledger.destroyed.length,
  }
  console.log(`${TAG} ${JSON.stringify(summary)}`)
  console.log(`${TAG} RESULT: ${failures.length === 0 ? 'PASS' : 'FAIL'} ${measurements - failures.length} of ${measurements} measurements`)
  process.exitCode = failures.length === 0 ? 0 : 1
}

main().catch(err => {
  console.error(`${TAG} FATAL`, err?.stack || err)
  process.exitCode = 1
})
