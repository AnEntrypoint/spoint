#!/usr/bin/env node
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'

process.env.SPOINT_NO_WATCH = '1'
process.env.SPOINT_SKIP_PREWARM = '1'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true'] }))
const SCENARIO = args.scenario || 'hosting'
const RELIEF = Number(args.relief ?? 0.0005)

const { createClusterRuntime } = await import('../src/sharding/ClusterRuntime.js')
const { ClusterWorldCapacityError } = await import('../src/sharding/ClusterWorldHost.js')
const { exportPlayerHandoff, admitPlayerHandoff, applyAdmittedInputs, releaseHandoffSource, playerIdOfSession } = await import('../src/sharding/ClusterHandoff.js')
const { PhysicsNetworkClient } = await import('../src/client/PhysicsNetworkClient.js')
const { loadWorldModule } = await import('../src/sdk/WorldLocator.js')
const { createChartAnchorLattice, snapshotChart, createChartTransfer } = await import('../src/shared/chartAnchor.js')
const { anchorBasis, tangentLocalToDir } = await import('../src/terrain/PlanetFrame.js')
const { resolveClusterConfig } = await import('../src/shared/clusterConfig.js')
const { pack } = await import('../src/protocol/msgpack.js')
const { MSG } = await import('../src/protocol/MessageTypes.js')

const log = message => console.error(`[cluster-harness ${(performance.now() / 1000).toFixed(1)}s] ${message}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const round = (x, d = 6) => x == null ? x : Number(x.toFixed(d))
const hypot3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const degOf = rad => rad * 180 / Math.PI

async function untilTrue(cond, timeoutMs) {
  const t0 = performance.now()
  while (!cond()) {
    if (performance.now() - t0 > timeoutMs) return false
    await sleep(20)
  }
  return true
}

async function until(cond, timeoutMs, label) {
  const t0 = performance.now()
  while (!cond()) {
    if (performance.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`)
    await sleep(20)
  }
  return performance.now() - t0
}

async function baseWorld(clusters) {
  const workDir = resolve(SDK_ROOT, 'data', 'cluster-harness', `work-${process.pid}`)
  await mkdir(resolve(workDir, 'data'), { recursive: true })
  process.chdir(workDir)
  const loaded = await loadWorldModule(resolve(SDK_ROOT, 'apps/world/tps-game.js'))
  const worldDef = { ...loaded, entities: [{ id: 'spawn-1', position: [0, 3, 0], app: 'spawn-point', config: { team: 'any' } }], spawnPoint: [0, 3, 0], terrain: { ...loaded.terrain, bakedHeightfield: undefined, carves: [], vegetation: { enabled: false }, reliefScale: RELIEF, clusters } }
  const serverConfig = { tickRate: 60, appsDirs: [resolve(SDK_ROOT, 'apps'), resolve(SDK_ROOT, 'src/stdlib-apps')], sdkRoot: SDK_ROOT, staticDirs: [], storageDir: resolve(workDir, 'data') }
  return { worldDef, serverConfig }
}

function makeClient(url) {
  const heading = { yaw: 0, pitch: 0, walking: false, sprint: true }
  const client = new PhysicsNetworkClient({ url, predictionEnabled: true, smoothInterpolation: true, collisionMirror: true, autoMigrate: false, webTransport: { enabled: false } })
  client.startInputLoop(() => ({ forward: heading.walking, sprint: heading.sprint, yaw: heading.yaw, pitch: heading.pitch }))
  return { client, heading }
}

const slopeDegAt = (server, x, z) => {
  const frame = server.physics._planetFrame
  const g = (a, b) => frame.groundHeightLocal(a, b)
  return degOf(Math.atan(Math.hypot(g(x + 1, z) - g(x - 1, z), g(x, z + 1) - g(x, z - 1)) / 2))
}
const angleFromAnchorDeg = (world, dir) => { const a = world.anchorDir; const l = Math.hypot(...a); return degOf(Math.acos(Math.min(1, (a[0] * dir[0] + a[1] * dir[1] + a[2] * dir[2]) / l))) }
const dirOfPlayer = (server, pos) => server.physics._planetFrame.localToDir(pos[0], pos[2])
const dirOfPlayerFull = (server, pos) => server.physics._planetFrame.localToDir(pos[0], pos[2], pos[1])

