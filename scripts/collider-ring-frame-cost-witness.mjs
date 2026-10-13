import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { createServer as createNetServer } from 'node:net'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createServer as createSpointServer } from '../src/sdk/server.js'
import { loadWorldModule } from '../src/sdk/WorldLocator.js'
import { resolveTerrainConfig } from '../src/shared/terrainConfig.js'
import { loadPlanetSampler, planetSamplerOptsOf } from '../src/terrain/TerrainPhysics.js'
import { createPlanetFrame } from '../src/terrain/PlanetFrame.js'
import { createCachedAnchorField } from '../src/terrain/ClimateCache.js'
import { contentionWatch, contentionVerdict, formatContention } from './lib/host-contention.mjs'
import { counterSpan } from './lib/counted-work.mjs'

const SDK_ROOT = resolve(process.argv[2] || process.cwd())
const WORK_DIR = resolve(SDK_ROOT, 'data', 'collider-ring-frame-cost-witness')
const TICK_RATE = 64
const FRAME_MS = 1000 / TICK_RATE
const FRAME_BUDGET_MS = 15.625
const FRAMES = 512
const WALK_SPEED_MPS = 7
const CENTER_SPACING_M = 60
// The ring's own uninterrupted slice budgets are COMPUTE_BUDGET_MS 8 for new chunk placement and
// CLASSIFY_BUDGET_MS / ADD_BUDGET_MS 2. A slice fits a frame; nothing in the ring bounds how many
// slices run inside one frame, which is what this witness measures.
const RING_MS_PER_FRAME_MEAN = 3
// The ring budgets each uninterrupted slice (COMPUTE_BUDGET_MS 8 for new chunk placement,
// CLASSIFY_BUDGET_MS / ADD_BUDGET_MS 2) but nothing bounds how many slices land in one frame, so
// the worst-case burst a frame can carry is one frame plus one full compute slice.
const COMPUTE_BUDGET_MS = 8
const BURST_BUDGET_MS = FRAME_BUDGET_MS + COMPUTE_BUDGET_MS
const GRADE_STEP_M = 32
const GRADE_STEPS = 12
// The grading pin. Two independent rings driven through the same deterministic centre sequence
// must elect these rings and evict in this order; a change to classifyRings, gatherDesired, the
// quota or the farthest-first eviction sort moves one of these and reds the witness. The two-replay
// check below is the diagnostic that separates "grading changed" from "grading became
// nondeterministic": if the replays disagree with each other, the pin is not the thing that broke.
const GRADE_PIN = { elected: 2950386805, order: 2229741571, electedCount: 390, removed: 1382 }
const FNV_PRIME = 16777619

const DIRS = [
  [1, 0], [0, 1], [-1, 0], [0, -1],
  [0.7071067811865476, 0.7071067811865476],
  [-0.7071067811865476, 0.7071067811865476],
  [0.7071067811865476, -0.7071067811865476],
  [-0.7071067811865476, -0.7071067811865476],
]

const PASS = []
const FAIL = []
function check(label, cond, detail) {
  if (cond) { PASS.push(label); console.log(`  [PASS] ${label}`) }
  else { FAIL.push(label); console.log(`  [FAIL] ${label}${detail ? ' -- ' + detail : ''}`) }
}
const sleep = (ms) => new Promise(r => setTimeout(r, Math.max(0, ms)))
const round = (v, n = 2) => Math.round(v * 10 ** n) / 10 ** n

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

// A pure function of the step index, so two replays see byte-identical centres and a differing
// grade can only come from the ring.
function walkCentres(base, frame) {
  const metres = WALK_SPEED_MPS * (frame * FRAME_MS) / 1000
  return base.map(([x, z], i) => {
    const d = DIRS[i % DIRS.length]
    return [x + d[0] * metres, z + d[1] * metres]
  })
}
function gradeCentres(base, step) {
  const metres = step * GRADE_STEP_M
  return base.map(([x, z], i) => {
    const d = DIRS[i % DIRS.length]
    return [x + d[0] * metres, z + d[1] * metres]
  })
}

