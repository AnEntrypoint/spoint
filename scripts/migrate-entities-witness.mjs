// Claim: a re-anchor is a change of basis, so the world-space position, velocity and forward of every
// re-expressed quantity are unchanged across it. Stored values are also checked against the exact map.
// CHART_MIGRATE_ENTITIES_MODULE=<path> drives another copy of the module instead, such as a scratch
// mutant, or a path that does not exist (which must FAIL).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OVERRIDE = process.env.CHART_MIGRATE_ENTITIES_MODULE
const MODULE_PATH = OVERRIDE
  ? path.resolve(OVERRIDE)
  : path.join(ROOT, 'src', 'sdk', 'chartState', 'migrateEntities.js')
const TARGET = OVERRIDE ? `override:${MODULE_PATH}` : 'honest-tree'

const PT_TOL = 1e-6
const VEC_TOL = 1e-9
const RADIUS_M = 6371000
const FWD = [0, 0, 1]

const checks = []
const failures = []
function expect(name, ok, detail) {
  checks.push(name)
  if (!ok) failures.push(detail === undefined ? name : `${name} (${detail})`)
}
function observe(name, value) {
  console.log(`OBSERVE ${name}: ${JSON.stringify(value)}`)
}
function finish() {
  const summary = `checks=${checks.length} failures=${failures.length} target=${TARGET}`
  if (failures.length === 0) {
    console.log(`RESULT: PASS -- ${summary}`)
    process.exitCode = 0
  } else {
    console.log(`RESULT: FAIL -- ${summary} failing=[${failures.join('; ')}]`)
    process.exitCode = 1
  }
}

const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s]
const mulM = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
]
const near = (a, b, tol) => Array.isArray(a) && Array.isArray(b) && a.length === b.length
  && a.every((v, i) => Number.isFinite(v) && Math.abs(v - b[i]) <= tol)
const liftOf = c => c.radius + c.anchorHeight - c.offsetY
const worldPoint = (c, p) => add3(add3(scale3(c.east, p[0]), scale3(c.up, p[1] + liftOf(c))), scale3(c.north, p[2]))
const worldVec = (c, v) => add3(add3(scale3(c.east, v[0]), scale3(c.up, v[1])), scale3(c.north, v[2]))
const quatNorm = q => Math.hypot(q[0], q[1], q[2], q[3])

function rotateByQuat(q, v) {
  const [x, y, z, w] = q
  const tx = 2 * (y * v[2] - z * v[1])
  const ty = 2 * (z * v[0] - x * v[2])
  const tz = 2 * (x * v[1] - y * v[0])
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ]
}

function quatOfAxisAngle(axis, angle) {
  const l = Math.hypot(axis[0], axis[1], axis[2])
  const s = Math.sin(angle / 2)
  return [(axis[0] / l) * s, (axis[1] / l) * s, (axis[2] / l) * s, Math.cos(angle / 2)]
}

function axisAngleMatrix(axis, angle) {
  const l = Math.hypot(axis[0], axis[1], axis[2])
  const x = axis[0] / l, y = axis[1] / l, z = axis[2] / l
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ]
}

function basisOf(R) {
  return {
    east: [R[0][0], R[1][0], R[2][0]],
    up: [R[0][1], R[1][1], R[2][1]],
    north: [R[0][2], R[1][2], R[2][2]],
  }
}

const fromChart = { radius: RADIUS_M, offsetY: 0.25, anchorHeight: 2.5, chartEpoch: 1, ...basisOf(axisAngleMatrix([0.1, 0.9, -0.2], 0.2)) }
const toChart = { radius: RADIUS_M, offsetY: 1.5, anchorHeight: 7, chartEpoch: 2, ...basisOf(axisAngleMatrix([0.3, 0.5, 0.8], 0.35)) }