async function scenarioManager() {
  const { worldDef } = await baseWorld({ enabled: true })
  const { createClusterManager } = await import('../src/sharding/ClusterManager.js')
  const tcfg = worldDef.terrain
  const config = resolveClusterConfig(tcfg.clusters, { radius: tcfg.radius, relevanceRadius: worldDef.relevanceRadius ?? 200 })
  let clock = 0
  const manager = createClusterManager({ config, now: () => clock })
  const basis = anchorBasis([0.9, 0.1, 0.4])
  let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  const players = Array.from({ length: 64 }, (_, id) => ({ id, x: (rnd() - 0.5) * 8000, z: (rnd() - 0.5) * 8000, vx: (rnd() - 0.5) * 14, vz: (rnd() - 0.5) * 14 }))
  const callHz = 20, seconds = 600
  let worst = 0, assignmentEvents = 0
  manager.onAssignment(result => { assignmentEvents += result.events.length })
  for (let tick = 0; tick < callHz * seconds; tick++) {
    clock = tick * 1000 / callHz
    for (const p of players) { p.x += p.vx / callHz; p.z += p.vz / callHz; if (Math.abs(p.x) > 4000) p.vx = -p.vx; if (Math.abs(p.z) > 4000) p.vz = -p.vz; manager.setPlayerDir(p.id, tangentLocalToDir(basis, tcfg.radius, p.x, p.z)) }
    const result = manager.step()
    if (result) for (const c of result.clusters) for (const id of c.memberIds) { const d = manager.dirOf(id); const dp = d[0] * c.anchorDir[0] + d[1] * c.anchorDir[1] + d[2] * c.anchorDir[2]; worst = Math.max(worst, degOf(Math.acos(Math.min(1, dp)))) }
  }
  const bound = degOf(Math.asin(config.memberRadiusM * config.stayFactor / tcfg.radius)) + config.cellWorstDeg
  const antipodal = createClusterManager({ config, now: () => 0 })
  antipodal.setPlayerDir('n', [0, 1, 0]); antipodal.setPlayerDir('s', [0, -1, 0]); antipodal.setPlayerDir('bad', [0, 0, 0])
  const antipodalResult = antipodal.step({ force: true })
  return {
    callsPerSecond: callHz, simulatedSeconds: seconds, configuredHz: config.hz, assignmentsRun: manager.stats.steps, expectedAssignments: config.hz * seconds,
    stats: manager.stats, worstMemberAngleFromAnchorDeg: round(worst, 3), analyticBoundDeg: round(bound, 3),
    antipodal: { clusters: antipodalResult.clusters.length, rejected: antipodalResult.rejected },
    configErrors: ['cluster-link-below-relevance-ring', 'cluster-link-below-weapon-range', 'cluster-radius-exceeds-walkable-chart', 'cluster-worlds-exceed-wasm-heap-budget'].map((code, i) => {
      const spec = [{ enabled: true, linkM: 500 }, { enabled: true }, { enabled: true, memberRadiusM: 40000 }, { enabled: true, maxWorldsPerProcess: 9 }][i]
      try { resolveClusterConfig(spec, { radius: tcfg.radius, relevanceRadius: 200, maxWeaponRangeM: i === 1 ? 5000 : 0 }); return { expected: code, got: null } } catch (e) { return { expected: code, got: e.code } }
    }),
    flagOff: resolveClusterConfig({ enabled: false }, { radius: tcfg.radius }) === null && resolveClusterConfig(undefined, { radius: tcfg.radius }) === null,
  }
}

