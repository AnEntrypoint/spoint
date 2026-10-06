process.env.SPOINT_NO_WATCH = '1'
process.env.SPOINT_SKIP_PREWARM = '1'

import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const href = p => pathToFileURL(p).href
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true'] }))
const PLAYERS = Number(args.players ?? 64)
const SEPARATION = Number(args.separation ?? 1000)
const DRAIN_MS = 16
const CAP_OVERRIDE = args.cap ? Number(args.cap) : null
const MAXCENTERS_OVERRIDE = args.maxCenters ? Number(args.maxCenters) : null

const BASELINE = {
  16: { maxFirstMs: 3734, live: 768, hash: '77096680' },
  64: { maxFirstMs: 7276, live: 1594, hash: 'd9cf02ca' },
}
const PIN = BASELINE[PLAYERS]

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` -- ${detail}` : ''}`)
}

const { loadWorldModule } = await import(href(resolve(ROOT, 'src/sdk/WorldLocator.js')))
const { PhysicsWorld } = await import(href(resolve(ROOT, 'src/physics/World.js')))
const { planetSamplerOptsOf, loadPlanetSampler } = await import(href(resolve(ROOT, 'src/terrain/TerrainPhysics.js')))
const { createPlanetFrame } = await import(href(resolve(ROOT, 'src/terrain/PlanetFrame.js')))
const { createCachedAnchorField } = await import(href(resolve(ROOT, 'src/terrain/ClimateCache.js')))
const { createTrunkColliderStreamer } = await import(href(resolve(ROOT, 'src/terrain/VegPhysics.js')))
const { createRockColliderStreamer } = await import(href(resolve(ROOT, 'src/terrain/RockPhysics.js')))

const loaded = await loadWorldModule(resolve(ROOT, 'apps/world/tps-game.js'))
const tcfg = loaded.terrain
const sampler = await loadPlanetSampler(planetSamplerOptsOf(tcfg))
const frame = createPlanetFrame({ sampler, anchorDir: tcfg.anchorDir || [0, 1, 0], offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
const anchorField = createCachedAnchorField(sampler.anchorField, frame)

const side = Math.ceil(Math.sqrt(PLAYERS))
const players = []
for (let i = 0; i < PLAYERS; i++) {
  const gx = i % side, gz = (i / side) | 0
  players.push([(gx - (side - 1) / 2) * SEPARATION, (gz - (side - 1) / 2) * SEPARATION])
}
const getCenters = () => players

const vcfg = tcfg.vegetation || {}
const TRUNK_RADIUS = vcfg.colliderRadius || 64
const ROCK_RADIUS = vcfg.rockColliderRadius || 32

function hashOf(streamer, physics) {
  const keys = []
  for (const id of streamer._live.values()) {
    if (typeof id !== 'number' || id < 0) continue
    const p = physics.getBodyPosition(id)
    if (p) keys.push(`${p[0].toFixed(3)},${p[2].toFixed(3)}`)
  }
  keys.sort()
  let h = 2166136261
  for (const k of keys) for (let i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0).toString(16)
}
function positionsOf(streamer, physics) {
  const out = []
  for (const id of streamer._live.values()) {
    if (typeof id !== 'number' || id < 0) continue
    const p = physics.getBodyPosition(id)
    if (p) out.push([p[0], p[2]])
  }
  return out
}
function perPlayerCount(pos, radius) {
  const r2 = radius * radius
  return players.map(([x, z]) => pos.reduce((n, [bx, bz]) => n + ((bx - x) ** 2 + (bz - z) ** 2 <= r2 ? 1 : 0), 0))
}
function perPlayerFirst(adds, tag, radius) {
  const r2 = radius * radius
  const out = new Array(players.length).fill(null)
  for (const a of adds) {
    if (a.tag !== tag) continue
    for (let i = 0; i < players.length; i++) {
      if (out[i] !== null) continue
      const dx = a.x - players[i][0], dz = a.z - players[i][1]
      if (dx * dx + dz * dz <= r2) out[i] = a.t
    }
  }
  return out
}
const stat = arr => {
  const v = arr.filter(x => x !== null).slice().sort((a, b) => a - b)
  if (!v.length) return { n: 0, max: null }
  return { n: v.length, min: +v[0].toFixed(1), median: +v[v.length >> 1].toFixed(1), max: +v[v.length - 1].toFixed(1) }
}

async function bootArm(arm) {
  const realLog = console.log, realWarn = console.warn
  const logs = [], warns = []
  console.log = (...a) => logs.push(a.join(' '))
  console.warn = (...a) => warns.push(a.join(' '))

  const physics = new PhysicsWorld({ gravity: [0, -18, 0] })
  await physics.init()

  let t0 = 0
  let activeTag = 'none'
  const adds = []
  let liveBodies = 0, peakBodies = 0
  const realAddBody = physics._addBody.bind(physics)
  physics._addBody = function (shape, position, motionType, layer, opts = {}) {
    const id = realAddBody(shape, position, motionType, layer, opts)
    if (id != null && id >= 0) { liveBodies++; if (liveBodies > peakBodies) peakBodies = liveBodies }
    if (id != null && Array.isArray(position)) adds.push({ tag: activeTag, t: performance.now() - t0, x: position[0], z: position[2] })
    return id
  }
  const realEnqueue = physics.enqueueAdd.bind(physics)
  physics.enqueueAdd = function (shapeType, params, position, motionType, opts, onAdded) {
    const tag = activeTag
    return realEnqueue(shapeType, params, position, motionType, opts, (id) => {
      if (id != null && Array.isArray(position)) adds.push({ tag, t: performance.now() - t0, x: position[0], z: position[2] })
      if (onAdded) onAdded(id)
    })
  }

  const realRemoveBody = typeof physics.removeBody === 'function' ? physics.removeBody.bind(physics) : null
  if (realRemoveBody) physics.removeBody = function (id) { if (id != null && id >= 0) liveBodies--; return realRemoveBody(id) }
  const realEnqueueRemove = typeof physics.enqueueRemove === 'function' ? physics.enqueueRemove.bind(physics) : null
  if (realEnqueueRemove) physics.enqueueRemove = function (id) { if (id != null && id >= 0) liveBodies--; return realEnqueueRemove(id) }

  const trunk = createTrunkColliderStreamer({
    physics, getCenters, frame, anchorField, worldSeed: tcfg.seed | 0, intervalMs: 1e9,
    radius: TRUNK_RADIUS, cap: CAP_OVERRIDE ?? (vcfg.colliderCap || 384), byteBudget: vcfg.colliderByteBudget, maxCenters: MAXCENTERS_OVERRIDE ?? vcfg.colliderMaxCenters,
  })
  const rock = createRockColliderStreamer({
    physics, getCenters, frame, anchorField, worldSeed: tcfg.seed | 0, intervalMs: 1e9,
    radius: ROCK_RADIUS, cap: vcfg.rockColliderCap || 128, byteBudget: vcfg.rockColliderByteBudget, maxCenters: vcfg.colliderMaxCenters,
  })

  const heartbeats = []
  const beat = setInterval(() => heartbeats.push(performance.now()), 16)
  let peakLive = 0
  const sample = setInterval(() => { const s = trunk._live.size; if (s > peakLive) peakLive = s }, 1)
  const drain = setInterval(() => { if (typeof physics.drainBodyQueue === 'function') physics.drainBodyQueue() }, DRAIN_MS)

  const cpu0 = process.cpuUsage()
  t0 = performance.now()
  activeTag = 'trunk'
  if (arm === 'single') await trunk._rebuildMulti(players, true)
  else await trunk.start()
  const trunkDone = performance.now() - t0
  activeTag = 'rock'
  if (arm === 'single') await rock._rebuildMulti(players, true)
  else await rock.start()
  const rockDone = performance.now() - t0
  activeTag = 'none'
  await new Promise(r => setTimeout(r, 400))
  clearInterval(drain)
  clearInterval(sample)
  clearInterval(beat)
  const cpu = process.cpuUsage(cpu0)
  if (typeof physics.drainBodyQueue === 'function') physics.drainBodyQueue()

  let maxStall = heartbeats.length ? heartbeats[0] - t0 : performance.now() - t0
  const gaps = []
  for (let i = 1; i < heartbeats.length; i++) { const g = heartbeats[i] - heartbeats[i - 1]; gaps.push(g); if (g > maxStall) maxStall = g }
  gaps.push(heartbeats.length ? heartbeats[0] - t0 : maxStall)
  gaps.sort((a, b) => b - a)

  const trunkFirst = perPlayerFirst(adds, 'trunk', TRUNK_RADIUS)
  const rockFirst = perPlayerFirst(adds, 'rock', ROCK_RADIUS)
  const anyFirst = players.map((_, i) => {
    const a = trunkFirst[i], b = rockFirst[i]
    if (a === null) return b
    if (b === null) return a
    return Math.min(a, b)
  })
  const trunkPos = positionsOf(trunk, physics)
  const rockPos = positionsOf(rock, physics)

  console.log = realLog
  console.warn = realWarn

  const row = {
    arm, players: PLAYERS,
    trunk: {
      doneAtMs: +trunkDone.toFixed(1), liveCount: trunk.liveCount, cap: trunk.cap,
      workMs: +trunk.workMs.toFixed(1), rebuildCount: trunk.rebuildCount,
      firstColliderMs: stat(trunkFirst), playersWithNone: trunkFirst.filter(x => x === null).length,
      perPlayerCounts: perPlayerCount(trunkPos, TRUNK_RADIUS),
      posHash: hashOf(trunk, physics),
      peakLiveColliders: peakLive,
      peakPhysicsBodies: peakBodies,
      lastMaxSliceMs: +trunk.lastMaxSliceMs.toFixed(1),
      lastMaxSlicePhase: trunk.lastMaxSlicePhase,
    },
    rock: {
      doneAtMs: +rockDone.toFixed(1), liveCount: rock.liveCount, cap: rock.cap,
      workMs: +rock.workMs.toFixed(1),
      firstColliderMs: stat(rockFirst), playersWithNone: rockFirst.filter(x => x === null).length,
      posHash: hashOf(rock, physics),
    },
    anyFirstColliderMs: stat(anyFirst),
    anyPlayersWithNone: anyFirst.filter(x => x === null).length,
    eventLoopMaxStallMs: +maxStall.toFixed(1),
    eventLoopTopStallsMs: gaps.slice(0, 6).map(g => +g.toFixed(1)),
    heartbeatCount: heartbeats.length,
    heartbeatGapsDuringBootMs: heartbeats.filter(t => t - t0 <= trunkDone).length,
    heartbeatFirstAtMs: heartbeats.length ? +(heartbeats[0] - t0).toFixed(1) : null,
    heartbeatLastAtMs: heartbeats.length ? +(heartbeats[heartbeats.length - 1] - t0).toFixed(1) : null,
    processCpuMs: +((cpu.user + cpu.system) / 1000).toFixed(0),
    logLines: logs.filter(s => /initial ring/.test(s)),
    warnLines: warns.slice(0, 3),
  }
  trunk.stop()
  rock.stop()
  physics.dispose?.()
  return row
}

const singleA = await bootArm('single')
const batched = await bootArm('batched')
const singleB = await bootArm('single')

console.log(`[boot-batches] ${PLAYERS} player(s) on a ${SEPARATION} m grid, real tps-game world, real PhysicsWorld, real trunk+rock streamers`)
for (const r of [singleA, batched, singleB]) {
  console.log(`[boot-batches] ${r.arm}: trunk ${r.trunk.liveCount}/${r.trunk.cap} in ${r.trunk.doneAtMs}ms (${r.trunk.workMs}ms of work), rock ${r.rock.liveCount}/${r.rock.cap} in ${r.rock.doneAtMs}ms, first collider min ${r.anyFirstColliderMs.min}/median ${r.anyFirstColliderMs.median}/max ${r.anyFirstColliderMs.max} ms over ${r.anyFirstColliderMs.n} player(s), none ${r.anyPlayersWithNone}, event-loop longest stall ${r.eventLoopMaxStallMs}ms (top ${r.eventLoopTopStallsMs.join('/')}), cpu ${r.processCpuMs}ms`)
  console.log(`[boot-batches] ${r.arm}: trunk hash ${r.trunk.posHash}, rock hash ${r.rock.posHash}, combined live ${r.trunk.liveCount + r.rock.liveCount}`)
  console.log(`[boot-batches] ${r.arm}: peak resident trunk colliders ${r.trunk.peakLiveColliders} of cap ${r.trunk.cap}, peak live physics bodies ${r.trunk.peakPhysicsBodies} (trunk+rock)`)
  console.log(`[boot-batches] ${r.arm}: heartbeat ${r.heartbeatCount} beat(s), ${r.heartbeatGapsDuringBootMs} during the trunk boot, first at ${r.heartbeatFirstAtMs}ms last at ${r.heartbeatLastAtMs}ms`)
}
if (PIN) console.log(`[boot-batches] pinned baseline at ${PLAYERS} player(s): live ${PIN.live}, hash ${PIN.hash}, max first collider ${PIN.maxFirstMs} ms`)

const controlMinMax = Math.min(singleA.anyFirstColliderMs.max, singleB.anyFirstColliderMs.max)
const countsEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])

check('the batched boot builds the same trunk ring as one unbudgeted pass', batched.trunk.posHash === singleA.trunk.posHash && batched.trunk.posHash === singleB.trunk.posHash, `batched ${batched.trunk.posHash} vs single ${singleA.trunk.posHash}/${singleB.trunk.posHash}`)
check('the batched boot builds the same rock ring as one unbudgeted pass', batched.rock.posHash === singleA.rock.posHash && batched.rock.posHash === singleB.rock.posHash, `batched ${batched.rock.posHash} vs single ${singleA.rock.posHash}/${singleB.rock.posHash}`)
check('the batched boot keeps the same trunk live count', batched.trunk.liveCount === singleA.trunk.liveCount && batched.trunk.liveCount === singleB.trunk.liveCount, `batched ${batched.trunk.liveCount} vs single ${singleA.trunk.liveCount}/${singleB.trunk.liveCount}`)
check('the batched boot keeps the same rock live count', batched.rock.liveCount === singleA.rock.liveCount && batched.rock.liveCount === singleB.rock.liveCount, `batched ${batched.rock.liveCount} vs single ${singleA.rock.liveCount}/${singleB.rock.liveCount}`)
check('the batched boot gives every cluster the same per-cluster collider counts', countsEqual(batched.trunk.perPlayerCounts, singleA.trunk.perPlayerCounts) && countsEqual(batched.trunk.perPlayerCounts, singleB.trunk.perPlayerCounts), `min ${Math.min(...batched.trunk.perPlayerCounts)} max ${Math.max(...batched.trunk.perPlayerCounts)}`)
const controlMedian = Math.max(singleA.anyFirstColliderMs.median, singleB.anyFirstColliderMs.median)
const controlMeanMax = (singleA.anyFirstColliderMs.max + singleB.anyFirstColliderMs.max) / 2
const tailCeiling = controlMeanMax * 1.1
check(`the typical player's first collider lands no later than it does today at ${PLAYERS} player(s)`, batched.anyFirstColliderMs.median <= controlMedian, `batched median ${batched.anyFirstColliderMs.median} ms vs single control ${singleA.anyFirstColliderMs.median}/${singleB.anyFirstColliderMs.median} ms`)
check(`the last player's first collider stays within 10% of the single pass at ${PLAYERS} player(s)`, batched.anyFirstColliderMs.max <= tailCeiling, `batched max ${batched.anyFirstColliderMs.max} ms vs single control min ${controlMinMax} / mean ${controlMeanMax.toFixed(1)} / max ${(controlMeanMax * 2 - controlMinMax).toFixed(1)} ms, ceiling ${tailCeiling.toFixed(1)} ms`)
check('the batched boot covers every player that one pass covers', batched.anyPlayersWithNone === singleA.anyPlayersWithNone, `${batched.anyPlayersWithNone} vs ${singleA.anyPlayersWithNone} of ${PLAYERS}`)
const TICK_MS = 1000 / 60
check(`no slice of the batched initial ring blocks the loop for longer than one ${TICK_MS.toFixed(1)} ms tick`, batched.trunk.lastMaxSliceMs <= TICK_MS, `batched longest slice ${batched.trunk.lastMaxSliceMs} ms (${batched.trunk.lastMaxSlicePhase}) vs single ${singleA.trunk.lastMaxSliceMs} ms (${singleA.trunk.lastMaxSlicePhase})/${singleB.trunk.lastMaxSliceMs} ms (${singleB.trunk.lastMaxSlicePhase})`)
check('a batched boot never holds more resident colliders than the body cap between batches', batched.trunk.peakLiveColliders <= batched.trunk.cap, `peak ${batched.trunk.peakLiveColliders} of cap ${batched.trunk.cap}, single ${singleA.trunk.peakLiveColliders}/${singleB.trunk.peakLiveColliders}`)
const controlMin = Math.min(singleA.eventLoopMaxStallMs, singleB.eventLoopMaxStallMs)
const controlMaxStall = Math.max(singleA.eventLoopMaxStallMs, singleB.eventLoopMaxStallMs)
const controlSpread = controlMaxStall - controlMin
check('a batched boot never lengthens the event-loop stall of the initial ring', batched.eventLoopMaxStallMs <= controlMaxStall, `batched ${batched.eventLoopMaxStallMs} ms vs single ${singleA.eventLoopMaxStallMs}/${singleB.eventLoopMaxStallMs} ms`)
if (!CAP_OVERRIDE && !MAXCENTERS_OVERRIDE) {
  check(`the batched boot cuts the event-loop stall of the initial ring at ${PLAYERS} player(s)`, batched.eventLoopMaxStallMs < controlMin, `batched ${batched.eventLoopMaxStallMs} ms vs single ${singleA.eventLoopMaxStallMs}/${singleB.eventLoopMaxStallMs} ms`)
} else {
  console.log(`  [n/a] stall win is claimed only at a pinned player count -- probe config spread ${controlSpread.toFixed(1)} ms, batched ${batched.eventLoopMaxStallMs} ms vs single ${controlMin.toFixed(1)}/${controlMaxStall.toFixed(1)} ms`)
}
if (PIN && !CAP_OVERRIDE && !MAXCENTERS_OVERRIDE) {
  check(`the initial ring still reproduces the pinned ${PLAYERS}-player baseline`, batched.trunk.liveCount === PIN.live && batched.trunk.posHash === PIN.hash, `trunk live ${batched.trunk.liveCount} of ${PIN.live}, trunk hash ${batched.trunk.posHash} of ${PIN.hash}`)
}

console.log(`[boot-batches] ${failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures})`}`)
console.log(`[boot-batches] ROWS: ${JSON.stringify([singleA, batched, singleB])}`)
process.exit(failures === 0 ? 0 : 1)