const INIT = {
  dyn: { pos: [12.5, 3.25, -40], rot: quatOfAxisAngle([0.2, 0.4, 0.9], 0.7), vel: [1.5, -0.5, 4], spawn: [12, 0.5, -38], angVel: [0.1, 0.2, -0.3] },
  stat: { pos: [-30, 1, 60], rot: quatOfAxisAngle([1, 0, 0], 0.4), spawn: [-30, 0, 60.5] },
  statNoBody: { pos: [5, 0, 5] },
  veh: { pos: [200, 2, -150], rot: quatOfAxisAngle([0, 1, 0], 1.1), vel: [8, 0, 2], spawn: [200, 2, -150], angVel: [0, 0, 0.05] },
  kin: { pos: [-120, 5, 30], rot: quatOfAxisAngle([0.5, 0.5, 0], 0.3), vel: [0, 0, 1], spawn: [-120, 5, 30] },
  child: { pos: [13, 4, -39], rot: quatOfAxisAngle([0.3, 0.1, 0.9], 1.3), vel: [0.2, 0, 0.1], angVel: [0.05, 0, 0.01] },
  att: { offset: [0.75, -1.25, 2] },
}

function makePhysics(bodies) {
  const store = new Map()
  for (const b of bodies) {
    store.set(b.id, { position: [...b.position], rotation: [...b.rotation], linear: [...b.linear], angular: [...b.angular], active: b.active })
  }
  return {
    store,
    bodies: store,
    dormantStatics: { has: () => false, park: () => {} },
    setBodyTransform(id, position, rotation) {
      const body = store.get(id)
      body.position = [...position]
      body.rotation = [...rotation]
    },
    isBodyActive: id => store.get(id).active,
    getBodyPosition: id => store.get(id).position,
    getBodyRotation: id => store.get(id).rotation,
    getBodyVelocity: id => store.get(id).linear,
    getBodyAngularVelocity: id => store.get(id).angular,
    setBodyVelocity(id, v) { store.get(id).linear = [...v] },
    setBodyAngularVelocity(id, w) { store.get(id).angular = [...w] },
  }
}

function buildWorld(withPhysics) {
  const physics = makePhysics([
    { id: 101, position: INIT.dyn.pos, rotation: INIT.dyn.rot, linear: INIT.dyn.vel, angular: INIT.dyn.angVel, active: true },
    { id: 102, position: INIT.stat.pos, rotation: INIT.stat.rot, linear: [0, 0, 0], angular: [0, 0, 0], active: false },
    { id: 103, position: INIT.veh.pos, rotation: INIT.veh.rot, linear: INIT.veh.vel, angular: INIT.veh.angVel, active: true },
    { id: 104, position: INIT.kin.pos, rotation: INIT.kin.rot, linear: INIT.kin.vel, angular: [0, 0, 0], active: true },
    { id: 201, position: INIT.child.pos, rotation: INIT.child.rot, linear: INIT.child.vel, angular: INIT.child.angVel, active: true },
  ])
  const entities = {
    dyn: { id: 'dyn', bodyType: 'dynamic', parent: null, position: [...INIT.dyn.pos], rotation: [...INIT.dyn.rot], velocity: [...INIT.dyn.vel], _spawnPosition: [...INIT.dyn.spawn], _physicsBodyId: 101 },
    stat: { id: 'stat', bodyType: 'static', parent: null, position: [...INIT.stat.pos], rotation: [...INIT.stat.rot], _spawnPosition: [...INIT.stat.spawn], _physicsBodyId: 102 },
    statNoBody: { id: 'statNoBody', bodyType: 'static', parent: null, position: [...INIT.statNoBody.pos], rotation: [0, 0, 0, 1] },
    veh: { id: 'veh', bodyType: 'static', _vehicleId: 7, parent: null, position: [...INIT.veh.pos], rotation: [...INIT.veh.rot], velocity: [...INIT.veh.vel], _spawnPosition: [...INIT.veh.spawn], _physicsBodyId: 103 },
    kin: { id: 'kin', bodyType: 'dynamic', _bodyTier: 'kinematic', parent: null, position: [...INIT.kin.pos], rotation: [...INIT.kin.rot], velocity: [...INIT.kin.vel], _spawnPosition: [...INIT.kin.spawn], _physicsBodyId: 104 },
    child: { id: 'child', bodyType: 'dynamic', parent: 'dyn', position: [0, 1, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], _physicsBodyId: 201 },
    childNoBody: { id: 'childNoBody', bodyType: 'dynamic', parent: 'dyn', position: [0, 0, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0] },
  }
  const att = { offset: [...INIT.att.offset] }
  const player = { id: 'p1', state: { position: [20, 2, -10] } }
  const seenReseat = [], inserted = [], dirtied = [], apiCalls = [], errors = []
  const stage = { spatial: { reseat: positionOf => seenReseat.push(positionOf) } }
  const contexts = new Map([['appEnt', { _liveChartAwareApis: () => [{ onChartReanchor: payload => apiCalls.push({ kind: 'api', payload }) }] }]])
  const apps = new Map([['appEnt', { server: { onChartReanchor: (ctx, payload) => apiCalls.push({ kind: 'app', ctx, payload }) } }]])
  const behaviours = new Map([['dyn', [{ name: 'probe', api: { onChartReanchor: payload => apiCalls.push({ kind: 'behaviour', payload }) } }]]])
  const runtime = {
    entities: new Map(Object.values(entities).map(e => [e.id, e])),
    _physics: withPhysics ? physics : null,
    _attachments: new Map([['att', att]]),
    _stageLoader: { allStages: () => [stage] },
    _playerIndex: { insert: (id, position) => inserted.push([id, position]) },
    getPlayers: () => [player],
    _markDirty: id => dirtied.push(id),
    _staticVersion: 10,
    _snapshotEncCache: new Map([['k', 1]]),
    _staticXf: new Map([['k', 1]]),
    apps,
    contexts,
    _behaviours: behaviours,
    _safeCall: (obj, method, args, label) => {
      try { return obj[method](...args) } catch (e) { errors.push(`${label}: ${e.message}`) }
    },
    _logAppError: (label, e) => errors.push(`${label}: ${e.message}`),
  }
  return { runtime, physics, entities, att, player, seenReseat, inserted, dirtied, apiCalls, errors }
}