async function scenarioHosting() {
  const { worldDef, serverConfig } = await baseWorld({ enabled: true, idleGraceMs: 1500 })
  const R = worldDef.terrain.radius
  const centre = anchorBasis([0.3, 0.7, 0.4])
  const placements = { A: tangentLocalToDir(centre, R, -10000, 0), B: tangentLocalToDir(centre, R, 10000, 0) }
  const runtime = createClusterRuntime({ worldDef, serverConfig })
  const rss0 = process.memoryUsage().rss / 1048576
  for (const [id, dir] of Object.entries(placements)) runtime.manager.setPlayerDir(id, dir)
  const t0 = performance.now()
  runtime.manager.step({ force: true })
  await runtime.coordinator.settle()
  const createMs = performance.now() - t0
  const ids = { A: runtime.manager.clusterOf('A'), B: runtime.manager.clusterOf('B') }
  const clients = {}
  for (const id of ['A', 'B']) {
    const world = runtime.host.worldOf(ids[id])
    clients[id] = makeClient(world.url)
    await clients[id].client.connect()
  }
  await until(() => ['A', 'B'].every(id => clients[id].client.playerId && clients[id].client.getLocalState()?.onGround), 60000, 'both clients grounded')
  await until(() => ['A', 'B'].every(id => { const s = runtime.host.worldOf(ids[id]).server; const p = s.playerManager.getPlayer(clients[id].client.playerId)?.state.position; return p && Math.abs(p[1] - s.physics.terrainHeightAt(p[0], p[2])) < 2 }), 90000, 'both players standing on the collider')
  await sleep(1500)
  const report = {}
  for (const id of ['A', 'B']) {
    const world = runtime.host.worldOf(ids[id])
    const server = world.server
    const player = server.playerManager.getPlayer(clients[id].client.playerId)
    const pos = player.state.position
    const dir = dirOfPlayer(server, pos)
    report[id] = {
      cluster: ids[id], worldPort: world.port, playersInWorld: server.playerManager.getPlayerCount(),
      clientSeesPlayers: (s => s.size ?? s.length)(clients[id].client.getAllStates()),
      serverOnGround: player.state.onGround, groundGapM: round(pos[1] - server.physics.terrainHeightAt(pos[0], pos[2]), 3), colliderGapM: (() => { const hit = server.physics.raycast([pos[0], pos[1] + 600, pos[2]], [0, -1, 0], 2000); return hit.hit ? { gapM: round(pos[1] - hit.position[1], 3), shape: server.physics.bodyMeta.get(hit.bodyId)?.shape ?? null, hitY: round(hit.position[1], 2), playerY: round(pos[1], 2), terrainY: round(server.physics.terrainHeightAt(pos[0], pos[2]), 2) } : null })(),
      offsetFromAnchorM: round(Math.hypot(pos[0], pos[2]), 1), angleFromAnchorDeg: round(angleFromAnchorDeg(world, dir), 3), slopeUnderPlayerDeg: round(slopeDegAt(server, pos[0], pos[2]), 3),
      chartEpoch: server.physics._planetFrame.chartEpoch,
    }
  }
  const rssAfterTwo = process.memoryUsage().rss / 1048576
  const extra = []
  for (let i = 0; i < 5; i++) {
    const dir = tangentLocalToDir(anchorBasis([Math.cos(i * 1.1), 0.2, Math.sin(i * 1.1)]), R, 0, 0)
    runtime.manager.setPlayerDir(`X${i}`, dir)
  }
  runtime.manager.step({ force: true })
  await runtime.coordinator.settle()
  const refusal = runtime.coordinator.refusals[0] ?? null
  const afterCap = { hosted: runtime.host.stats.hosted, maxWorlds: runtime.host.stats.maxWorlds, refused: runtime.host.stats.refused, refusals: runtime.coordinator.refusals.map(r => ({ code: r.code, clusterId: r.clusterId })), refusalIsNamed: refusal?.code === 'cluster-world-capacity-exhausted', capacityErrorIsClass: refusal ? refusal.message.startsWith('cluster-world-capacity-exhausted') : null }
  const rssAtCap = process.memoryUsage().rss / 1048576
  const hostedBefore = runtime.host.hostedIds.length
  for (let i = 0; i < 5; i++) runtime.manager.removePlayer(`X${i}`)
  runtime.manager.step({ force: true })
  await runtime.coordinator.settle()
  const hostedAfterRemoval = runtime.host.hostedIds.length
  await sleep(1800)
  runtime.manager.step({ force: true })
  await runtime.coordinator.settle()
  const dormancy = { hostedBeforeRemoval: hostedBefore, hostedRightAfterRemoval: hostedAfterRemoval, hostedAfterGrace: runtime.host.hostedIds.length, destroyed: runtime.host.stats.destroyed, stillHostsRealPlayers: [ids.A, ids.B].every(id => runtime.host.has(id)) }
  for (const id of ['A', 'B']) clients[id].client.disconnect()
  const out = { createTwoWorldsMs: round(createMs, 0), clusters: ids, report, rssMB: { before: round(rss0, 0), afterTwoWorlds: round(rssAfterTwo, 0), atCap: round(rssAtCap, 0), perWorld: round((rssAtCap - rss0) / afterCap.hosted, 1) }, afterCap, dormancy, hostStats: runtime.host.stats }
  for (const id of runtime.host.hostedIds) await runtime.host.destroy(id)
  return out
}

