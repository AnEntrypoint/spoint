import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks'
import { createServer as createNetServer } from 'node:net'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createServer as createSpointServer } from '../src/sdk/server.js'
import { loadWorldModule } from '../src/sdk/WorldLocator.js'
import { resolveTerrainConfig } from '../src/shared/terrainConfig.js'
import { loadPlanetSampler, planetSamplerOptsOf } from '../src/terrain/TerrainPhysics.js'
import { createPlanetFrame } from '../src/terrain/PlanetFrame.js'
import { createCachedAnchorField } from '../src/terrain/ClimateCache.js'
import { contentionMark, contentionWatch, contentionVerdict, formatContention } from './lib/host-contention.mjs'
import { counterSpan, cpuPerThousand } from './lib/counted-work.mjs'

const SDK_ROOT = resolve(process.argv[2] || process.cwd())
const WORK_DIR = resolve(SDK_ROOT, 'data', 'collider-ring-scale-witness')
const CENTER_COUNTS = [24, 64, 128, 192]
const MOVING_CENTERS = 192
const CENTER_SPACING_M = 60
const REBUILDS = 10
const LAST_REBUILDS = 5
const CADENCE_MS = 300
const TICK_RATE = 64
const RING_WORK_PER_1K_EXAMINED_MS = 25
const SETTLED_SCAN_RATIO = 4
const CPU_QUANTUM_MS = 15.6
const WALK_SPEED_MPS = 7
const REBUILD_AT = 0.3
const WORLD_BODY_LIMIT = 10240

