process.env.SPOINT_NO_WATCH = '1'
process.env.SPOINT_SKIP_PREWARM = '1'

import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const href = p => pathToFileURL(p).href
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true'] }))
const CAP = Number(args.cap ?? 8)
const RADIUS = Number(args.radius ?? 64)
const STEP_M = Number(args.step ?? 30)
const STEPS = Number(args.steps ?? 8)

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

let centre = [0, 0]
const trunk = createTrunkColliderStreamer({
  physics, getCenters: () => [centre], frame, anchorField, worldSeed: tcfg.seed | 0, intervalMs: 1e9,
  radius: RADIUS, cap: CAP, maxCenters: 1,
})

const livePositions = () => {
  const out = []
  for (const id of trunk._live.values()) {
    if (typeof id !== 'number' || id < 0) continue
    const p = physics.getBodyPosition(id)
    if (p) out.push([p[0], p[2]])
  }
  return out
}

const steps = []
for (let step = 0; step <= STEPS; step++) {
  centre = [step * STEP_M, 0]
  const before = new Set(trunk._live.keys())
  await trunk._rebuildMulti([centre], true)
  if (typeof physics.drainBodyQueue === 'function') physics.drainBodyQueue()
  const after = new Set(trunk._live.keys())
  let newlyAdded = 0
  for (const id of after) if (!before.has(id)) newlyAdded++
  let retained = 0
  for (const id of after) if (before.has(id)) retained++
  const r2 = RADIUS * RADIUS
  let inRadius = 0
  for (const [x, z] of livePositions()) {
    const dx = x - centre[0], dz = z - centre[1]
    if (dx * dx + dz * dz <= r2) inRadius++
  }
  steps.push({ step, centre: centre[0], live: trunk.liveCount, inRadius, newlyAdded, retained })
}

const inRadiusSeries = steps.map(s => s.inRadius)
const movingSteps = steps.slice(1)
const worstInRadius = Math.min(...movingSteps.map(s => s.inRadius))
const worstNewlyAdded = Math.min(...movingSteps.map(s => s.newlyAdded))
const overCap = steps.filter(s => s.live > trunk.cap)
const noTurnover = movingSteps.filter(s => s.newlyAdded === 0)

console.log(`[turnover] real tps-game world, real PhysicsWorld, real trunk streamer, radius ${RADIUS} m cap ${trunk.cap}, centre walks ${STEP_M} m per rebuild`)
console.log(`[turnover] in-radius colliders per step: ${inRadiusSeries.join(' ')}`)
console.log(`[turnover] newly added / retained per step: ${steps.map(s => `${s.newlyAdded}/${s.retained}`).join(' ')}`)
console.log(`[turnover] live per step: ${steps.map(s => s.live).join(' ')} (cap ${trunk.cap})`)

check(`every step of a ${STEP_M} m walk keeps colliders inside the ${RADIUS} m radius, not a saturated set from an old centre`, worstInRadius > 0, `worst ${worstInRadius} of cap ${trunk.cap}`)
check('a moving centre actually turns its collider set over instead of keeping the old ones', worstNewlyAdded > 0, `worst newly added ${worstNewlyAdded}`)
check('the live set never stays above the body cap after a rebuild', overCap.length === 0, overCap.length ? `${overCap.length} step(s) over cap, worst ${Math.max(...overCap.map(s => s.live))}` : `max live ${Math.max(...steps.map(s => s.live))} of cap ${trunk.cap}`)
check('no step of the walk rebuilds without adding anything', noTurnover.length === 0, `${noTurnover.length} of ${movingSteps.length} step(s)`)

trunk.stop()
console.log(`[turnover] ${failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures})`}`)
console.log(`[turnover] STEPS: ${JSON.stringify(steps)}`)
process.exit(failures === 0 ? 0 : 1)