async function scenarioHeap() {
  const { worldDef, serverConfig } = await baseWorld({ enabled: true })
  const { createClusterServerWorldFactory } = await import('../src/sharding/ClusterServerWorld.js')
  const factory = createClusterServerWorldFactory({ baseWorldDef: worldDef, serverConfig })
  const wanted = Number(args.worlds ?? 8)
  const worlds = []
  const perWorld = []
  for (let i = 0; i < wanted; i++) {
    const dir = tangentLocalToDir(anchorBasis([Math.cos(i * 0.9), 0.3, Math.sin(i * 0.9)]), worldDef.terrain.radius, 0, 0)
    let world = null
    try { world = await factory.createWorld(i + 1, { anchorDir: dir, spawnDirs: [dir] }) } catch (e) { return { worlds: worlds.length, perWorld, abortedAt: i + 1, abortMessage: e?.message ?? String(e) } }
    worlds.push(world)
    const heap = world.server.physics.wasmHeapBytes()
    const ticks0 = worlds.map(w => w.server.tickSystem.currentTick)
    await sleep(2000)
    const ticks1 = worlds.map(w => w.server.tickSystem.currentTick)
    const row = {
      world: worlds.length, rssMB: round(process.memoryUsage().rss / 1048576, 0),
      wasmFreeMB: round(heap.free / 1048576, 1), wasmTotalMB: round(heap.total / 1048576, 1), wasmWorlds: heap.worlds,
      ticksPerSecond: ticks1.map((t, k) => round((t - ticks0[k]) / 2, 1)),
    }
    perWorld.push(row)
    console.error(`HEAPPROBE worlds=${row.world} rssMB=${row.rssMB} wasmFreeMB=${row.wasmFreeMB}/${row.wasmTotalMB} sharedBy=${row.wasmWorlds} ticksPerSecond=${row.ticksPerSecond.join(',')}`)
  }
  const heapCost = perWorld.map((r, i) => i === 0 ? null : round(perWorld[i - 1].wasmFreeMB - r.wasmFreeMB, 1)).slice(1)
  return { worlds: worlds.length, perWorld, heapCostMBPerExtraWorld: heapCost, configuredCeiling: resolveClusterConfig({ enabled: true }, { radius: worldDef.terrain.radius, relevanceRadius: worldDef.relevanceRadius ?? 200 }).maxWorlds }
}