function fnv(parts) {
  let h = 2166136261
  for (const p of parts) {
    if (typeof p === 'number') { h = Math.imul(h ^ (p >>> 0), FNV_PRIME) >>> 0 }
    else for (let i = 0; i < p.length; i++) h = Math.imul(h ^ p.charCodeAt(i), FNV_PRIME) >>> 0
  }
  return h >>> 0
}

function dist(xs) {
  const s = [...xs].sort((a, b) => a - b)
  if (s.length === 0) return { n: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 }
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  let sum = 0
  for (const v of s) sum += v
  return { n: s.length, p50: round(q(0.5)), p95: round(q(0.95)), p99: round(q(0.99)), max: round(s[s.length - 1]), mean: round(sum / s.length) }
}

// Every body the ring removes passes through live.delete(placementId), so wrapping the exported
// live Map records which rings were elected and in what order they were evicted, with no change to
// ColliderStreamer.js.
function watchGrade(streamer) {
  const live = streamer._live
  const removed = []
  const realDelete = live.delete.bind(live)
  live.delete = (k) => { removed.push(k); return realDelete(k) }
  return {
    removed,
    elected() { return fnv([...live.keys()].sort((a, b) => a - b)) },
    count() { return live.size },
  }
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

  const port = await freePort()
  const server = await createSpointServer({
    port, tickRate: TICK_RATE,
    appsDirs: [resolve(SDK_ROOT, 'apps'), resolve(SDK_ROOT, 'src/stdlib-apps')],
    sdkRoot: SDK_ROOT, gravity: worldDef.gravity, staticDirs: [],
    storageDir: resolve(WORK_DIR, 'data', 'walk'),
  })
  await server.loadWorld(worldDef)
  await server.start()
  const physics = server.physics
  console.log(`[ring-frame] world up on ${port} at ${TICK_RATE} Hz, frame ${round(FRAME_MS, 3)} ms, walk ${WALK_SPEED_MPS} m/s`)

  function makeStreamers(state, cap) {
    const getCenters = () => state.centers
    const trunk = createTrunkColliderStreamer({
      physics, getCenters, frame, anchorField, worldSeed: tcfg.seed | 0,
      radius: vcfg.colliderRadius || 64, cap: cap ?? (vcfg.colliderCap || 384), maxCenters: vcfg.colliderMaxCenters,
    })
    const rock = createRockColliderStreamer({
      physics, getCenters, frame, anchorField, worldSeed: tcfg.seed | 0,
      radius: vcfg.rockColliderRadius || 32, cap: cap === null || cap === undefined ? (vcfg.rockColliderCap || 128) : Math.round(cap / 2), maxCenters: vcfg.colliderMaxCenters,
    })
    return { trunk, rock, state }
  }

  async function walkArm({ players, moving, cap, tag }) {
    const base = lattice(players)
    const state = { centers: moving ? walkCentres(base, 0) : base }
    const ctx = makeStreamers(state, cap)
    const { trunk, rock } = ctx
    const bootT0 = performance.now()
    await trunk.start()
    await rock.start()
    const bootMs = performance.now() - bootT0
    const gradeT = watchGrade(trunk)
    const gradeR = watchGrade(rock)

    const watch = contentionWatch()
    const loop = monitorEventLoopDelay({ resolution: 10 })
    loop.enable()
    const c0 = { ...trunk.ringCounters }
    const k0 = { ...rock.ringCounters }
    const m0 = { work: trunk.workMs + rock.workMs, rebuilds: trunk.rebuildCount + rock.rebuildCount, examined: trunk.examined + rock.examined, chunks: trunk.newChunks + rock.newChunks }
    const frameWall = []
    const ringWork = []
    let prevWork = m0.work
    let windowMaxSliceMs = 0
    const tick0 = server.tickSystem?.currentTick ?? 0
    const wT0 = performance.now()
    for (let f = 0; f < FRAMES; f++) {
      const t0 = performance.now()
      if (moving) state.centers = walkCentres(base, f)
      const rest = FRAME_MS - (performance.now() - t0)
      await sleep(rest)
      frameWall.push(performance.now() - t0)
      const w = trunk.workMs + rock.workMs
      ringWork.push(w - prevWork)
      prevWork = w
      // lastMaxSliceMs is reset at the top of every rebuild, so sampling it at a frame boundary
      // and keeping the largest reading bounds the longest uninterrupted slice of THIS window, not
      // of the boot that filled the ring.
      windowMaxSliceMs = Math.max(windowMaxSliceMs, trunk.lastMaxSliceMs, rock.lastMaxSliceMs)
    }
    const elapsedS = (performance.now() - wT0) / 1000
    loop.disable()
    const dT = counterSpan(c0, trunk.ringCounters)
    const dK = counterSpan(k0, rock.ringCounters)
    const row = {
      tag, players, moving, tightCap: cap ?? null,
      bootMs: round(bootMs, 1), frames: frameWall.length, elapsedS: round(elapsedS, 1),
      ticks: (server.tickSystem?.currentTick ?? 0) - tick0,
      frame: dist(frameWall), ringWork: dist(ringWork),
      loopP50Ms: round(loop.percentile(50) / 1e6, 2), loopP95Ms: round(loop.percentile(95) / 1e6, 2), loopP99Ms: round(loop.percentile(99) / 1e6, 2), loopMaxMs: round(loop.max / 1e6, 2),
      ringMsPerFrame: round((trunk.workMs + rock.workMs - m0.work) / frameWall.length, 3),
      rebuilds: (trunk.rebuildCount + rock.rebuildCount) - m0.rebuilds,
      examined: (trunk.examined + rock.examined) - m0.examined,
      newChunks: (trunk.newChunks + rock.newChunks) - m0.chunks,
      settledSkips: trunk.settledSkips + rock.settledSkips,
      evictScanned: dT.evictScanned + dK.evictScanned, evicted: dT.evicted + dK.evicted,
      bodyAdds: dT.bodyAdds + dK.bodyAdds, bodyRemoves: dT.bodyRemoves + dK.bodyRemoves,
      maxSliceMs: round(Math.max(trunk.lastMaxSliceMs, rock.lastMaxSliceMs), 2),
      maxSlicePhase: trunk.lastMaxSliceMs >= rock.lastMaxSliceMs ? trunk.lastMaxSlicePhase : rock.lastMaxSlicePhase,
      windowMaxSliceMs: round(windowMaxSliceMs, 2),
      windowMaxSlicePhase: trunk.lastMaxSliceMs >= rock.lastMaxSliceMs ? trunk.lastMaxSlicePhase : rock.lastMaxSlicePhase,
      live: trunk.liveCount + rock.liveCount, cap: trunk.cap + rock.cap,
      dropped: trunk.droppedCenters + rock.droppedCenters, starved: trunk.starvedClusters.length + rock.starvedClusters.length,
      elected: (gradeT.elected() ^ gradeR.elected()) >>> 0,
      electedCount: gradeT.count() + gradeR.count(),
      removed: gradeT.removed.length + gradeR.removed.length,
      contention: contentionVerdict(watch),
    }
    console.log(`[ring-frame] ${tag}: boot ${row.bootMs} ms, ${row.frames} frame(s) over ${row.elapsedS} s (${row.ticks} tick(s)), ${row.live}/${row.cap} resident -- ring work ${row.ringMsPerFrame} ms/frame mean (p95 ${row.ringWork.p95} p99 ${row.ringWork.p99} max ${row.ringWork.max}), frame wall p50 ${row.frame.p50} p95 ${row.frame.p95} p99 ${row.frame.p99} max ${row.frame.max} ms, event-loop delay p50 ${row.loopP50Ms} p95 ${row.loopP95Ms} p99 ${row.loopP99Ms} max ${row.loopMaxMs} ms, ${row.rebuilds} rebuild(s) (${row.settledSkips} settled skip(s)), ${row.examined} examined, ${row.newChunks} new chunk(s), evict scan ${row.evictScanned} / evicted ${row.evicted} / adds ${row.bodyAdds} / removes ${row.bodyRemoves}, longest slice ${row.windowMaxSliceMs} ms (${row.windowMaxSlicePhase})`)
    console.log(`[ring-frame] ${tag}: ${formatContention(row.contention)}`)
    trunk.stop()
    rock.stop()
    return row
  }

  // The grading pin: the same deterministic centre sequence driven through two independent ring
  // instances with the body queue drained, so nothing about arrival timing can move the grade.
  async function gradeArm(players, tag) {
    const base = lattice(players)
    const state = { centers: gradeCentres(base, 0) }
    const { trunk, rock } = makeStreamers(state, null)
    const gradeT = watchGrade(trunk)
    const gradeR = watchGrade(rock)
    await trunk._rebuildMulti(state.centers, true)
    await rock._rebuildMulti(state.centers, true)
    if (typeof physics.drainBodyQueue === 'function') physics.drainBodyQueue()
    for (let s = 1; s <= GRADE_STEPS; s++) {
      state.centers = gradeCentres(base, s)
      await trunk._rebuildMulti(state.centers, true)
      await rock._rebuildMulti(state.centers, true)
      if (typeof physics.drainBodyQueue === 'function') physics.drainBodyQueue()
    }
    const row = {
      tag, players,
      elected: (gradeT.elected() ^ gradeR.elected()) >>> 0,
      electedCount: gradeT.count() + gradeR.count(),
      removed: gradeT.removed.length + gradeR.removed.length,
      order: fnv([...gradeT.removed, ...gradeR.removed]),
      rebuilds: trunk.rebuildCount + rock.rebuildCount,
      examined: trunk.examined + rock.examined,
      evicted: trunk.ringCounters.evicted + rock.ringCounters.evicted,
    }
    console.log(`[ring-frame] ${tag}: ${row.rebuilds} rebuild(s) over ${GRADE_STEPS} step(s) of ${GRADE_STEP_M} m, ${row.examined} examined, elected ${row.electedCount} ring(s) fingerprint ${row.elected}, evicted ${row.evicted} in order fingerprint ${row.order} over ${row.removed} removal(s)`)
    trunk.stop()
    rock.stop()
    return row
  }

  const realistic = 8
  const worstCase = 48
  const rows = []
  rows.push(await walkArm({ players: realistic, moving: true, cap: null, tag: `${realistic} walking, shipped cap` }))
  rows.push(await walkArm({ players: realistic, moving: false, cap: null, tag: `${realistic} settled, shipped cap` }))
  rows.push(await walkArm({ players: realistic, moving: true, cap: 64, tag: `${realistic} walking, tight cap 64` }))
  rows.push(await walkArm({ players: worstCase, moving: true, cap: null, tag: `${worstCase} walking, shipped cap` }))
  rows.push(await walkArm({ players: worstCase, moving: false, cap: null, tag: `${worstCase} settled, shipped cap` }))

  const gradeA = await gradeArm(realistic, `grade ${realistic}a`)
  const gradeB = await gradeArm(realistic, `grade ${realistic}b`)
  server.stop()

  const walk8 = rows.find(r => r.tag === `${realistic} walking, shipped cap`)
  const rest8 = rows.find(r => r.tag === `${realistic} settled, shipped cap`)
  const tight8 = rows.find(r => r.tag === `${realistic} walking, tight cap 64`)
  const walk48 = rows.find(r => r.tag === `${worstCase} walking, shipped cap`)
  const rest48 = rows.find(r => r.tag === `${worstCase} settled, shipped cap`)

  console.log(`[ring-frame] A/B: ${realistic} player(s) frame wall max ${walk8.frame.max} ms walking vs ${rest8.frame.max} ms settled (p99 ${walk8.frame.p99} vs ${rest8.frame.p99}); ring work max ${walk8.ringWork.max} ms vs ${rest8.ringWork.max} ms`)
  console.log(`[ring-frame] A/B: ${worstCase} player(s) frame wall max ${walk48.frame.max} ms walking vs ${rest48.frame.max} ms settled (p99 ${walk48.frame.p99} vs ${rest48.frame.p99}); ring work max ${walk48.ringWork.max} ms vs ${rest48.ringWork.max} ms`)

  check(`the ring elects the same rings twice from the same centres, so grading is a function of the centres and not of arrival order`, gradeA.elected === gradeB.elected && gradeA.electedCount === gradeB.electedCount, `elected ${gradeA.elected} (${gradeA.electedCount}) vs ${gradeB.elected} (${gradeB.electedCount})`)
  check(`the ring evicts in the same order twice, so the farthest-first order is reproducible`, gradeA.order === gradeB.order && gradeA.removed === gradeB.removed, `order ${gradeA.order} over ${gradeA.removed} removal(s) vs ${gradeB.order} over ${gradeB.removed}`)
  check(`the grading pin's own counters moved, so the two grades above are not both empty`, gradeA.rebuilds > 0 && gradeA.examined > 0 && gradeA.electedCount > 0 && gradeA.removed > 0, `${gradeA.rebuilds} rebuild(s), ${gradeA.examined} examined, ${gradeA.electedCount} elected, ${gradeA.removed} removed`)
  check(`the pinned grade still holds: ${GRADE_STEPS} step(s) of ${GRADE_STEP_M} m at ${realistic} player(s) elect ${GRADE_PIN.electedCount} ring(s) fingerprint ${GRADE_PIN.elected} and evict in order ${GRADE_PIN.order} over ${GRADE_PIN.removed} removal(s), so no grading change has landed unnoticed`, gradeA.elected === GRADE_PIN.elected && gradeA.order === GRADE_PIN.order && gradeA.electedCount === GRADE_PIN.electedCount && gradeA.removed === GRADE_PIN.removed, `elected ${gradeA.elected} (${gradeA.electedCount}) vs pinned ${GRADE_PIN.elected} (${GRADE_PIN.electedCount}), order ${gradeA.order} over ${gradeA.removed} vs pinned ${GRADE_PIN.order} over ${GRADE_PIN.removed}`)

  for (const r of rows.filter(x => x.moving)) {
    check(`${r.tag}: every counted work unit moved, so no figure above is a ratio over zero`, r.frames > 0 && r.rebuilds > 0 && r.examined > 0 && r.bodyAdds > 0 && r.bodyRemoves > 0, `frames ${r.frames} rebuilds ${r.rebuilds} examined ${r.examined} adds ${r.bodyAdds} removes ${r.bodyRemoves}`)
  }
  check(`${realistic} player(s) at the shipped cap never reach the eviction path, so its cost there is zero rather than unmeasured`, walk8.evictScanned === 0 && walk8.evicted === 0 && walk8.live < walk8.cap, `${walk8.live}/${walk8.cap} resident, evict scan ${walk8.evictScanned}, evicted ${walk8.evicted}`)
  check(`the eviction path really runs under a tight cap at ${realistic} player(s), so its cost is measured and not assumed`, tight8.evictScanned > 0 && tight8.evicted > 0 && tight8.evictScanned >= tight8.evicted, `evict scan ${tight8.evictScanned}, evicted ${tight8.evicted} of ${tight8.live}/${tight8.cap} resident`)
  check(`the eviction path really runs at ${worstCase} player(s) at the shipped cap`, walk48.evictScanned > 0 && walk48.evicted > 0 && walk48.evictScanned >= walk48.evicted, `evict scan ${walk48.evictScanned}, evicted ${walk48.evicted} of ${walk48.live}/${walk48.cap} resident`)
  check(`a walking ring at ${realistic} player(s) costs under ${RING_MS_PER_FRAME_MEAN} ms of ring work per frame on average`, walk8.ringMsPerFrame > 0 && walk8.ringMsPerFrame <= RING_MS_PER_FRAME_MEAN, `${walk8.ringMsPerFrame} ms/frame mean over ${walk8.frames} frame(s)`)
  check(`no single frame carries more ring work than one ${round(FRAME_BUDGET_MS, 3)} ms frame at ${realistic} player(s)`, walk8.ringWork.max > 0 && walk8.ringWork.max <= FRAME_BUDGET_MS, `worst ring work in a frame ${walk8.ringWork.max} ms (p99 ${walk8.ringWork.p99}), longest uninterrupted slice ${walk8.windowMaxSliceMs} ms in ${walk8.windowMaxSlicePhase}`)
  // The cap-forced arm and the 48-cluster arm are pressure arms, not the shipped configuration, and
  // their worst burst is bounded by a frame plus one full 8 ms chunk-compute slice rather than by a
  // bare frame: the ring's own slice budgets cap a slice, not the number of slices in a frame.
  check(`no single frame carries more ring work than one ${round(FRAME_BUDGET_MS, 3)} ms frame plus one ${COMPUTE_BUDGET_MS} ms compute slice at ${realistic} player(s) under eviction pressure`, tight8.ringWork.max > 0 && tight8.ringWork.max <= BURST_BUDGET_MS, `worst ring work in a frame ${tight8.ringWork.max} ms (p99 ${tight8.ringWork.p99}), longest uninterrupted slice ${tight8.windowMaxSliceMs} ms in ${tight8.windowMaxSlicePhase}`)
  check(`no single frame carries more ring work than one ${round(FRAME_BUDGET_MS, 3)} ms frame plus one ${COMPUTE_BUDGET_MS} ms compute slice at ${worstCase} player(s)`, walk48.ringWork.max > 0 && walk48.ringWork.max <= BURST_BUDGET_MS, `worst ring work in a frame ${walk48.ringWork.max} ms (p99 ${walk48.ringWork.p99}), longest uninterrupted slice ${walk48.windowMaxSliceMs} ms in ${walk48.windowMaxSlicePhase}`)
  check(`every walking arm's mean ring work per frame stays under ${RING_MS_PER_FRAME_MEAN} ms`, rows.filter(r => r.moving).every(r => r.ringMsPerFrame > 0 && r.ringMsPerFrame <= RING_MS_PER_FRAME_MEAN), rows.filter(r => r.moving).map(r => `${r.tag}: ${r.ringMsPerFrame} ms/frame`).join('; '))
  check(`the longest uninterrupted ring slice stays inside one frame at every walking arm`, rows.filter(r => r.moving).every(r => r.windowMaxSliceMs > 0 && r.windowMaxSliceMs <= FRAME_BUDGET_MS), rows.filter(r => r.moving).map(r => `${r.tag}: ${r.windowMaxSliceMs} ms in ${r.windowMaxSlicePhase}`).join('; '))
  // The A/B baseline: a settled ring over the same resident bodies does no rebuild work at all, so
  // every millisecond the walking arm shows above the settled arm is the rebuild's and not the
  // server's. settledSkips is not the evidence -- _check short-circuits on ringMoved before it ever
  // calls _rebuildMulti, so a settled ring increments nothing.
  check(`a settled ring does no rebuild work at all, so the walking arm's cost above is the rebuild's and not the server's`, rest8.rebuilds === 0 && rest8.examined === 0 && rest8.ringWork.max === 0 && rest48.rebuilds === 0 && rest48.examined === 0 && rest48.ringWork.max === 0, `${realistic}: ${rest8.rebuilds} rebuild(s) ${rest8.examined} examined ${rest8.ringWork.max} ms; ${worstCase}: ${rest48.rebuilds} rebuild(s) ${rest48.examined} examined ${rest48.ringWork.max} ms`)
  check(`the ring drops no cluster and starves none at any arm`, rows.every(r => r.dropped === 0 && r.starved === 0), rows.map(r => `${r.tag}: dropped ${r.dropped} starved ${r.starved}`).join('; '))
  check('every arm records a host contention fingerprint, so no ms figure from this run is quoted blind', rows.every(r => Number.isFinite(r.contention.beforeMs) && r.contention.beforeMs > 0 && r.contention.slowdown >= 1), rows.map(r => `${r.tag}:x${r.contention.slowdown}`).join(' '))

  console.log(`\n[ring-frame] ${PASS.length} passed, ${FAIL.length} failed`)
  console.log(`[ring-frame] RESULT: ${FAIL.length ? 'FAIL' : 'PASS'}`)
  process.exitCode = FAIL.length ? 1 : 0
}

main().catch(e => {
  console.error('[ring-frame] RESULT: FAIL (uncaught)')
  console.error(e?.stack || e)
  process.exit(1)
})