function miniPhysics(ids, dormantIds = []) {
  const store = new Map(ids.map(id => [id, null]))
  const dormant = new Set(dormantIds)
  const parked = []
  return {
    store,
    parked,
    bodies: store,
    dormantStatics: {
      has: id => dormant.has(id),
      park: list => { for (const item of list) parked.push(item.bodyId) },
    },
    setBodyTransform(id, position) { store.set(id, [...position]) },
  }
}

const staticAt = (id, position) => ({ id, bodyType: 'static', position, rotation: [0, 0, 0, 1], _physicsBodyId: id })

async function main() {
  const transferMod = await import(pathToFileURL(path.join(ROOT, 'src', 'shared', 'chartTransfer.js')).href)
  const passMod = await import(pathToFileURL(path.join(ROOT, 'src', 'shared', 'chartReexpress.js')).href)
  if (!fs.existsSync(MODULE_PATH)) {
    expect('module file exists', false, MODULE_PATH)
    return finish()
  }
  let mod
  try {
    mod = await import(pathToFileURL(MODULE_PATH).href)
  } catch (error) {
    expect('module loads', false, error.message)
    return finish()
  }
  expect('exports createEntityMigrator', typeof mod.createEntityMigrator === 'function')
  expect('exports placeStaticBodies', typeof mod.placeStaticBodies === 'function')
  expect('exports collectMovers', typeof mod.collectMovers === 'function')
  if (typeof mod.createEntityMigrator !== 'function') return finish()

  const transfer = transferMod.createChartTransfer(fromChart, toChart)
  const M = transfer.m
  const event = { epoch: toChart.chartEpoch, transfer, from: fromChart, to: toChart }

  const world = buildWorld(true)
  const migrate = mod.createEntityMigrator({ appRuntime: world.runtime, staticBudgetMs: 1e9 })
  let counts = null
  try {
    counts = migrate(event, passMod.createReexpressPass(transfer))
  } catch (error) {
    expect('migrate() completes without throwing', false, error.message)
  }

  if (counts) {
    const { dyn, stat, statNoBody, veh, kin, child } = world.entities
    const body = id => world.physics.store.get(id)

    expect('counts.roots = 5', counts.roots === 5, `got ${counts.roots}`)
    expect('counts.children = 2', counts.children === 2, `got ${counts.children}`)
    expect('counts.attachments = 1', counts.attachments === 1, `got ${counts.attachments}`)
    expect('counts.bodiesMoved = 5 (dyn, veh, kin, child bodies, plus stat placed)', counts.bodiesMoved === 5, `got ${counts.bodiesMoved}`)
    expect('counts.notified = 3 (app server, context api, behaviour)', counts.notified === 3, `got ${counts.notified}`)
    expect('stat placed once and nothing parked', counts.statics.nearMoved + counts.statics.budgetMoved === 1 && counts.statics.parked === 0,
      `near=${counts.statics.nearMoved} budget=${counts.statics.budgetMoved} parked=${counts.statics.parked}`)

    expect('dyn.position = transfer.point(old)', near(dyn.position, transfer.point(INIT.dyn.pos), PT_TOL))
    expect('dyn.position world-invariant', near(worldPoint(toChart, dyn.position), worldPoint(fromChart, INIT.dyn.pos), PT_TOL))
    expect('dyn._spawnPosition world-invariant', near(worldPoint(toChart, dyn._spawnPosition), worldPoint(fromChart, INIT.dyn.spawn), PT_TOL))
    expect('dyn.velocity = M*v (a vector, no translation)', near(dyn.velocity, mulM(M, INIT.dyn.vel), VEC_TOL))
    expect('dyn.velocity world-invariant', near(worldVec(toChart, dyn.velocity), worldVec(fromChart, INIT.dyn.vel), VEC_TOL))
    expect('dyn forward world-invariant', near(worldVec(toChart, rotateByQuat(dyn.rotation, FWD)), worldVec(fromChart, rotateByQuat(INIT.dyn.rot, FWD)), VEC_TOL))
    expect('dyn.rotation is unit', Math.abs(quatNorm(dyn.rotation) - 1) <= VEC_TOL)
    expect('body101.position = dyn.position', near(body(101).position, dyn.position, 0))
    expect('body101.rotation = dyn.rotation', near(body(101).rotation, dyn.rotation, 0))
    expect('body101.linear = dyn.velocity (active dynamic body)', near(body(101).linear, dyn.velocity, 0))
    expect('body101.angular = M*w', near(body(101).angular, mulM(M, INIT.dyn.angVel), VEC_TOL))
    expect('body101.angular world-invariant', near(worldVec(toChart, body(101).angular), worldVec(fromChart, INIT.dyn.angVel), VEC_TOL))

    expect('stat.position = transfer.point(old) (inline static transform)', near(stat.position, transfer.point(INIT.stat.pos), PT_TOL))
    expect('stat.position world-invariant', near(worldPoint(toChart, stat.position), worldPoint(fromChart, INIT.stat.pos), PT_TOL))
    expect('stat._spawnPosition = transfer.point(old)', near(stat._spawnPosition, transfer.point(INIT.stat.spawn), PT_TOL))
    expect('stat forward world-invariant', near(worldVec(toChart, rotateByQuat(stat.rotation, FWD)), worldVec(fromChart, rotateByQuat(INIT.stat.rot, FWD)), VEC_TOL))
    expect('stat.rotation is unit', Math.abs(quatNorm(stat.rotation) - 1) <= VEC_TOL)
    expect('body102.position = stat.position (placed)', near(body(102).position, stat.position, 0))
    expect('body102.rotation = stat.rotation', near(body(102).rotation, stat.rotation, 0))
    expect('statNoBody.position world-invariant', near(worldPoint(toChart, statNoBody.position), worldPoint(fromChart, INIT.statNoBody.pos), PT_TOL))

    expect('veh.position world-invariant', near(worldPoint(toChart, veh.position), worldPoint(fromChart, INIT.veh.pos), PT_TOL))
    expect('veh.velocity world-invariant', near(worldVec(toChart, veh.velocity), worldVec(fromChart, INIT.veh.vel), VEC_TOL))
    expect('body103.position = veh.position', near(body(103).position, veh.position, 0))
    expect('body103.rotation = veh.rotation', near(body(103).rotation, veh.rotation, 0))
    expect('vehicle chassis body103 (entity bodyType static) linear = M*v', near(body(103).linear, mulM(M, INIT.veh.vel), VEC_TOL), `stored=${JSON.stringify(body(103).linear)}`)
    expect('vehicle chassis body103 (entity bodyType static) angular = M*w', near(body(103).angular, mulM(M, INIT.veh.angVel), VEC_TOL), `stored=${JSON.stringify(body(103).angular)}`)

    expect('kin.position world-invariant', near(worldPoint(toChart, kin.position), worldPoint(fromChart, INIT.kin.pos), PT_TOL))
    expect('kin.velocity world-invariant', near(worldVec(toChart, kin.velocity), worldVec(fromChart, INIT.kin.vel), VEC_TOL))
    expect('body104.position = kin.position', near(body(104).position, kin.position, 0))
    expect('body104.rotation = kin.rotation', near(body(104).rotation, kin.rotation, 0))
    observe('body104 (kinematic tier) linear velocity after migration', { stored: body(104).linear, reexpressed: mulM(M, INIT.kin.vel) })

    expect('child body201.position world-invariant', near(worldPoint(toChart, body(201).position), worldPoint(fromChart, INIT.child.pos), PT_TOL))
    expect('child body201 forward world-invariant', near(worldVec(toChart, rotateByQuat(body(201).rotation, FWD)), worldVec(fromChart, rotateByQuat(INIT.child.rot, FWD)), VEC_TOL))
    expect('child body201.linear = M*v (active dynamic child)', near(body(201).linear, mulM(M, INIT.child.vel), VEC_TOL))
    expect('child body201.angular = M*w', near(body(201).angular, mulM(M, INIT.child.angVel), VEC_TOL))

    expect('attachment offset = M*offset', near(world.att.offset, mulM(M, INIT.att.offset), VEC_TOL))
    expect('attachment offset world-invariant', near(worldVec(toChart, world.att.offset), worldVec(fromChart, INIT.att.offset), VEC_TOL))

    expect('every entity marked dirty exactly once', world.dirtied.length === 7 && new Set(world.dirtied).size === 7, `got ${world.dirtied.length}`)
    expect('_staticVersion incremented once', world.runtime._staticVersion === 11, `got ${world.runtime._staticVersion}`)
    expect('_snapshotEncCache cleared', world.runtime._snapshotEncCache.size === 0)
    expect('_staticXf cleared', world.runtime._staticXf.size === 0)

    expect('reseat called once; its positionOf reads migrated positions',
      world.seenReseat.length === 1 && world.seenReseat[0]('dyn') === dyn.position && world.seenReseat[0]('veh') === veh.position)
    expect('player index re-inserted with the player position',
      world.inserted.length === 1 && world.inserted[0][0] === 'p1' && world.inserted[0][1] === world.player.state.position)

    const appCall = world.apiCalls.find(c => c.kind === 'app')
    const apiCall = world.apiCalls.find(c => c.kind === 'api')
    const behaviourCall = world.apiCalls.find(c => c.kind === 'behaviour')
    expect('app server onChartReanchor called with its context', !!appCall && appCall.ctx === world.runtime.contexts.get('appEnt'))
    expect('context api onChartReanchor called', !!apiCall)
    expect('behaviour onChartReanchor called', !!behaviourCall)
    for (const call of [appCall, apiCall, behaviourCall]) {
      if (!call) continue
      expect(`${call.kind} payload carries the event epoch, transfer, from and to`,
        call.payload.epoch === event.epoch && call.payload.transfer === transfer && call.payload.from === fromChart && call.payload.to === toChart)
    }
    expect('no chart-aware callback errors', world.errors.length === 0, world.errors.join(' | '))
  }

  const bare = buildWorld(false)
  try {
    const bareCounts = mod.createEntityMigrator({ appRuntime: bare.runtime, staticBudgetMs: 1e9 })(event, passMod.createReexpressPass(transfer))
    expect('no physics: dyn.position still re-expressed', near(worldPoint(toChart, bare.entities.dyn.position), worldPoint(fromChart, INIT.dyn.pos), PT_TOL))
    expect('no physics: stat.position still re-expressed', near(worldPoint(toChart, bare.entities.stat.position), worldPoint(fromChart, INIT.stat.pos), PT_TOL))
    expect('no physics: no bodies moved and no statics placed',
      bareCounts.bodiesMoved === 0 && bareCounts.statics.nearMoved === 0 && bareCounts.statics.budgetMoved === 0)
  } catch (error) {
    expect('no physics: migrate() completes without throwing', false, error.message)
  }

  const p1 = miniPhysics([11, 12, 13, 14, 15], [15])
  const r1 = mod.placeStaticBodies(p1, [
    staticAt(11, [50, 0, 0]),
    staticAt(12, [0, 0, 500]),
    staticAt(13, [96, 0, 0]),
    staticAt(14, [0, 0, 96.5]),
    staticAt(15, [30, 0, 30]),
  ], [[0, 0, 0]], 1e9)
  expect('placeStaticBodies: 50 m and 96 m (boundary) statics are near and written',
    near(p1.store.get(11), [50, 0, 0], 0) && near(p1.store.get(13), [96, 0, 0], 0))
  expect('placeStaticBodies: 500 m and 96.5 m statics are budget-written',
    near(p1.store.get(12), [0, 0, 500], 0) && near(p1.store.get(14), [0, 0, 96.5], 0))
  expect('placeStaticBodies: dormant static skipped', p1.store.get(15) === null)
  expect('placeStaticBodies: near=2 budget=2 parked=0', r1.nearMoved === 2 && r1.budgetMoved === 2 && r1.parked === 0,
    `near=${r1.nearMoved} budget=${r1.budgetMoved} parked=${r1.parked}`)
  expect('placeStaticBodies: the five placements account for every static exactly once',
    r1.nearMoved + r1.budgetMoved + r1.parked + r1.dormant + r1.orphaned === 5,
    `near=${r1.nearMoved} budget=${r1.budgetMoved} parked=${r1.parked} dormant=${r1.dormant} orphaned=${r1.orphaned}`)

  const p3 = miniPhysics([])
  const r3 = mod.placeStaticBodies(p3, [staticAt(31, [0, 0, 500])], [[0, 0, 0]], 0)
  expect('placeStaticBodies: an out-of-budget static whose body is gone is orphaned, neither parked nor written',
    r3.orphaned === 1 && r3.parked === 0 && r3.budgetMoved === 0 && r3.nearMoved === 0,
    `orphaned=${r3.orphaned} parked=${r3.parked} budget=${r3.budgetMoved} near=${r3.nearMoved}`)

  const p2 = miniPhysics([21, 22])
  const r2 = mod.placeStaticBodies(p2, [staticAt(21, [0, 0, 500]), staticAt(22, [0, 0, 96.5])], [[0, 0, 0]], 0)
  expect('placeStaticBodies: out-of-budget statics parked and not written',
    r2.parked === 2 && r2.budgetMoved === 0 && p2.store.get(21) === null && p2.store.get(22) === null && p2.parked.join(',') === '21,22',
    `parked=${r2.parked} budget=${r2.budgetMoved}`)

  const pa = { id: 'pa', state: { position: [9, 9, 9] } }
  const points = mod.collectMovers({ getPlayers: () => [pa, { id: 'pb', state: {} }] }, [{ position: [1, 2, 3] }])
  expect('collectMovers: players with a position first, then moving entities',
    points.length === 2 && points[0] === pa.state.position && near(points[1], [1, 2, 3], 0))

  finish()
}

main().catch(error => {
  failures.push(`witness crashed: ${error && error.message}`)
  finish()
})