async function scenarioHandoff() {
  const spec = { enabled: true, memberRadiusM: 300, linkM: 600, hz: 2, idleGraceMs: 3000 }
  const { worldDef, serverConfig } = await baseWorld(spec)
  const R = worldDef.terrain.radius
  const centre = anchorBasis([0.3, 0.7, 0.4])
  const { chartLocalSpawnOf } = await import('../src/sharding/ClusterServerWorld.js')
  const tracked = new Map()
  const handoffs = []
  let baseChart = null
  const chartCache = new Map()
  const chartOf = world => { if (!chartCache.has(world.clusterId)) chartCache.set(world.clusterId, snapshotChart(world.server.physics._planetFrame)); return chartCache.get(world.clusterId) }
  const toPlanet = (world, p) => createChartTransfer(chartOf(world), baseChart).point(p, [0, 0, 0])
  const velToPlanet = (world, v) => createChartTransfer(chartOf(world), baseChart).vec(v, [0, 0, 0])
  const restoredInitial = new Map()
  const runtimeRef = {}

  const onHandoff = async event => {
    const rec = tracked.get(event.playerId)
    const srcWorld = runtimeRef.host.worldOf(event.from), dstWorld = runtimeRef.host.worldOf(event.to)
    if (!srcWorld || !dstWorld) throw new Error(`handoff ${event.playerId} ${event.from}->${event.to}: a world is missing`)
    const t0 = performance.now()
    log(`handoff begin ${event.playerId} ${event.from}->${event.to}`)
    const exported = exportPlayerHandoff(srcWorld.server, rec.localId)
    log(`  exported localId=${rec.localId}`)
    const admitted = await admitPlayerHandoff(dstWorld.server, exported)
    log(`  admitted token=${admitted.token}`)
    const speedAdmitted = Math.hypot(...velToPlanet(dstWorld, admitted.state.velocity))
    const planetBefore = toPlanet(srcWorld, exported.state.position), planetAdmitted = toPlanet(dstWorld, admitted.state.position)
    const speedBefore = Math.hypot(...velToPlanet(srcWorld, exported.state.velocity))
    const dirBefore = dirOfPlayer(srcWorld.server, exported.state.position), dirAdmitted = dirOfPlayer(dstWorld.server, admitted.state.position)
    const dirGapDeg = degOf(Math.acos(Math.min(1, dirBefore[0] * dirAdmitted[0] + dirBefore[1] * dirAdmitted[1] + dirBefore[2] * dirAdmitted[2])))
    const look = admitted.transfer.look(rec.heading.yaw, rec.heading.pitch)
    log(`  exported pos=${exported.state.position.map(v => v.toFixed(2)).join(',')} vel=${exported.state.velocity.map(v => v.toFixed(2)).join(',')} onGround=${exported.state.onGround}`)
    log(`  admitted pos=${admitted.state.position.map(v => v.toFixed(2)).join(',')} vel=${admitted.state.velocity.map(v => v.toFixed(2)).join(',')} dirGapDeg=${dirGapDeg.toFixed(6)}`)
    const yawBefore = rec.heading.yaw
    releaseHandoffSource(srcWorld.server, rec.localId)
    rec.client.disconnect()
    log(`  source released`)
    const next = makeClient(dstWorld.url)
    next.heading.walking = rec.heading.walking
    next.heading.yaw = look.yaw
    next.heading.pitch = look.pitch
    await next.client.connect()
    log(`  connected to ${event.to}`)
    next.client.ws.send(pack({ type: MSG.RECONNECT, payload: { sessionToken: admitted.token } }))
    await until(() => playerIdOfSession(dstWorld.server, admitted.token) !== null, 30000, 'handoff session joined')
    const localId = applyAdmittedInputs(dstWorld.server, admitted.token, admitted.lastInput)
    log(`  joined as ${localId}`)
    const restored = restoredInitial.get(dstWorld.clusterId) ?? null
    const planetRestored = restored ? toPlanet(dstWorld, restored.position) : null
    const tGround = performance.now()
    let grounded = false
    for (let probe = 0; probe < 10 && !grounded; probe++) {
      grounded = await untilTrue(() => dstWorld.server.playerManager.getPlayer(localId)?.state.onGround, 2000)
      const s = dstWorld.server.playerManager.getPlayer(localId)?.state
      const bodies = [...dstWorld.server.physicsIntegration.playerBodies.entries()].map(([k, v]) => `${k}:char=${v.charId}:ground=${v.onGround}`).join(' ')
      if (s) log(`  probe${probe} onGround=${s.onGround} pos=${s.position.map(v => v.toFixed(1)).join(',')} vel=${s.velocity.map(v => v.toFixed(2)).join(',')} terrainY=${dstWorld.server.physics.terrainHeightAt(s.position[0], s.position[2]).toFixed(1)} anchorDist=${Math.hypot(s.position[0], s.position[2]).toFixed(0)} bodies=[${bodies}]`)
    }
    const stallMs = performance.now() - t0
    rec.client = next.client; rec.heading = next.heading; rec.localId = localId; rec.cluster = event.to
    handoffs.push({
      player: event.playerId, from: event.from, to: event.to,
      transferGapM: hypot3(planetBefore, planetAdmitted), dirGapDeg: round(dirGapDeg, 6),
      restoredGapM: planetRestored ? hypot3(planetBefore, planetRestored) : null,
      speedBeforeMps: round(speedBefore, 4), speedAdmittedMps: round(speedAdmitted, 4),
      restoredSpeedMps: restored ? round(Math.hypot(...velToPlanet(dstWorld, restored.velocity)), 4) : null,
      yawChangeRad: round(look.yaw - yawBefore, 4), carriedLastInput: !!admitted.lastInput, stallMs: round(stallMs, 0),
      chartTiltDeg: round(degOf(admitted.transfer.tiltRad), 3), grounded,
      landedPos: dstWorld.server.playerManager.getPlayer(localId)?.state.position.map(v => round(v, 2)) ?? null,
      nameExported: exported.name ?? null, nameLanded: dstWorld.server.playerManager.getPlayer(localId)?.name ?? null,
    })
    log(`handoff ${event.playerId} ${event.from}->${event.to} gap ${handoffs.at(-1).transferGapM.toExponential(2)} m stall ${handoffs.at(-1).stallMs} ms name ${handoffs.at(-1).nameExported} -> ${handoffs.at(-1).nameLanded}`)
  }

  const runtime = createClusterRuntime({ worldDef, serverConfig, onHandoff })
  Object.assign(runtimeRef, runtime)
  const wrapAdd = (clusterId, server) => {
    const original = server.playerManager.addPlayer.bind(server.playerManager)
    server.playerManager.addPlayer = (socket, initial = {}) => { restoredInitial.set(clusterId, { position: [...(initial.position || [0, 0, 0])], velocity: [...(initial.velocity || [0, 0, 0])] }); return original(socket, initial) }
  }
  const origEnsure = runtime.host.ensure
  runtime.host.ensure = async (id, d) => { const w = await origEnsure(id, d); if (!w._wrapped) { wrapAdd(w.clusterId, w.server); w._wrapped = true }; return w }

  const placement = { P: tangentLocalToDir(centre, R, 0, 0), M: tangentLocalToDir(centre, R, 800, 0) }
  for (const [id, dir] of Object.entries(placement)) runtime.manager.setPlayerDir(id, dir)
  runtime.manager.step({ force: true })
  await runtime.coordinator.settle()
  for (const id of ['P', 'M']) {
    const cluster = runtime.manager.clusterOf(id)
    const world = runtime.host.worldOf(cluster)
    if (!baseChart) baseChart = chartOf(world)
    const c = makeClient(world.url)
    await c.client.connect()
    tracked.set(id, { client: c.client, heading: c.heading, cluster, localId: null })
  }
  await until(() => [...tracked.values()].every(r => r.client.playerId), 30000, 'clients joined')
  for (const r of tracked.values()) r.localId = r.client.playerId
  await until(() => [...tracked.values()].every(r => { const s = runtime.host.worldOf(r.cluster).server; const p = s.playerManager.getPlayer(r.localId)?.state.position; return p && Math.abs(p[1] - s.physics.terrainHeightAt(p[0], p[2])) < 2 }), 90000, 'both standing')
  log('both players standing, M approaches P')

  const posOf = id => { const r = tracked.get(id); const w = runtime.host.worldOf(r.cluster); return { w, p: w.server.playerManager.getPlayer(r.localId)?.state.position } }
  const refresh = () => { for (const id of ['P', 'M']) { const { w, p } = posOf(id); if (p) runtime.manager.setPlayerDir(id, dirOfPlayer(w.server, p)) } }
  const aim = (fromId, toId, away) => {
    const a = posOf(fromId), b = posOf(toId)
    if (!a.p || !b.p) return
    const target = a.w === b.w ? b.p : chartLocalSpawnOf(a.w.anchorDir, R, dirOfPlayer(b.w.server, b.p))
    tracked.get(fromId).heading.yaw = Math.atan2(target[0] - a.p[0], target[2] - a.p[2]) + (away ? Math.PI : 0)
  }
  const separationM = () => { const [a, b] = ['P', 'M'].map(id => runtime.manager.dirOf(id)); return R * Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) }
  const samples = []
  const sampler = setInterval(() => { const { w, p } = posOf('M'); if (p) samples.push({ t: performance.now(), cluster: w.clusterId, planet: toPlanet(w, p), sep: separationM() }) }, 20)
  const t0 = performance.now()
  const phases = []
  tracked.get('M').heading.walking = true
  let phase = 'approach'
  let lastLog = 0
  while (performance.now() - t0 < Number(args.limitMs || 420000)) {
    refresh()
    runtime.manager.step()
    await runtime.coordinator.settle()
    refresh()
    aim('M', 'P', phase === 'away')
    if (performance.now() - lastLog > 3000) {
      lastLog = performance.now()
      const { w, p } = posOf('M')
      log(`sep=${separationM().toFixed(0)}m P=${runtime.manager.clusterOf('P')} M=${runtime.manager.clusterOf('M')} mPos=${p ? p.map(v => v.toFixed(1)).join(',') : 'none'} anchor=${w.anchorDir.map(v => v.toFixed(3)).join(',')}`)
    }
    const sameCluster = runtime.manager.clusterOf('M') === runtime.manager.clusterOf('P')
    if (phase === 'approach' && sameCluster && handoffs.length >= 1) { phase = 'away'; phases.push({ phase: 'away', atS: round((performance.now() - t0) / 1000, 1), separationM: round(separationM(), 0) }); log(`merged at ${separationM().toFixed(0)} m, walking away`) }
    if (phase === 'away') { aim('P', 'M', true); tracked.get('P').heading.walking = true }
    if (phase === 'away' && handoffs.length >= 2) break
    await sleep(250)
  }
  clearInterval(sampler)
  for (const r of tracked.values()) r.heading.walking = false
  const steps = []
  for (let i = 1; i < samples.length; i++) if (samples[i].t - samples[i - 1].t < 200 && samples[i].cluster === samples[i - 1].cluster) steps.push({ step: hypot3(samples[i].planet, samples[i - 1].planet), dt: (samples[i].t - samples[i - 1].t) / 1000 })
  const speeds = steps.filter(s => s.dt > 0.005).map(s => s.step / s.dt).sort((a, b) => a - b)
  const gaps = []
  for (let i = 1; i < samples.length; i++) if (samples[i].t - samples[i - 1].t >= 200 || samples[i].cluster !== samples[i - 1].cluster) gaps.push({ ms: round(samples[i].t - samples[i - 1].t, 0), jumpM: round(hypot3(samples[i].planet, samples[i - 1].planet), 3), fromCluster: samples[i - 1].cluster, toCluster: samples[i].cluster })
  const seps = samples.map(s => s.sep).filter(Number.isFinite)
  const out = {
    spec, phases, handoffs, managerStats: runtime.manager.stats, hostStats: runtime.host.stats, refusals: runtime.coordinator.refusals,
    separationM: { initial: round(seps[0], 0), min: round(Math.min(...seps), 0), max: round(Math.max(...seps), 0), final: round(seps.at(-1), 0) },
    moverPlanetSpeedMps: { p50: round(speeds[Math.floor(speeds.length * 0.5)], 3), p95: round(speeds[Math.floor(speeds.length * 0.95)], 3), max: round(speeds.at(-1), 3), samples: speeds.length },
    moverGapsAcrossHandoff: gaps,
  }
  for (const r of tracked.values()) r.client.disconnect()
  for (const id of runtime.host.hostedIds) await runtime.host.destroy(id)
  return out
}

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const angleDegBetween = (a, b) => degOf(Math.acos(Math.min(1, dot3(a, b))))

