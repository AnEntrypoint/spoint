import { PhysicsWorld, livePhysicsWorldCount } from '../src/physics/World.js'

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
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`)
}

async function main() {
  const world = new PhysicsWorld({ gravity: [0, -18, 0] })
  await world.init()

  const key = 'model|1,1,1'
  const he = [0.5, 0.5, 0.5]

  const staticId = world.addBody('box', he, [0, 20, 0], 'static', { shapeKey: key })
  world.removeBody(staticId)
  const revivedDynamic = world.addBody('box', he, [0, 20, 0], 'dynamic', { shapeKey: key, mass: 5 })
  const revivedType = motionTypeName(world, revivedDynamic)
  const revivedMeta = world.bodyMeta.get(revivedDynamic)?.type
  const revivedMass = massOf(world, revivedDynamic)
  for (let i = 0; i < 60; i++) world.step(1 / 60, 1)
  const fellY = world.getBodyPosition(revivedDynamic)[1]
  record(
    'static-parked-body-revived-as-dynamic-falls',
    revivedType === 'dynamic' && revivedMeta === 'dynamic' && fellY < 19 && Math.abs(revivedMass - 5) < 1e-3,
    `motionType=${revivedType} meta=${revivedMeta} mass=${revivedMass} yAfter1s=${fellY.toFixed(4)}`
  )

  const dynId = world.addBody('box', he, [40, 20, 0], 'dynamic', { shapeKey: 'other|1,1,1', mass: 7 })
  for (let i = 0; i < 30; i++) world.step(1 / 60, 1)
  world.removeBody(dynId)
  const revivedStatic = world.addBody('box', he, [40, 20, 0], 'static', { shapeKey: 'other|1,1,1' })
  const staticType = motionTypeName(world, revivedStatic)
  const staticMeta = world.bodyMeta.get(revivedStatic)?.type
  for (let i = 0; i < 60; i++) world.step(1 / 60, 1)
  const staticY = world.getBodyPosition(revivedStatic)[1]
  record(
    'dynamic-parked-body-revived-as-static-stays-put',
    staticType === 'static' && staticMeta === 'static' && Math.abs(staticY - 20) < 1e-6,
    `motionType=${staticType} meta=${staticMeta} yAfter1s=${staticY.toFixed(6)}`
  )

  const forcedA = world.addBody('box', he, [80, 20, 0], 'static', { shapeKey: 'forced|1,1,1' })
  world.removeBody(forcedA)
  const parkedPool = (world._bodyPool.get('forced|1,1,1') || []).length
  world.removeBody(forcedA, true)
  const forcedB = world.addBody('box', he, [80, 20, 0], 'static', { shapeKey: 'forced|1,1,1' })
  const pool = world._bodyPool.get('forced|1,1,1') || []
  record(
    'forced-remove-never-leaves-a-dead-id-in-the-pool',
    world.bodies.has(forcedB) && parkedPool === 1 && !pool.includes(forcedA) && !pool.includes(forcedB),
    `parkedPoolSize=${parkedPool} reused=${forcedB === forcedA} live=${world.bodies.has(forcedB)} poolSize=${pool.length} resident=${world.physicsStats().bodies}`
  )

  const drainA = world.addBody('box', he, [120, 20, 0], 'static', { shapeKey: 'drain|1,1,1' })
  const drainB = world.addBody('box', he, [124, 20, 0], 'static', { shapeKey: 'drain|1,1,1' })
  world.removeBody(drainA, true)
  const drainC = world.addBody('box', he, [128, 20, 0], 'static', { shapeKey: 'drain|1,1,1' })
  const drainD = world.addBody('box', he, [132, 20, 0], 'static', { shapeKey: 'drain|1,1,1' })
  record(
    'forced-remove-of-one-pooled-body-leaves-the-rest-usable',
    world.bodies.has(drainC) && world.bodies.has(drainD) && world.bodies.has(drainB) && drainC !== drainA && drainD !== drainA,
    `b=${drainB} c=${drainC} d=${drainD} liveC=${world.bodies.has(drainC)} liveD=${world.bodies.has(drainD)}`
  )

  const freshA = world.addBody('box', he, [160, 20, 0], 'dynamic', { shapeKey: 'fresh|1,1,1', mass: 3 })
  world.removeBody(freshA)
  const freshB = world.addBody('box', he, [160, 20, 0], 'dynamic', { shapeKey: 'fresh|1,1,1', mass: 11 })
  record(
    'pool-revive-reapplies-the-requested-mass',
    Math.abs(massOf(world, freshB) - 11) < 1e-3,
    `firstMass=${massOf(world, freshA)} secondMass=${massOf(world, freshB)}`
  )

  const inertStatic = world.addBody('box', he, [200, 20, 0], 'static')
  const inertMotion = world.setBodyMotionType(inertStatic, 'dynamic')
  for (let i = 0; i < 60; i++) world.step(1 / 60, 1)
  const inertY = inertMotion === false ? null : world.getBodyPosition(inertMotion)[1]
  const inertType = inertMotion === false ? 'n/a' : motionTypeName(world, inertMotion)
  const inertMeta = inertMotion === false ? 'n/a' : world.bodyMeta.get(inertMotion)?.type
  record(
    'a-body-created-static-is-recreated-so-it-actually-falls',
    inertMotion !== false && inertMotion !== inertStatic && !world.bodies.has(inertStatic)
      && inertType === 'dynamic' && inertMeta === 'dynamic'
      && inertY !== null && Math.abs(inertY - 11) < 0.5,
    `returned=${inertMotion} oldStillLive=${world.bodies.has(inertStatic)} motionType=${inertType} meta=${inertMeta} yAfter1s=${inertY === null ? 'n/a' : inertY.toFixed(6)}`
  )

  const liveDynamic = world.addBody('box', he, [240, 20, 0], 'dynamic', { mass: 6 })
  for (let i = 0; i < 30; i++) world.step(1 / 60, 1)
  const beforeKinematicY = world.getBodyPosition(liveDynamic)[1]
  world.setBodyVelocity(liveDynamic, [0, 0, 0])
  const kinematicOk = world.setBodyMotionType(liveDynamic, 'kinematic')
  for (let i = 0; i < 60; i++) world.step(1 / 60, 1)
  const kinematicY = world.getBodyPosition(liveDynamic)[1]
  const kinematicType = motionTypeName(world, liveDynamic)
  const kinematicMeta = world.bodyMeta.get(liveDynamic)?.type
  record(
    'a-live-dynamic-body-can-become-kinematic-in-place',
    kinematicOk === liveDynamic && kinematicType === 'kinematic' && kinematicMeta === 'kinematic' && Math.abs(kinematicY - beforeKinematicY) < 1e-6,
    `returned=${kinematicOk} motionType=${kinematicType} meta=${kinematicMeta} y=${beforeKinematicY.toFixed(4)}->${kinematicY.toFixed(4)}`
  )

  const staticMass = world.addBody('box', he, [280, 20, 0], 'static')
  record(
    'setBodyMass-refuses-a-body-that-cannot-simulate',
    world.setBodyMass(staticMass, 4) === false && world.setBodyMass(liveDynamic, 9) === true && Math.abs(massOf(world, liveDynamic) - 9) < 1e-3,
    `staticReturned=${world.setBodyMass(staticMass, 4)} kinematicMass=${massOf(world, liveDynamic)}`
  )

  const stats = world.physicsStats()
  console.log('STATS ' + JSON.stringify(stats))
  console.log('LIVE_WORLDS ' + livePhysicsWorldCount())

  const failed = results.filter(r => !r.ok)
  console.log(`RESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${results.length - failed.length}/${results.length})`)
  world.destroy?.()
  await drainHandles()
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch(e => {
  console.log('THREW ' + (e?.stack || e))
  console.log('RESULT: FAIL')
  process.exit(1)
})