const PASS = []
const FAIL = []
function check(label, cond, detail) {
  if (cond) { PASS.push(label); console.log(`  [PASS] ${label}`) }
  else { FAIL.push(label); console.log(`  [FAIL] ${label}${detail ? ' -- ' + detail : ''}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const gcKinds = new Map()
let gcMs = 0, gcCount = 0
const gcObserver = new PerformanceObserver(list => {
  for (const e of list.getEntries()) {
    if (e.entryType !== 'gc') continue
    gcMs += e.duration
    gcCount++
    const kind = e.detail && typeof e.detail.kind === 'number' ? e.detail.kind : 0
    const row = gcKinds.get(kind)
    if (row) { row.count++; row.ms += e.duration }
    else gcKinds.set(kind, { count: 1, ms: e.duration })
  }
})
function gcKind(kind) {
  const row = gcKinds.get(kind)
  return row ? row : { count: 0, ms: 0 }
}
const round = (v, n = 2) => Math.round(v * 10 ** n) / 10 ** n
const pct = v => round(v, 2)

function aggregateSlowSlices(slices) {
  const by = new Map()
  for (const s of slices) {
    const k = `${s.who} ${s.phase}`
    const cur = by.get(k)
    if (!cur || s.ms > cur.ms) by.set(k, { key: k, ms: s.ms, cpuMs: s.cpuMs, count: (cur ? cur.count : 0) + 1 })
    else cur.count++
  }
  return [...by.values()].sort((a, b) => b.ms - a.ms).slice(0, 6)
}

function lattice(count) {
  const side = Math.ceil(Math.sqrt(count))
  const half = (side - 1) / 2
  const out = []
  for (let i = 0; i < count; i++) {
    const gx = i % side, gz = Math.floor(i / side)
    out.push([(gx - half) * CENTER_SPACING_M, (gz - half) * CENTER_SPACING_M])
  }
  return out
}

async function main() {
  process.env.SPOINT_NO_WATCH = '1'
  await mkdir(resolve(WORK_DIR, 'data'), { recursive: true })
  process.chdir(WORK_DIR)

  const freePort = () => new Promise((res, rej) => { const s = createNetServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
  const loaded = await loadWorldModule(resolve(SDK_ROOT, 'apps/world/tps-game.js'))
  const worldDef = { ...loaded, tickRate: TICK_RATE }
  const tcfg = resolveTerrainConfig(worldDef)
  const vcfg = tcfg.vegetation || {}
  const sampler = await loadPlanetSampler(planetSamplerOptsOf(tcfg))
  const frame = createPlanetFrame({ sampler, anchorDir: tcfg.anchorDir || [0, 1, 0], offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
  const anchorField = createCachedAnchorField(sampler.anchorField, frame)
  const { createTrunkColliderStreamer } = await import('../src/terrain/VegPhysics.js')
  const { createRockColliderStreamer } = await import('../src/terrain/RockPhysics.js')

  async function bootWorld(label, slug) {
    const port = await freePort()
    const server = await createSpointServer({
      port, tickRate: TICK_RATE,
      appsDirs: [resolve(SDK_ROOT, 'apps'), resolve(SDK_ROOT, 'src/stdlib-apps')],
      sdkRoot: SDK_ROOT, gravity: worldDef.gravity, staticDirs: [],
      storageDir: resolve(WORK_DIR, 'data', slug),
    })
    await server.loadWorld(worldDef)
    await server.start()
    console.log(`[ring-scale] ${label} world up on ${port} at ${TICK_RATE} Hz`)
    const physics = server.physics
    const ring = physics._terrainStreamer
    const bootTrunkLive = ring?._trunkStreamer?.liveCount ?? null
    const bootRockLive = ring?._rockStreamer?.liveCount ?? null
    console.log(`[ring-scale] production boot ring: trunk ${bootTrunkLive} collider(s), rock ${bootRockLive}`)
    const state = { centers: [[0, 0]] }
    const getCenters = () => state.centers
    const trunk = createTrunkColliderStreamer({
      physics, getCenters, frame, anchorField, worldSeed: tcfg.seed | 0,
      radius: vcfg.colliderRadius || 64, cap: vcfg.colliderCap || 384, maxCenters: vcfg.colliderMaxCenters,
    })
    const rock = createRockColliderStreamer({
      physics, getCenters, frame, anchorField, worldSeed: tcfg.seed | 0,
      radius: vcfg.rockColliderRadius || 32, cap: vcfg.rockColliderCap || 128, maxCenters: vcfg.colliderMaxCenters,
    })
    await trunk.start()
    await rock.start()
    return { label, slug, server, physics, ring, bootTrunkLive, bootRockLive, trunk, rock, state }
  }

  const settledWorld = await bootWorld('settled ladder', 'settled')
  const trunkCheck = settledWorld.trunk.liveCount
  const rockCheck = settledWorld.rock.liveCount
  console.log(`[ring-scale] witness ring at one cluster: trunk ${trunkCheck}, rock ${rockCheck} (production boot: ${settledWorld.bootTrunkLive}/${settledWorld.bootRockLive})`)
  check('the witness builds the production collider ring at one cluster', settledWorld.bootTrunkLive != null && trunkCheck === settledWorld.bootTrunkLive, `witness ${trunkCheck} vs production ${settledWorld.bootTrunkLive}`)
  check('the witness builds the production rock ring at one cluster', settledWorld.bootRockLive != null && rockCheck === settledWorld.bootRockLive, `witness ${rockCheck} vs production ${settledWorld.bootRockLive}`)

  const movingStepM = (vcfg.rockColliderRadius || 32) * REBUILD_AT
  const movingCadenceMs = Math.round((movingStepM / WALK_SPEED_MPS) * 1000)
  console.log(`[ring-scale] moving arm: every cluster walks ${round(movingStepM, 1)} m between rebuilds (the smallest move that trips one, rockRadius x rebuildAt ${REBUILD_AT}) at ${WALK_SPEED_MPS} m/s, so a rebuild every ${movingCadenceMs} ms`)
  async function sweep(ctx, n, moving) {
    const { physics, trunk, rock, server, state } = ctx
    const tickSystem = server.tickSystem
    const cadenceMs = moving ? movingCadenceMs : CADENCE_MS
    const stepM = moving ? movingStepM : 0
    const base = lattice(n)
    const at = k => (moving ? base.map(([x, z]) => [x + k * stepM, z + k * stepM]) : base)
    let centers = at(0)
    state.centers = centers
    const watch = contentionWatch()
    const coldT0 = performance.now()
    const trunkMs0 = trunk.ringBuildMs
    const rockMs0 = rock.ringBuildMs
    await trunk._rebuildMulti(centers, true)
    await rock._rebuildMulti(centers, true)
    const coldMs = performance.now() - coldT0
    const coldTrunk = trunk.ringBuildMs - trunkMs0
    const coldRock = rock.ringBuildMs - rockMs0

    const loop = monitorEventLoopDelay({ resolution: 10 })
    loop.enable()
    gcMs = 0
    gcCount = 0
    gcKinds.clear()
    gcObserver.observe({ entryTypes: ['gc'] })
    const wT0 = performance.now()
    const cpuT0 = process.cpuUsage()
    const stT0 = physics.physicsStats()
    const tick0 = tickSystem?.currentTick ?? 0
    const dilations = []
    const msT0 = trunk.ringBuildMs, msR0 = rock.ringBuildMs
    const phT0 = {
      trunkClassify: trunk.classifyMs, trunkAdd: trunk.addMs, trunkRemove: trunk.removeMs,
      rockClassify: rock.classifyMs, rockAdd: rock.addMs, rockRemove: rock.removeMs,
      trunkNew: trunk.newChunks, rockNew: rock.newChunks,
      trunkTail: trunk.tailMs, rockTail: rock.tailMs,
      trunkRing: trunk.ringMs, rockRing: rock.ringMs,
      trunkScan: trunk.scanMs, rockScan: rock.scanMs,
      trunkRingFresh: trunk.ringFresh, rockRingFresh: rock.ringFresh,
      trunkCompute: trunk.computeMs, rockCompute: rock.computeMs,
      trunkLookup: trunk.scanLookupMs, rockLookup: rock.scanLookupMs,
      trunkBody: trunk.scanBodyMs, rockBody: rock.scanBodyMs,
      trunkExamined: trunk.examined, rockExamined: rock.examined,
      trunkArgsMs: trunk.bodyArgsMs, rockArgsMs: rock.bodyArgsMs,
      trunkArgs: trunk.bodyArgsCalls, rockArgs: rock.bodyArgsCalls,
      trunkArgsSlow: trunk.bodyArgsSlowCalls, rockArgsSlow: rock.bodyArgsSlowCalls,
      trunkNear: trunk.nearTests, rockNear: rock.nearTests,
      trunkCands: trunk.cands, rockCands: rock.cands,
      trunkWork: trunk.workMs, rockWork: rock.workMs,
      trunkSettled: trunk.settledSkips, rockSettled: rock.settledSkips,
      trunkDemand: trunk.prewarmDemand, rockDemand: rock.prewarmDemand,
      trunkArgsPrewarm: trunk.bodyArgsPrewarm, rockArgsPrewarm: rock.bodyArgsPrewarm,
      trunkArgsTouch: trunk.bodyArgsTouch, rockArgsTouch: rock.bodyArgsTouch,
      trunkArgsAdd: trunk.bodyArgsAdd, rockArgsAdd: rock.bodyArgsAdd,
      trunkKeys: trunk.prewarmKeys, rockKeys: rock.prewarmKeys,
      trunkRingOps: { ...trunk.ringCounters }, rockRingOps: { ...rock.ringCounters },
    }
    let deferred = 0
    let maxRebuildMs = 0
    let maxSliceMs = 0
    let maxSlicePhase = 'idle'
    let maxSliceCpuMs = 0
    let maxSliceCpuPhase = 'idle'
    const slowSlices = []
    let yieldSum = 0
    let prevNew = trunk.newChunks
    let prevNewRock = rock.newChunks
    let prewarmSum = 0
    let prewarmDemandSum = 0
    let prewarmKeysSum = 0
    let newSum = 0
    let rebuildCpuMs = 0
    let settledAtCut = null
    const perRebuild = []
    for (let k = 0; k < REBUILDS; k++) {
      if (k === REBUILDS - LAST_REBUILDS) settledAtCut = trunk.settledSkips + rock.settledSkips
      centers = at(k)
      state.centers = centers
      if (k === Math.floor(REBUILDS / 2)) contentionMark(watch)
      const slotStart = performance.now()
      const slotCpu = process.cpuUsage()
      if (await trunk._rebuildMulti(centers, false) === true) deferred++
      maxSliceMs = Math.max(maxSliceMs, trunk.lastMaxSliceMs)
      if (trunk.lastMaxSliceMs >= maxSliceMs) maxSlicePhase = `${trunk.lastMaxSlicePhase}`
      maxSliceCpuMs = Math.max(maxSliceCpuMs, trunk.lastMaxSliceCpuMs)
      if (trunk.lastMaxSliceCpuMs >= maxSliceCpuMs) maxSliceCpuPhase = `${trunk.lastMaxSliceCpuPhase}`
      if (await rock._rebuildMulti(centers, false) === true) deferred++
      maxSliceMs = Math.max(maxSliceMs, rock.lastMaxSliceMs)
      if (rock.lastMaxSliceMs >= maxSliceMs) maxSlicePhase = `${rock.lastMaxSlicePhase}`
      maxSliceCpuMs = Math.max(maxSliceCpuMs, rock.lastMaxSliceCpuMs)
      if (rock.lastMaxSliceCpuMs >= maxSliceCpuMs) maxSliceCpuPhase = `${rock.lastMaxSliceCpuPhase}`
      const slotCpuDelta = process.cpuUsage(slotCpu)
      rebuildCpuMs += (slotCpuDelta.user + slotCpuDelta.system) / 1000
      for (const s of trunk.lastSlowSlices) slowSlices.push({ who: 'trunk', phase: s.phase, ms: s.ms, cpuMs: s.cpuMs })
      for (const s of rock.lastSlowSlices) slowSlices.push({ who: 'rock', phase: s.phase, ms: s.ms, cpuMs: s.cpuMs })
      yieldSum += trunk.lastYieldCount + rock.lastYieldCount
      maxRebuildMs = Math.max(maxRebuildMs, performance.now() - slotStart)
      if (tickSystem) dilations.push(tickSystem.dilationFactor)
      if (n === 192) perRebuild.push(`${trunk.lastExamined}+${rock.lastExamined} examined over ${trunk.chunkKeys}/${rock.chunkKeys} chunk(s), ${trunk.newChunks - prevNew} new trunk + ${rock.newChunks - prevNewRock} new rock, ${trunk.settledSkips}/${rock.settledSkips} settled`)
      newSum += (trunk.newChunks - prevNew) + (rock.newChunks - prevNewRock)
      prevNewRock = rock.newChunks
      prevNew = trunk.newChunks
      prewarmSum += trunk.prewarmMs + rock.prewarmMs
      prewarmDemandSum += trunk.prewarmDemand + rock.prewarmDemand
      prewarmKeysSum += trunk.prewarmKeys + rock.prewarmKeys
      const rest = cadenceMs - (performance.now() - slotStart)
      if (rest > 0) await sleep(rest)    }
    const elapsedS = (performance.now() - wT0) / 1000
    loop.disable()
    const cpu = process.cpuUsage(cpuT0)
    const cpuMs = (cpu.user + cpu.system) / 1000
    gcObserver.disconnect()
    const gcTotalMs = gcMs
    const gcTotalCount = gcCount
    const gcScavenges = gcKind(1).count
    const gcMarkSweeps = gcKind(2).count
    const gcMarkSweepTotalMs = gcKind(2).ms
    const gcBreakdown = [...gcKinds.entries()].map(([k, v]) => `${k}:${v.count}/${round(v.ms, 1)}ms`).join(' ')
    const ticks = (tickSystem?.currentTick ?? 0) - tick0
    const trunkMs = trunk.ringBuildMs - msT0
    const rockMs = rock.ringBuildMs - msR0
    const counts = trunk.centerCounts
    const rockCounts = rock.centerCounts
    const empty = counts.filter(c => c === 0).length
    const rockEmpty = rockCounts.filter(c => c === 0).length
    const starved = trunk.starvedClusters.length
    const rockStarved = rock.starvedClusters.length
    const phase = {
      classify: (trunk.classifyMs - phT0.trunkClassify) + (rock.classifyMs - phT0.rockClassify),
      add: (trunk.addMs - phT0.trunkAdd) + (rock.addMs - phT0.rockAdd),
      remove: (trunk.removeMs - phT0.trunkRemove) + (rock.removeMs - phT0.rockRemove),
    }
    const st1 = physics.physicsStats()
    runShapeBuilds += st1.shapeBuilds - stT0.shapeBuilds
    runShapeReuses += st1.shapeReuses - stT0.shapeReuses
    const contention = contentionVerdict(watch)
    const row = {
      n,
      moving: !!moving,
      spinMsBefore: contention.beforeMs,
      spinMsAfter: contention.afterMs,
      spinMsBest: contention.bestMs,
      contentionSlowdown: contention.slowdown,
      contested: contention.contested,
      clusters: trunk.centers.length,
      coldBuildMs: round(coldMs, 1),
      coldTrunkMs: round(coldTrunk, 1),
      coldRockMs: round(coldRock, 1),
      rebuilds: REBUILDS,
      cadenceMs,
      msPerRebuild: round((trunkMs + rockMs) / REBUILDS, 2),
      trunkMsPerS: pct(trunkMs / elapsedS),
      rockMsPerS: pct(rockMs / elapsedS),
      totalMsPerS: pct((trunkMs + rockMs) / elapsedS),
      msPerTick: round((trunkMs + rockMs) / Math.max(1, ticks), 3),
      workMsPerRebuild: round(((trunk.workMs - phT0.trunkWork) + (rock.workMs - phT0.rockWork)) / REBUILDS, 2),
      settledSkips: (trunk.settledSkips - phT0.trunkSettled) + (rock.settledSkips - phT0.rockSettled),
      trunkSettledSkips: trunk.settledSkips - phT0.trunkSettled,
      rockSettledSkips: rock.settledSkips - phT0.rockSettled,
      lastSkips: settledAtCut === null ? null : (trunk.settledSkips + rock.settledSkips) - settledAtCut,
      settledMisses: { trunk: trunk.settledMisses, rock: rock.settledMisses },
      workMsPerS: pct(((trunk.workMs - phT0.trunkWork) + (rock.workMs - phT0.rockWork)) / elapsedS),
      wallMsPerS: pct((trunkMs + rockMs) / elapsedS),
      cpuMsPerS: pct(rebuildCpuMs / REBUILDS / (cadenceMs / 1000)),
      cpuMsPerRebuild: round(rebuildCpuMs / REBUILDS, 2),
      yieldsPerRebuild: round(yieldSum / REBUILDS, 2),
      windowCpuMsPerS: pct(cpuMs / elapsedS),
      windowCpuFrac: pct(cpuMs / (elapsedS * 1000)),
      maxRebuildMs: round(maxRebuildMs, 2),
      maxSliceMs: round(maxSliceMs, 2),
      maxSlicePhase,
      maxSliceCpuMs: round(maxSliceCpuMs, 2),
      maxSliceCpuPhase,
      slowSlices: aggregateSlowSlices(slowSlices),
      live: trunk.liveCount + rock.liveCount,
      trunkLive: trunk.liveCount,
      rockLive: rock.liveCount,
      cap: trunk.cap + rock.cap,
      residentKB: round((trunk.residentBytes + rock.residentBytes) / 1024, 1),
      byteBudgetKB: round((trunk.byteBudget + rock.byteBudget) / 1024, 1),
      chunkCache: trunk.chunkCacheSize + rock.chunkCacheSize,
      ringCache: trunk.ringCacheSize + rock.ringCacheSize,
      trunkChunkCache: trunk.chunkCacheSize,
      rockChunkCache: rock.chunkCacheSize,
      trunkNewChunks: (trunk.newChunks - phT0.trunkNew) / REBUILDS,
      rockNewChunks: (rock.newChunks - phT0.rockNew) / REBUILDS,
      perClusterMin: counts.length ? Math.min(...counts) : 0,
      perClusterMax: counts.length ? Math.max(...counts) : 0,
      rockPerClusterMin: rockCounts.length ? Math.min(...rockCounts) : 0,
      emptyClusters: empty,
      rockEmptyClusters: rockEmpty,
      starvedClusters: starved,
      rockStarvedClusters: rockStarved,
      classifyMsPerRebuild: round(phase.classify / REBUILDS, 2),
      addMsPerRebuild: round(phase.add / REBUILDS, 2),
      removeMsPerRebuild: round(phase.remove / REBUILDS, 2),
      newChunksPerRebuild: round(newSum / REBUILDS, 1),
      tailMsPerRebuild: round(((trunk.tailMs - phT0.trunkTail) + (rock.tailMs - phT0.rockTail)) / REBUILDS, 2),
      ringMsPerRebuild: round(((trunk.ringMs - phT0.trunkRing) + (rock.ringMs - phT0.rockRing)) / REBUILDS, 2),
      scanMsPerRebuild: round(((trunk.scanMs - phT0.trunkScan) + (rock.scanMs - phT0.rockScan)) / REBUILDS, 2),
      ringFreshPerRebuild: round(((trunk.ringFresh - phT0.trunkRingFresh) + (rock.ringFresh - phT0.rockRingFresh)) / REBUILDS, 1),
      chunkKeysPerRebuild: round((trunk.chunkKeys + rock.chunkKeys) / 2, 0),
      computeMsPerRebuild: round(((trunk.computeMs - phT0.trunkCompute) + (rock.computeMs - phT0.rockCompute)) / REBUILDS, 2),
      prewarmMsPerRebuild: round(prewarmSum / REBUILDS, 2),
      bodyArgsPerRebuild: round(((trunk.bodyArgsCalls - phT0.trunkArgs) + (rock.bodyArgsCalls - phT0.rockArgs)) / REBUILDS, 0),
      bodyArgsMsPerRebuild: round(((trunk.bodyArgsMs - phT0.trunkArgsMs) + (rock.bodyArgsMs - phT0.rockArgsMs)) / REBUILDS, 2),
      prewarmDemandPerRebuild: round(prewarmDemandSum / REBUILDS, 0),
      prewarmKeysPerRebuild: round(prewarmKeysSum / REBUILDS, 0),
      bodyArgsSlowPerRebuild: round(((trunk.bodyArgsSlowCalls - phT0.trunkArgsSlow) + (rock.bodyArgsSlowCalls - phT0.rockArgsSlow)) / REBUILDS, 0),
      bodyArgsPrewarmPerRebuild: round(((trunk.bodyArgsPrewarm - phT0.trunkArgsPrewarm) + (rock.bodyArgsPrewarm - phT0.rockArgsPrewarm)) / REBUILDS, 0),
      bodyArgsTouchPerRebuild: round(((trunk.bodyArgsTouch - phT0.trunkArgsTouch) + (rock.bodyArgsTouch - phT0.rockArgsTouch)) / REBUILDS, 0),
      bodyArgsAddPerRebuild: round(((trunk.bodyArgsAdd - phT0.trunkArgsAdd) + (rock.bodyArgsAdd - phT0.rockArgsAdd)) / REBUILDS, 0),
      lookupMsPerRebuild: round(((trunk.scanLookupMs - phT0.trunkLookup) + (rock.scanLookupMs - phT0.rockLookup)) / REBUILDS, 2),
      bodyMsPerRebuild: round(((trunk.scanBodyMs - phT0.trunkBody) + (rock.scanBodyMs - phT0.rockBody)) / REBUILDS, 2),
      examinedPerRebuild: round(((trunk.examined - phT0.trunkExamined) + (rock.examined - phT0.rockExamined)) / REBUILDS, 0),
      nearPerExamined: round(((trunk.nearTests - phT0.trunkNear) + (rock.nearTests - phT0.rockNear)) / Math.max(1, ((trunk.examined - phT0.trunkExamined) + (rock.examined - phT0.rockExamined))), 1),
      cands: trunk.cands + rock.cands,
      droppedClusters: trunk.droppedCenters + rock.droppedCenters,
      shapeBuildsPerRebuild: round((st1.shapeBuilds - stT0.shapeBuilds) / REBUILDS, 1),
      shapeReusesPerRebuild: round((st1.shapeReuses - stT0.shapeReuses) / REBUILDS, 1),
      shapesCached: st1.shapesCached,
      shapeRefs: st1.shapeRefs,
      deferred,
      achievedHz: pct(ticks / elapsedS),
      dilationMax: dilations.length ? round(Math.max(...dilations), 3) : null,
      loopP99Ms: round(loop.percentile(99) / 1e6, 2),
      loopMaxMs: round(loop.max / 1e6, 2),
      gcMs: round(gcTotalMs, 1),
      gcCount: gcTotalCount,
      gcScavengesPerRebuild: round(gcScavenges / REBUILDS, 2),
      gcMarkSweepPerRebuild: round(gcMarkSweeps / REBUILDS, 2),
      gcMarkSweepMs: round(gcMarkSweepTotalMs, 1),
      gcBreakdown,
      elapsedS: round(elapsedS, 1),
      ringOps: counterSpan(phT0.trunkRingOps, trunk.ringCounters).bodyAdds
        + counterSpan(phT0.trunkRingOps, trunk.ringCounters).evicted
        + counterSpan(phT0.rockRingOps, rock.ringCounters).bodyAdds
        + counterSpan(phT0.rockRingOps, rock.ringCounters).evicted,
      examined: (trunk.examined - phT0.trunkExamined) + (rock.examined - phT0.rockExamined),
    }
    row.cpuPer1kExamined = round(cpuPerThousand(rebuildCpuMs, row.examined), 3)
    row.cpuPer1kRingOps = round(cpuPerThousand(rebuildCpuMs, row.ringOps), 3)
    row.workPer1kExamined = round((row.workMsPerRebuild * REBUILDS / row.examined) * 1000, 3)
    if (perRebuild.length) console.log(`[ring-scale]   per rebuild: ${perRebuild.join(' | ')}`)
    console.log(`[ring-scale] ${row.n} cluster(s)${row.moving ? ' moving' : ''}: ${row.trunkLive}+${row.rockLive} collider(s) of cap ${row.cap}, per-cluster ${row.perClusterMin}..${row.perClusterMax} (starved ${row.starvedClusters}/${row.rockStarvedClusters}), cold build ${row.coldBuildMs} ms, steady ${row.msPerRebuild} ms/rebuild wall = ${row.totalMsPerS} ms/s, of which ${row.workMsPerRebuild} ms/rebuild of uninterrupted work = ${row.workMsPerS} ms/s and ${row.cpuMsPerRebuild} ms/rebuild of CPU time spent inside the rebuild calls = ${row.cpuMsPerS} ms/s (whole window ${row.windowCpuMsPerS} ms/s, ${row.windowCpuFrac} of it on CPU), ${row.msPerTick} ms/tick (classify ${row.classifyMsPerRebuild} / add ${row.addMsPerRebuild} / remove ${row.removeMsPerRebuild} ms per rebuild; ${row.ringFreshPerRebuild} fresh cluster ring(s) over ${row.newChunksPerRebuild} new chunk(s) per rebuild, ring ${row.ringMsPerRebuild} ms + scan ${row.scanMsPerRebuild} ms (chunk lookup ${row.lookupMsPerRebuild} ms of which ${row.computeMsPerRebuild} ms computing ${row.newChunksPerRebuild} new chunk(s), body ${row.bodyMsPerRebuild} ms over ${row.examinedPerRebuild} placement(s) x ${row.nearPerExamined} near test(s)), prewarm ${row.prewarmMsPerRebuild} ms over ${row.bodyArgsPerRebuild} bodyArgs call(s) (prewarm ${row.bodyArgsPrewarmPerRebuild} / touch ${row.bodyArgsTouchPerRebuild} / add ${row.bodyArgsAddPerRebuild}) costing ${row.bodyArgsMsPerRebuild} ms (${row.bodyArgsSlowPerRebuild} over 50 us) pre-creating ${row.prewarmDemandPerRebuild} body(s) across ${row.prewarmKeysPerRebuild} shape(s), over ${row.chunkKeysPerRebuild} chunk(s); ${row.cands} candidate(s), tail ${row.tailMsPerRebuild} ms, ${row.shapeBuildsPerRebuild} shape(s) built + ${row.shapeReusesPerRebuild} reused per rebuild of ${row.shapesCached} cached / ${row.shapeRefs} key(s) with a live body), longest rebuild ${row.maxRebuildMs} ms of which the longest uninterrupted slice ${row.maxSliceMs} ms (${row.maxSlicePhase}), ${row.achievedHz} Hz, dilation<=${row.dilationMax}, loop p99 ${row.loopP99Ms}/max ${row.loopMaxMs} ms, gc ${row.gcMs} ms over ${row.gcCount} collection(s), cache ${row.chunkCache} chunk(s) + ${row.ringCache} cached cluster ring(s), ${row.residentKB}/${row.byteBudgetKB} KB resident, deferred ${row.deferred}`)
    const line = { beforeMs: row.spinMsBefore, afterMs: row.spinMsAfter, bestMs: row.spinMsBest, slowdown: row.contentionSlowdown, contested: row.contested }
    console.log(`[ring-scale] ${row.n} cluster(s)${row.moving ? ' moving' : ''}: ${formatContention(line)}`)
    if (perRebuild.length) console.log(`[ring-scale] per rebuild at ${n}: ${perRebuild.join(' | ')}`)
    return row
  }

  let runShapeBuilds = 0
  let runShapeReuses = 0
  const rows = []
  async function sweepArm(ctx, n, moving) {
    const row = await sweep(ctx, n, moving)
    row.attempts = 1
    row.contentionSamples = [row.contentionSlowdown]
    if (row.contested) console.log(`[ring-scale] ${n}${moving ? ' moving' : ''} arm shared the box (x${row.contentionSlowdown} of ${row.spinMsBest} ms): it is still measured once, because every budget verdict is CPU time over a counted unit and a second sweep would only raise the ring's pooled-body high-water mark`)
    return row
  }
  for (const n of CENTER_COUNTS) rows.push(await sweepArm(settledWorld, n, false))
  const settledPeak = settledWorld.physics.physicsStats()
  console.log(`[ring-scale] settled ladder on its own world: ${settledPeak.bodies} body(s) resident, peak ${settledPeak.peakBodies} of ${settledPeak.maxBodies}`)
  settledWorld.trunk.stop()
  settledWorld.rock.stop()
  settledWorld.server.stop()

  const walkingWorld = await bootWorld('walking ring', 'walking')
  const movingRow = await sweepArm(walkingWorld, MOVING_CENTERS, true)
  const walkingPeak = walkingWorld.physics.physicsStats()
  console.log(`[ring-scale] walking arm on its own world: ${walkingPeak.bodies} body(s) resident, peak ${walkingPeak.peakBodies} of ${walkingPeak.maxBodies}`)
  walkingWorld.trunk.stop()
  walkingWorld.rock.stop()
  walkingWorld.server.stop()
  rows.push(movingRow)

  const worst = rows.find(r => r.n === 192 && !r.moving)
  const mid = rows.find(r => r.n === 128)
  const tickMs = round(1000 / TICK_RATE, 2)
  for (const r of rows) if (r.slowSlices && r.slowSlices.length) console.log(`[ring-scale] ${r.n}${r.moving ? ' moving' : ''} slice(s) over 4 ms: ${r.slowSlices.map(s => `${s.key} ${s.ms} ms wall / ${s.cpuMs} ms cpu x${s.count}`).join(', ')}`)
  console.log('')
  check('no cluster is starved by the shared cap at 128 clusters', mid && mid.starvedClusters === 0 && mid.rockStarvedClusters === 0, `cap-starved ${mid?.starvedClusters}/${mid?.rockStarvedClusters}, clusters with nothing to place ${mid?.emptyClusters}/${mid?.rockEmptyClusters}`)
  check('no cluster is starved by the shared cap at 192 clusters', worst.starvedClusters === 0 && worst.rockStarvedClusters === 0, `cap-starved ${worst.starvedClusters}/${worst.rockStarvedClusters}, clusters with nothing to place ${worst.emptyClusters}/${worst.rockEmptyClusters}`)
  check('no cluster is starved by the shared cap at 192 moving clusters', movingRow.starvedClusters === 0 && movingRow.rockStarvedClusters === 0, `cap-starved ${movingRow.starvedClusters}/${movingRow.rockStarvedClusters}, clusters with nothing to place ${movingRow.emptyClusters}/${movingRow.rockEmptyClusters}`)
  check(`a settled ${mid.n}-cluster ring spends under ${RING_WORK_PER_1K_EXAMINED_MS} ms of uninterrupted work per 1000 placement(s) the ring scan examines`, mid && mid.workPer1kExamined > 0 && mid.workPer1kExamined <= RING_WORK_PER_1K_EXAMINED_MS, `${mid?.workPer1kExamined} ms per 1k examined over ${mid?.examined} placement(s) (${mid?.workMsPerRebuild} ms of uninterrupted work per rebuild)`)
  check(`every one of the last ${LAST_REBUILDS} rebuilds of a settled ring skips the rescan at 192 clusters`, worst.lastSkips === 2 * LAST_REBUILDS, `${worst.lastSkips} of ${2 * LAST_REBUILDS} settled rebuild(s) skipped, ${worst.workMsPerS} ms/s of work`)
  check(`no rebuild of a walking ring skips the rescan at 192 moving clusters`, movingRow.lastSkips === 0, `${movingRow.lastSkips} of ${2 * LAST_REBUILDS} rebuild(s) skipped`)
  check('a collider ring rebuilds only a handful of Jolt shapes while re-adding thousands of bodies', runShapeBuilds > 0 && runShapeReuses > runShapeBuilds * 3, `${runShapeReuses} reuse(s) vs ${runShapeBuilds} build(s) over the whole run`)
  console.log(`[ring-scale] CPU per second of wall time (informational, its denominator is wall time and its numerator is the whole window, so a shared box moves it): ${rows.map(r => `${r.n}${r.moving ? 'm' : ''} ${r.cpuMsPerS} ms/s over ${r.cpuPer1kExamined} ms of window CPU per 1k examined`).join(', ')}; the gates below are milliseconds of uninterrupted work inside the ring's own slices per 1000 examined placement(s), because process.cpuUsage() on Windows quantizes to ${CPU_QUANTUM_MS} ms and cannot resolve slices this small`)

  check('every arm records a host contention fingerprint, so no ms figure from this run is quoted blind', rows.length > 0 && rows.every(r => Number.isFinite(r.spinMsBefore) && r.spinMsBefore > 0 && r.contentionSlowdown >= 1), rows.map(r => `${r.n}${r.moving ? 'm' : ''}:x${r.contentionSlowdown}`).join(' '))
  const uncounted = rows.filter(r => !(r.rebuilds > 0) || !(r.examined > 0))
  check(`every arm's CPU figure rests on a counted denominator, so no budget verdict above is a ratio over zero rebuild or zero examined placement(s)`, uncounted.length === 0, uncounted.map(r => `${r.n}${r.moving ? ' moving' : ''} examined ${r.examined} placement(s) over ${r.rebuilds} rebuild(s)`).join('; '))
  check(`a walking ring's add/evict path is exercised, so the eviction and body-add work the ring is budgeted for really ran`, movingRow.ringOps > 0, `the ${movingRow.n} moving arm counted ${movingRow.ringOps} body add/evict operation(s) (settled arms counted ${rows.filter(r => !r.moving).map(r => r.ringOps).join('/')}, a settled ring has nothing to add or evict)`)
  check(`a settled 192-cluster ring spends under ${RING_WORK_PER_1K_EXAMINED_MS} ms of uninterrupted work per 1000 placement(s) the ring scan examines`, worst.workPer1kExamined > 0 && worst.workPer1kExamined <= RING_WORK_PER_1K_EXAMINED_MS, `${worst.workPer1kExamined} ms per 1k examined over ${worst.examined} placement(s) (${worst.workMsPerRebuild} ms of uninterrupted work per rebuild, ${worst.cpuPer1kExamined} ms of window CPU per 1k)`)
  check(`a walking 192-cluster ring spends under ${RING_WORK_PER_1K_EXAMINED_MS} ms of uninterrupted work per 1000 placement(s) the ring scan examines`, movingRow.workPer1kExamined > 0 && movingRow.workPer1kExamined <= RING_WORK_PER_1K_EXAMINED_MS, `${movingRow.workPer1kExamined} ms per 1k examined over ${movingRow.examined} placement(s) (${movingRow.workMsPerRebuild} ms of uninterrupted work per rebuild, ${movingRow.cpuPer1kExamined} ms of window CPU per 1k)`)
  check(`the counted examined-placement denominator grows with the cluster count, so it tracks the workload rather than sitting at a constant`, worst.examined > mid.examined && mid.examined > 0, `${mid.n} cluster(s) examined ${mid.examined} placement(s), ${worst.n} settled examined ${worst.examined}, ${movingRow.n} moving examined ${movingRow.examined}`)
  check(`a settled 192-cluster ring scans at least ${SETTLED_SCAN_RATIO}x fewer placement(s) per rebuild than a walking one with the same cluster count, so a settled ring really is skipping the rescan`, worst.examinedPerRebuild > 0 && movingRow.examinedPerRebuild >= worst.examinedPerRebuild * SETTLED_SCAN_RATIO, `settled ${worst.examinedPerRebuild} placement(s) per rebuild vs walking ${movingRow.examinedPerRebuild} (${worst.lastSkips} of ${2 * LAST_REBUILDS} settled rebuild(s) skipped)`)
  check(`a walking ring rebuild yields to the loop at least once per tick of its own work at 192 clusters (average uninterrupted slice inside ${tickMs} ms)`, movingRow.workMsPerRebuild > 0 && movingRow.yieldsPerRebuild > 0 && movingRow.workMsPerRebuild <= tickMs * movingRow.yieldsPerRebuild, `${movingRow.workMsPerRebuild} ms of uninterrupted work per rebuild over ${movingRow.yieldsPerRebuild} yield(s) = ${round(movingRow.workMsPerRebuild / movingRow.yieldsPerRebuild, 2)} ms per slice; longest ${movingRow.maxSliceMs} ms wall / ${movingRow.maxSliceCpuMs} ms cpu in ${movingRow.maxSlicePhase}/${movingRow.maxSliceCpuPhase}`)
  check('colliders stay inside their byte budget at 192 clusters', worst.residentKB <= worst.byteBudgetKB, `${worst.residentKB}/${worst.byteBudgetKB} KB`)
  check('the cluster cap is not silently dropping clusters it serves', worst.droppedClusters === 0, `dropped ${worst.droppedClusters}`)

  const stillContested = rows.filter(r => r.contested)
  if (stillContested.length) console.log(`[ring-scale] ${stillContested.length} of ${rows.length} arm(s) never got a clean window (${stillContested.map(r => `${r.n}${r.moving ? ' moving' : ''} x${r.contentionSlowdown} of ${r.spinMsBest} ms over ${r.attempts} attempt(s)`).join(', ')}): every budget verdict above is uninterrupted work over a counted unit, so a shared window moves the wall figures only`)


  check(`a settled ladder of ${CENTER_COUNTS.join('/')} clusters keeps one full world inside its Jolt body limit of ${WORLD_BODY_LIMIT}`, settledPeak.peakBodies != null && settledPeak.peakBodies < WORLD_BODY_LIMIT, `${settledPeak.bodies} resident, ${settledPeak.peakBodies} peak of ${settledPeak.maxBodies} on the settled world`)
  check(`a walking ${MOVING_CENTERS}-cluster ring keeps one full world inside its Jolt body limit of ${WORLD_BODY_LIMIT}`, walkingPeak.peakBodies != null && walkingPeak.peakBodies < WORLD_BODY_LIMIT, `${walkingPeak.bodies} resident, ${walkingPeak.peakBodies} peak of ${walkingPeak.maxBodies} on the walking world`)

  console.log(`\n[ring-scale] ${PASS.length} passed, ${FAIL.length} failed`)
  console.log(`[ring-scale] RESULT: ${FAIL.length ? 'FAIL' : 'PASS'}`)
  console.log(`[ring-scale] ROWS: ${JSON.stringify(rows)}`)
  process.exitCode = FAIL.length ? 1 : 0
}

main().catch(e => {
  console.error('[ring-scale] RESULT: FAIL (uncaught)')
  console.error(e?.stack || e)
  process.exit(1)
})
