import { PhysicsWorld } from '../src/physics/World.js'
import { AppRuntime } from '../src/apps/AppRuntime.js'
import { buildPhysicsAPI } from '../src/apps/AppPhysics.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function drainHandles(maxMs = 4000) {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    const n = typeof process._getActiveHandles === 'function' ? process._getActiveHandles().length : 0
    if (n === 0) return true
    await sleep(10)
  }
  return false
}

function motionTypeName(world, id) {
  const b = world._getBody(id)
  if (!b) return 'missing'
  const J = world.Jolt
  try {
    const mt = b.GetMotionType()
    if (mt === J.EMotionType_Static) return 'static'
    if (mt === J.EMotionType_Dynamic) return 'dynamic'
    if (mt === J.EMotionType_Kinematic) return 'kinematic'
    return 'raw:' + mt
  } catch (e) {
    return 'unknown'
  }
}

function massOf(world, id) {
  const b = world._getBody(id)
  if (!b) return null
  try {
    const mp = b.GetMotionProperties()
    if (!mp) return null
    const inv = mp.GetInverseMass()
    return inv > 0 ? 1 / inv : null
  } catch (e) {
    return null
  }
}

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} -- ${detail}`)
}

const GRAVITY = [0, -18, 0]
const HE = [0.5, 0.5, 0.5]
const FALLEN_AFTER_1S = 11.0

async function armStaticConvertsToDynamicAndFalls(world) {
  const key = 'recreate|box|1,1,1'
  const staticId = world.addBody('box', HE, [0, 20, 0], 'static', { shapeKey: key })
  const before = world.getBodyPosition(staticId)[1]
  for (let i = 0; i < 30; i++) world.step(1 / 60, 1)
  const staticY = world.getBodyPosition(staticId)[1]

  const liveId = world.setBodyMotionType(staticId, 'dynamic', { mass: 5 })
  const swapped = liveId !== false && liveId !== staticId
  const oldRetired = !world.bodies.has(staticId)
  const newLive = liveId !== false && world.bodies.has(liveId)
  const meta = liveId !== false ? world.bodyMeta.get(liveId)?.type : null
  const mass = liveId !== false ? massOf(world, liveId) : null
  for (let i = 0; i < 60; i++) world.step(1 / 60, 1)
  const fallenY = liveId !== false ? world.getBodyPosition(liveId)[1] : null
  const deadRead = world.getBodyPosition(staticId)

  record(
    'static-body-converted-to-dynamic-falls-under-gravity',
    swapped && oldRetired && newLive && meta === 'dynamic' && Math.abs(mass - 5) < 1e-3
      && Math.abs(staticY - before) < 1e-6 && fallenY !== null && Math.abs(fallenY - FALLEN_AFTER_1S) < 0.5
      && deadRead[0] === 0 && deadRead[1] === 0 && deadRead[2] === 0,
    `old=${staticId} new=${liveId} staticHeldY=${staticY.toFixed(6)} mass=${mass} meta=${meta} yAfterConvert1s=${fallenY === null ? 'n/a' : fallenY.toFixed(4)} deadIdReads=${JSON.stringify(deadRead)}`
  )
  return { staticId, liveId }
}

async function armShapeCacheSurvives(world) {
  const key = 'cachecheck|box|1,1,1'
  const staticId = world.addBody('box', HE, [0, 20, 0], 'static', { shapeKey: key })
  const before = world.physicsStats()
  const liveId = world.setBodyMotionType(staticId, 'dynamic')
  const after = world.physicsStats()
  const radius = world._getBody(liveId)?.GetShape()?.GetLocalBounds()?.mMax?.GetY?.()
  record(
    'shape-cache-and-refcount-survive-the-conversion',
    liveId !== false && after.shapesCached === before.shapesCached && after.shapeRefs === before.shapeRefs
      && Math.abs(radius - 0.5) < 1e-6 && world._bodyShapeKey.get(liveId) === key,
    `shapesCached ${before.shapesCached}->${after.shapesCached} shapeRefs ${before.shapeRefs}->${after.shapeRefs} shapeHalfExtent=${radius}`
  )
}

async function armStaticConvertsToKinematic(world) {
  const staticId = world.addBody('box', HE, [40, 20, 0], 'static')
  const before = world.getBodyPosition(staticId)[1]
  const liveId = world.setBodyMotionType(staticId, 'kinematic')
  for (let i = 0; i < 60; i++) world.step(1 / 60, 1)
  const y = liveId !== false ? world.getBodyPosition(liveId)[1] : null
  const type = liveId !== false ? motionTypeName(world, liveId) : 'n/a'
  record(
    'static-body-converted-to-kinematic-holds-its-position',
    liveId !== false && liveId !== staticId && type === 'kinematic' && y !== null && Math.abs(y - before) < 1e-6,
    `old=${staticId} new=${liveId} type=${type} y=${y === null ? 'n/a' : y.toFixed(6)}`
  )
}

async function armEntityLevelConversion() {
  const world = new PhysicsWorld({ gravity: GRAVITY })
  await world.init()
  const runtime = new AppRuntime({ physics: world, gravity: GRAVITY, tickRate: 60 })
  const ent = runtime.spawnEntity('falling-crate', { position: [0, 20, 0] })
  ent.mass = 5
  const api = buildPhysicsAPI(ent, runtime)
  api.addBoxCollider(HE)
  const staticId = ent._physicsBodyId
  for (let i = 0; i < 30; i++) world.step(1 / 60, 1)
  runtime._syncDynamicBodies()
  const heldY = ent.position[1]

  const ok = api.setMotionType('dynamic')
  const liveId = ent._physicsBodyId
  const mapped = runtime._physicsBodyToEntityId.get(liveId)
  const activeSet = runtime._activeDynamicIds.has(ent.id)
  for (let i = 0; i < 60; i++) world.step(1 / 60, 1)
  runtime._syncDynamicBodies()
  const fallenY = ent.position[1]
  const mass = massOf(world, liveId)

  record(
    'entity-setMotionType-dynamic-simulates-and-rebinds-the-live-id',
    ok === true && liveId !== staticId && world.bodies.has(liveId) && !world.bodies.has(staticId)
      && mapped === ent.id && activeSet && ent.bodyType === 'dynamic'
      && Math.abs(heldY - 20) < 1e-6 && Math.abs(fallenY - FALLEN_AFTER_1S) < 0.5 && Math.abs(mass - 5) < 1e-3,
    `ok=${ok} old=${staticId} new=${liveId} mapped=${mapped} activeSet=${activeSet} bodyType=${ent.bodyType} mass=${mass} entityY=${heldY.toFixed(6)}->${fallenY.toFixed(4)}`
  )

  const backOk = api.setMotionType('static')
  const backY0 = ent.position[1]
  for (let i = 0; i < 60; i++) world.step(1 / 60, 1)
  runtime._syncDynamicBodies()
  const backY = ent.position[1]
  record(
    'entity-round-trips-dynamic-back-to-static-in-place',
    backOk === true && ent.bodyType === 'static' && !runtime._activeDynamicIds.has(ent.id)
      && Math.abs(backY - backY0) < 1e-6 && motionTypeName(world, ent._physicsBodyId) === 'static',
    `ok=${backOk} bodyType=${ent.bodyType} y=${backY0.toFixed(4)}->${backY.toFixed(4)} type=${motionTypeName(world, ent._physicsBodyId)}`
  )

  world.destroy?.()
}

async function armCycleStability(world) {
  const before = world.physicsStats().bodies
  const resident = []
  let allSwapped = true, allLive = true, allFell = true
  for (let cycle = 0; cycle < 100; cycle++) {
    const staticId = world.addBody('box', HE, [200 + cycle, 20, 0], 'static', { shapeKey: 'cycle|box|1,1,1' })
    const liveId = world.setBodyMotionType(staticId, 'dynamic', { mass: 3 })
    if (liveId === false || liveId === staticId) allSwapped = false
    if (liveId === false || !world.bodies.has(liveId) || world.bodies.has(staticId)) allLive = false
    const y0 = liveId !== false ? world.getBodyPosition(liveId)[1] : 20
    world.step(1 / 60, 1)
    const y1 = liveId !== false ? world.getBodyPosition(liveId)[1] : 20
    if (!(y1 < y0 - 1e-4)) allFell = false
    world.removeBody(liveId, true)
    if (cycle % 25 === 0) resident.push(world.physicsStats().bodies)
  }
  const after = world.physicsStats().bodies
  record(
    'repeated-add-convert-remove-cycles-do-not-grow-resident-bodies',
    allSwapped && allLive && allFell && after === before && resident.every(n => n === before),
    `resident ${before}->${after} samples=${JSON.stringify(resident)} swapped=${allSwapped} live=${allLive} fell=${allFell}`
  )
}

async function armHonestFailureAtBodyLimit() {
  const world = new PhysicsWorld({ gravity: GRAVITY, joltLimits: { maxBodies: 1, maxBodyPairs: 64, maxContactConstraints: 64 } })
  await world.init()
  const staticId = world.addBody('box', HE, [0, 20, 0], 'static')
  const before = world.getBodyPosition(staticId)[1]
  const result = world.setBodyMotionType(staticId, 'dynamic')
  for (let i = 0; i < 60; i++) world.step(1 / 60, 1)
  const after = world.getBodyPosition(staticId)[1]
  record(
    'conversion-refuses-at-the-body-limit-and-leaves-the-body-untouched',
    result === false && world.bodies.has(staticId) && motionTypeName(world, staticId) === 'static'
      && world.bodyMeta.get(staticId)?.type === 'static' && Math.abs(after - before) < 1e-6,
    `returned=${result} type=${motionTypeName(world, staticId)} meta=${world.bodyMeta.get(staticId)?.type} y=${before.toFixed(6)}->${after.toFixed(6)}`
  )
  world.destroy?.()
}

async function armHonestFailureForUnsimulatableShape() {
  const world = new PhysicsWorld({ gravity: GRAVITY })
  await world.init()
  const samples = new Float32Array(8 * 8)
  const staticId = world.addHeightField(samples, 8, [4, 1, 4], [0, 0, 0])
  if (staticId == null) {
    record('conversion-refuses-a-shape-that-cannot-simulate', false, 'addHeightField returned null so the arm had no subject')
    world.destroy?.()
    return
  }
  const result = world.setBodyMotionType(staticId, 'dynamic')
  record(
    'conversion-refuses-a-shape-that-cannot-simulate',
    result === false && world.bodies.has(staticId) && motionTypeName(world, staticId) === 'static'
      && world.bodyMeta.get(staticId)?.type === 'static',
    `returned=${result} shape=${world.bodyMeta.get(staticId)?.shape} type=${motionTypeName(world, staticId)}`
  )
  world.destroy?.()
}

async function main() {
  const world = new PhysicsWorld({ gravity: GRAVITY })
  await world.init()

  await armStaticConvertsToDynamicAndFalls(world)
  await armShapeCacheSurvives(world)
  await armStaticConvertsToKinematic(world)
  await armCycleStability(world)

  console.log('STATS ' + JSON.stringify(world.physicsStats()))
  world.destroy?.()

  await armEntityLevelConversion()
  await armHonestFailureAtBodyLimit()
  await armHonestFailureForUnsimulatableShape()

  const failed = results.filter(r => !r.ok)
  console.log(`RESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${results.length - failed.length}/${results.length})`)
  await drainHandles()
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch(e => {
  console.log('THREW ' + (e?.stack || e))
  console.log('RESULT: FAIL')
  process.exit(1)
})
