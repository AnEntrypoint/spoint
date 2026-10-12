process.env.SPOINT_NO_WATCH = '1'
process.env.SPOINT_SKIP_PREWARM = '1'

import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { numericFlag } from './lib/witness-args.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const href = p => pathToFileURL(p).href
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true'] }))
const CAP = numericFlag(args, 'cap', 8)
const RADIUS = numericFlag(args, 'radius', 64)
const STEP_M = numericFlag(args, 'step', 30)
const STEPS = numericFlag(args, 'steps', 8)

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

const loaded = await loadWorldModule(resolve(ROOT, 'apps/world/tps-game.js'))
const tcfg = loaded.terrain
const sampler = await loadPlanetSampler(planetSamplerOptsOf(tcfg))
const frame = createPlanetFrame({ sampler, anchorDir: tcfg.anchorDir || [0, 1, 0], offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
const anchorField = createCachedAnchorField(sampler.anchorField, frame)

const physics = new PhysicsWorld({ gravity: [0, -18, 0] })
await physics.init()

const FREE_CAP = numericFlag(args, 'freeCap', Math.max(CAP * 8, 256))

let centre = [0, 0]
const newStreamerAt = (cap, fixedCentre = null) => createTrunkColliderStreamer({
  physics, getCenters: () => (fixedCentre === null ? [centre] : [fixedCentre]), frame, anchorField, worldSeed: tcfg.seed | 0, intervalMs: 1e9,
  radius: RADIUS, cap, maxCenters: 1,
})
const trunk = newStreamerAt(CAP)
const drain = () => { if (typeof physics.drainBodyQueue === 'function') physics.drainBodyQueue() }

const livePositionsOf = streamer => {
  const out = []
  for (const id of streamer._live.values()) {
    if (typeof id !== 'number' || id < 0) continue
    const p = physics.getBodyPosition(id)
    if (p) out.push([p[0], p[2]])
  }
  return out
}

const maxDistFrom = (positions, c) => {
  let m = 0
  for (const [x, z] of positions) {
    const dx = x - c[0], dz = z - c[1]
    const d = Math.sqrt(dx * dx + dz * dz)
    if (d > m) m = d
  }
  return m
}

// A ring that keeps the previous centre's colliders is indistinguishable from a healthy one by
// count alone, so every step is compared against a ring built from scratch AT THAT STEP with the
// same cap. A fresh build takes the nearest placements, so it is bounded by placement density; a
// stale one drags the old centre's set along and spreads past it. The bound is measured per step,
// never a hard-coded keep-radius factor the streamer does not export.
async function freshReference(streamer, c) {
  const ref = newStreamerAt(streamer.cap, [c[0], c[1]])
  try {
    await ref._rebuildMulti([[c[0], c[1]]], true)
    drain()
    return { maxDist: Number(maxDistFrom(livePositionsOf(ref), c).toFixed(2)), live: ref.liveCount }
  } finally {
    ref.stop()
    drain()
  }
}

async function runWalk(streamer) {
  const walked = []
  for (let step = 0; step <= STEPS; step++) {
    centre = [step * STEP_M, 0]
    const before = new Set(streamer._live.keys())
    await streamer._rebuildMulti([centre], true)
    drain()
    const after = new Set(streamer._live.keys())
    let newlyAdded = 0
    for (const id of after) if (!before.has(id)) newlyAdded++
    let retained = 0
    for (const id of after) if (before.has(id)) retained++
    const r2 = RADIUS * RADIUS
    let inRadius = 0
    const seen = livePositionsOf(streamer)
    for (const [x, z] of seen) {
      const dx = x - centre[0], dz = z - centre[1]
      if (dx * dx + dz * dz <= r2) inRadius++
    }
    const maxDist = Number(maxDistFrom(seen, centre).toFixed(2))
    const ref = await freshReference(streamer, centre)
    walked.push({ step, centre: centre[0], live: streamer.liveCount, sampled: seen.length, inRadius, maxDist, refMaxDist: ref.maxDist, refLive: ref.live, newlyAdded, retained, evicted: before.size - retained })
  }
  return walked
}

const steps = await runWalk(trunk)
const free = newStreamerAt(FREE_CAP)
const freeSteps = await runWalk(free)
free.stop()
if (typeof physics.drainBodyQueue === 'function') physics.drainBodyQueue()

const series = s => s.map(x => x.inRadius).join(' ')
const liveSeries = s => s.map(x => x.live).join(' ')
const addedSeries = s => s.map(x => `${x.newlyAdded}/${x.retained}`).join(' ')
const evictedSeries = s => s.map(x => x.evicted).join(' ')
const range = xs => `${Math.min(...xs)}..${Math.max(...xs)}`

const inRadiusSeries = steps.map(s => s.inRadius)
const movingSteps = steps.slice(1)
const freeMoving = freeSteps.slice(1)
const worstInRadius = Math.min(...movingSteps.map(s => s.inRadius))
const worstNewlyAdded = Math.min(...movingSteps.map(s => s.newlyAdded))
const worstEvicted = Math.min(...movingSteps.map(s => s.evicted))
const overCap = steps.filter(s => s.live > trunk.cap)
const noTurnover = movingSteps.filter(s => s.newlyAdded === 0)
const saturatedSteps = steps.filter(s => s.live >= trunk.cap)
const freeSaturated = freeSteps.filter(s => s.live >= free.cap)
const freeWorstInRadius = Math.min(...freeMoving.map(s => s.inRadius))
const freeWorstNewlyAdded = Math.min(...freeMoving.map(s => s.newlyAdded))
const unsampled = steps.concat(freeSteps).filter(s => s.sampled !== s.live)
const distSeries = s => s.map(x => x.maxDist.toFixed(1)).join(' ')
const refSeries = s => s.map(x => x.refMaxDist.toFixed(1)).join(' ')
const stale = steps.concat(freeSteps).filter(s => s.maxDist > s.refMaxDist + STEP_M)

console.log(`[turnover] real tps-game world, real PhysicsWorld, real trunk streamer, radius ${RADIUS} m cap ${trunk.cap}, centre walks ${STEP_M} m per rebuild`)
console.log(`[turnover] in-radius colliders per step: ${inRadiusSeries.join(' ')}`)
console.log(`[turnover] newly added / retained per step: ${steps.map(s => `${s.newlyAdded}/${s.retained}`).join(' ')}`)
console.log(`[turnover] live per step: ${steps.map(s => s.live).join(' ')} (cap ${trunk.cap})`)
console.log(`[turnover] evicted per step: ${steps.map(s => s.evicted).join(' ')}`)
console.log(`[turnover] unsaturated control arm, cap ${free.cap}: live ${liveSeries(freeSteps)}, in radius ${series(freeSteps)}, newly added / retained ${addedSeries(freeSteps)}, evicted ${evictedSeries(freeSteps)}`)

console.log(`[turnover] farthest resident collider from the current centre per step: ${distSeries(steps)} (cap ${trunk.cap}), ${distSeries(freeSteps)} (cap ${free.cap})`)
console.log(`[turnover] farthest collider of a ring built from scratch at that same step: ${refSeries(steps)} (cap ${trunk.cap}), ${refSeries(freeSteps)} (cap ${free.cap}) -- the measured freshness bound, ${STEP_M} m of travel of slack`)
console.log(`[turnover] resident collider(s) sitting past ${RADIUS} m from the centre but inside the streamer's keep radius: ${steps.map(s => s.live - s.inRadius).join(' ')} (cap ${trunk.cap}), ${freeSteps.map(s => s.live - s.inRadius).join(' ')} (cap ${free.cap}) -- hysteresis shell, not a leak`)

check(`every step of a ${STEP_M} m walk keeps colliders inside the ${RADIUS} m radius, not a saturated set from an old centre`, worstInRadius > 0, `worst ${worstInRadius} of cap ${trunk.cap}`)
check('a moving centre actually turns its collider set over instead of keeping the old ones', worstNewlyAdded > 0, `worst newly added ${worstNewlyAdded}`)
check('the live set never stays above the body cap after a rebuild', overCap.length === 0, overCap.length ? `${overCap.length} step(s) over cap, worst ${Math.max(...overCap.map(s => s.live))}` : `max live ${Math.max(...steps.map(s => s.live))} of cap ${trunk.cap}`)
check('no step of the walk rebuilds without adding anything', noTurnover.length === 0, `${noTurnover.length} of ${movingSteps.length} step(s)`)
check('every resident collider of every step had its position read back, so the distance claim rests on a measured position and not on a missing one', unsampled.length === 0, `${unsampled.length} step(s) of ${steps.length + freeSteps.length} read back fewer position(s) than they hold resident`)
check('a ring pinned at cap drops what it adds, so saturation is turnover and not a frozen set', worstEvicted > 0, `worst evicted ${worstEvicted}, series ${steps.map(s => s.evicted).join(' ')}`)
check(`no resident collider sits farther from the centre than a ring built from scratch at that same step does, so a ${STEP_M} m walk drops the old centre's set instead of dragging it along`, stale.length === 0, `capped ${distSeries(steps)} against a fresh ${refSeries(steps)} plus ${STEP_M} m, free ${distSeries(freeSteps)} against a fresh ${refSeries(freeSteps)} plus ${STEP_M} m, ${stale.length} stale step(s)`)
check(`a cap that does not bind still fills short of it, so the ${RADIUS} m radius and not the cap decided membership`, freeSaturated.length === 0, `cap ${free.cap}: live ${liveSeries(freeSteps)}, in radius ${series(freeSteps)}, ${freeSaturated.length} saturated step(s)`)
check('the unsaturated ring turns over under the same walk, so the walk and not the cap drives it', freeWorstNewlyAdded > 0, `worst newly added ${freeWorstNewlyAdded}`)
check('saturation is measured, not assumed: the capped arm is pinned at cap and the free arm is not, so a pinned ring alone cannot certify the radius', saturatedSteps.length > 0 && freeSaturated.length === 0, `capped ${saturatedSteps.length}/${steps.length} step(s) at cap ${trunk.cap}, free ${freeSaturated.length}/${freeSteps.length} at cap ${free.cap}`)
check('the free arm keeps more colliders inside the radius than the capped arm can hold, so the cap and not the radius limits the capped ring', freeWorstInRadius > worstInRadius, `free worst ${freeWorstInRadius} in radius, capped worst ${worstInRadius}`)
console.log(`[turnover] MEASURED collider-turnover: ${steps.length} step(s) of ${STEP_M} m, radius ${RADIUS} m -- capped cap ${trunk.cap} live ${range(steps.map(s => s.live))} in-radius ${range(steps.map(s => s.inRadius))} added ${range(movingSteps.map(s => s.newlyAdded))} evicted ${range(movingSteps.map(s => s.evicted))} saturated ${saturatedSteps.length}/${steps.length}; free cap ${free.cap} live ${range(freeSteps.map(s => s.live))} in-radius ${range(freeSteps.map(s => s.inRadius))} added ${range(freeMoving.map(s => s.newlyAdded))} saturated ${freeSaturated.length}/${freeSteps.length}, stale ${stale.length}/${steps.length + freeSteps.length} step(s)`)

const faulted = createTrunkColliderStreamer({
  physics, getCenters: () => [[0, 0]], frame, anchorField, worldSeed: tcfg.seed | 0, intervalMs: 1e9,
  radius: RADIUS, cap: CAP, maxCenters: 1,
  excludePlacement: () => { throw new Error('injected classify failure') },
})
let faultThrew = false
try {
  await faulted._rebuildMulti([[0, 0]], true)
} catch (e) {
  faultThrew = true
}
const fault = faulted.fault
let faultStartThrew = false
try {
  await faulted.start()
} catch (e) {
  faultStartThrew = true
}
check('a throwing rebuild rejects instead of leaving a partial ring and rescheduling', faultThrew, fault ? `phase ${fault.phase}, ${fault.resident}/${fault.cap} resident` : 'no fault recorded')
check('the fault names the phase that threw and keeps the resident count', fault !== null && typeof fault.phase === 'string' && fault.phase !== 'idle' && Number.isInteger(fault.resident), fault ? JSON.stringify({ phase: fault.phase, resident: fault.resident, cap: fault.cap, centers: fault.centers }) : 'null')
check('the faulted streamer exposes the error itself, not only a log line', fault !== null && fault.error instanceof Error, fault ? String(fault.error?.message) : 'null')
check('booting a faulted streamer fails loudly instead of starting with an empty ring', faultStartThrew, faultStartThrew ? 'start() rejected' : 'start() resolved')
check('a healthy streamer is untouched by the faulted one and still holds its ring', trunk.liveCount > 0 && trunk.fault === null, `live ${trunk.liveCount}, fault ${trunk.fault === null ? 'null' : 'set'}`)

const resident = () => physics.physicsSystem.GetNumBodies()
const newStreamer = () => createTrunkColliderStreamer({
  physics, getCenters: () => [[0, 0]], frame, anchorField, worldSeed: tcfg.seed | 0, intervalMs: 1e9,
  radius: RADIUS, cap: CAP, maxCenters: 1,
})

const cycles = []
for (let i = 0; i < 3; i++) {
  const streamer = newStreamer()
  const before = resident()
  await streamer.start()
  drain()
  const started = resident()
  streamer.stop()
  drain()
  cycles.push({ cycle: i, before, started, stopped: resident() })
}
const cycleTrace = cycles.map(c => `${c.before}->${c.started}->${c.stopped}`).join(' ')
const keptSlots = cycles.filter(c => c.stopped >= c.started)
const grewAcrossCycles = cycles[cycles.length - 1].stopped > cycles[0].before

check('stopping a collider streamer frees its Jolt body slots instead of parking them', keptSlots.length === 0, `resident per cycle before->started->stopped: ${cycleTrace}`)
check('three stop and restart cycles on one physics never grow the resident count, so a retry cannot exhaust maxBodies', !grewAcrossCycles, `${cycles[0].before} before the first cycle, ${cycles[cycles.length - 1].stopped} after the last`)
check('the streamer that ran the walk still holds a full ring and can be stopped without a fault', trunk.fault === null, `live ${trunk.liveCount}`)

trunk.stop()
faulted.stop()
console.log(`[turnover] ${failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures})`}`)
console.log(`[turnover] STEPS: ${JSON.stringify(steps)}`)
// process.exit() here aborts the process: Jolt's teardown uv_async_send()s a handle that libuv is
// already closing, and the assert fires after RESULT: PASS was printed. Setting exitCode lets the
// loop drain instead, so the verdict the witness printed is the verdict it exits with.
process.exitCode = failures === 0 ? 0 : 1