async function scenarioTilt() {
  const { worldDef, serverConfig } = await baseWorld({ enabled: true, memberRadiusM: 300, linkM: 600, hz: 2 })
  const R = worldDef.terrain.radius
  const centre = anchorBasis([0.3, 0.7, 0.4])
  const { createClusterServerWorldFactory } = await import('../src/sharding/ClusterServerWorld.js')
  const factory = createClusterServerWorldFactory({ baseWorldDef: worldDef, serverConfig })
  const separationM = Number(args.separation ?? 6000)
  const dirA = tangentLocalToDir(centre, R, -separationM / 2, 0)
  const dirB = tangentLocalToDir(centre, R, separationM / 2, 0)
  const spawnDir = dirB
  const worldA = await factory.createWorld(1, { anchorDir: dirA, spawnDirs: [spawnDir] })
  const worldB = await factory.createWorld(2, { anchorDir: dirB, spawnDirs: [spawnDir] })
  const chartA = snapshotChart(worldA.server.physics._planetFrame)
  const chartB = snapshotChart(worldB.server.physics._planetFrame)
  const toChartA = createChartTransfer(chartB, chartA)
  const anchorTiltDeg = angleDegBetween(worldA.server.physics._planetFrame.anchorDir, worldB.server.physics._planetFrame.anchorDir)
  const client = makeClient(worldA.url)
  await client.client.connect()
  await until(() => client.client.playerId && client.client.getLocalState()?.onGround, 60000, 'tilt: player grounded in the source world')
  client.heading.walking = true
  await sleep(2500)
  const exported = exportPlayerHandoff(worldA.server, client.client.playerId)
  const admitted = await admitPlayerHandoff(worldB.server, exported)
  const speedBefore = Math.hypot(...exported.state.velocity)
  const speedAdmitted = Math.hypot(...admitted.state.velocity)
  const dirGapDeg = angleDegBetween(dirOfPlayer(worldA.server, exported.state.position), dirOfPlayer(worldB.server, admitted.state.position))
  const localShiftM = Math.hypot(admitted.state.position[0] - exported.state.position[0], admitted.state.position[2] - exported.state.position[2])
  const look = admitted.transfer.look(client.heading.yaw, client.heading.pitch)
  releaseHandoffSource(worldA.server, client.client.playerId)
  client.client.disconnect()
  const next = makeClient(worldB.url)
  next.heading.yaw = look.yaw
  next.heading.pitch = look.pitch
  await next.client.connect()
  next.client.ws.send(pack({ type: MSG.RECONNECT, payload: { sessionToken: admitted.token } }))
  await until(() => playerIdOfSession(worldB.server, admitted.token) !== null, 30000, 'tilt: session joined the destination world')
  const localId = applyAdmittedInputs(worldB.server, admitted.token, admitted.lastInput)
  let grounded = false
  for (let probe = 0; probe < 10 && !grounded; probe++) {
    grounded = await untilTrue(() => worldB.server.playerManager.getPlayer(localId)?.state.onGround, 2000)
    const s = worldB.server.playerManager.getPlayer(localId)?.state
    if (s) log(`  tiltprobe${probe} onGround=${s.onGround} pos=${s.position.map(v => v.toFixed(1)).join(',')} terrainY=${worldB.server.physics.terrainHeightAt(s.position[0], s.position[2]).toFixed(1)}`)
  }
  const landed = worldB.server.playerManager.getPlayer(localId)?.state ?? null
  next.client.disconnect()
  const out = {
    separationM, anchorTiltDeg: round(anchorTiltDeg, 4), transferTiltDeg: round(degOf(admitted.transfer.tiltRad), 4),
    planetGapM: hypot3(exported.state.position, toChartA.point(admitted.state.position)),
    dirGapDeg: round(dirGapDeg, 6), dirGapFullDeg: round(angleDegBetween(dirOfPlayerFull(worldA.server, exported.state.position), dirOfPlayerFull(worldB.server, admitted.state.position)), 6),
    localShiftM: round(localShiftM, 1),
    exportedPos: exported.state.position.map(v => round(v, 2)), admittedPos: admitted.state.position.map(v => round(v, 2)),
    grounded, onGroundExported: exported.state.onGround,
    groundGapM: landed ? round(landed.position[1] - worldB.server.physics.terrainHeightAt(landed.position[0], landed.position[2]), 3) : null,
    speedBeforeMps: round(speedBefore, 4), speedAdmittedMps: round(speedAdmitted, 4), speedLandedMps: landed ? round(Math.hypot(...landed.velocity), 4) : null,
    yawBefore: round(client.heading.yaw, 4), yawAdmitted: round(look.yaw, 4),
    landedPos: landed ? landed.position.map(v => round(v, 2)) : null,
  }
  await factory.destroyWorld(1, worldA)
  await factory.destroyWorld(2, worldB)
  return out
}

const SCENARIOS = { manager: scenarioManager, hosting: scenarioHosting, heap: scenarioHeap, handoff: scenarioHandoff, tilt: scenarioTilt }
const run = SCENARIOS[SCENARIO]
if (!run) { console.error(`unknown scenario ${SCENARIO}; one of ${Object.keys(SCENARIOS).join(', ')}`); process.exit(2) }
const result = await run()
console.log(`=====RESULT=====
${JSON.stringify({ scenario: SCENARIO, ...result }, null, 1)}`)
process.exit(0)
