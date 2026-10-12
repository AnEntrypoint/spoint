import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { numericFlag, parseArgs, strArg } from './lib/witness-args.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const witnessOutDir = path.join(repoRoot, '.gm', 'witness-out')
const args = parseArgs(process.argv.slice(2))

const TAG = '[physics-lod-budget]'

const POPULATION = numericFlag(args, 'population', 800)
const PLAYER_COUNT = numericFlag(args, 'players', 4)
const RADIUS = numericFlag(args, 'radius', 30)
const BUDGET = numericFlag(args, 'budget', 512)
const LOD_INTERVAL = numericFlag(args, 'lodInterval', 32)
const WARM_TICKS = numericFlag(args, 'warm', 256)
const MEASURE_TICKS = numericFlag(args, 'ticks', 256)
const SPREAD_M = numericFlag(args, 'spreadM', 160)
const DROP_Y = numericFlag(args, 'dropY', 3)
const PLAYER_SPEED = numericFlag(args, 'playerSpeed', 0)
const ORBIT_M = numericFlag(args, 'orbitM', 24)
const OUTLIER_MS = numericFlag(args, 'outlierMs', 0.05)
const DT = 1 / 64
const EXPECT_HASH = strArg(args.expect, null)
const REQUIRE_ENGAGED = args.requireEngaged === true || args.requireEngaged === 'true'
const OUT = strArg(args.out, null)

const { fnv1aBytes } = await import('../src/shared/fnv1a.js')
const { PhysicsWorld } = await import('../src/physics/World.js')
const { mixinPhysics } = await import('../src/apps/AppRuntimePhysics.js')

const lines = []
function emit(line) {
  lines.push(line)
  console.log(line)
}

const failures = []
function expect(name, got, predicate) {
  let ok = false
  try { ok = Boolean(predicate(got)) } catch { ok = false }
  if (!ok) failures.push(name + '=' + JSON.stringify(got))
  return got
}

const nowMs = () => Number(process.hrtime.bigint()) / 1e6

function stats(samples) {
  if (samples.length === 0) return { n: 0, min: 0, median: 0, p95: 0, mean: 0, max: 0 }
  const s = samples.slice().sort((a, b) => a - b)
  const n = s.length
  let sum = 0
  for (const v of s) sum += v
  return { n, min: s[0], median: s[n >> 1], p95: s[Math.min(n - 1, Math.floor(n * 0.95))], mean: sum / n, max: s[n - 1] }
}
const fmt = (v) => Number(v).toFixed(5)

const world = await new PhysicsWorld({ gravity: [0, -18, 0] }).init()
world.addStaticBox([SPREAD_M, 0.5, SPREAD_M], [0, -0.5, 0], [0, 0, 0, 1])

const runtime = {
  entities: new Map(),
  _physics: world,
  _physicsLODRadius: RADIUS,
  _physicsBodyBudget: BUDGET,
  _physicsBodyToEntityId: new Map(),
  _activeDynamicIds: new Set(),
  _sleepingDynamicIds: new Set(),
  _suspendedEntityIds: new Set(),
  _dynamicEntityIds: new Set(),
  _movedStaticIds: new Set(),
  _lodIds: null,
  _lodPointer: 0,
  currentTick: 0,
  getUnmanagedDynamicIds() { return [] },
}
mixinPhysics(runtime)
runtime._registerPhysicsCallbacks()

const entities = []
const side = Math.ceil(Math.sqrt(POPULATION))
const stepXZ = SPREAD_M / side
for (let i = 0; i < POPULATION; i++) {
  const gx = i % side
  const gz = (i / side) | 0
  const e = {
    id: 'e' + String(i).padStart(5, '0'),
    position: [-SPREAD_M / 2 + gx * stepXZ, DROP_Y + (i % 7) * 0.25, -SPREAD_M / 2 + gz * stepXZ],
    rotation: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    scale: [1, 1, 1],
    mass: 2,
    _linearDamping: 0.05,
    _angularDamping: 0.07,
    bodyType: 'dynamic',
    _bodyDef: {
      shapeType: 'box',
      params: [0.5, 0.5, 0.5],
      motionType: 'dynamic',
      opts: { mass: 2, linearDamping: 0.05, angularDamping: 0.07, linearCast: true, friction: 0.5 },
    },
    _bodyActive: false,
    _bodyTier: 'dataonly',
  }
  entities.push(e)
  runtime.entities.set(e.id, e)
  runtime._dynamicEntityIds.add(e.id)
}

const players = []
for (let i = 0; i < PLAYER_COUNT; i++) {
  players.push({ id: 'p' + i, state: { position: [0, 1, 0] } })
}
function placePlayers(tick) {
  const phase = (PLAYER_SPEED * tick * DT) / ORBIT_M
  for (let i = 0; i < players.length; i++) {
    const a = phase + (i * Math.PI * 2) / Math.max(1, players.length)
    const p = players[i].state.position
    p[0] = Math.cos(a) * ORBIT_M
    p[1] = 1
    p[2] = Math.sin(a) * ORBIT_M
  }
}
placePlayers(0)

let addBodyCalls = 0
let removeBodyCalls = 0
let motionTypeCalls = 0
let deactivateCalls = 0
let bodyOpMs = 0
const rawAddBody = world.addBody.bind(world)
const rawRemoveBody = world.removeBody.bind(world)
const rawSetMotionType = world.setBodyMotionType.bind(world)
const rawDeactivateBody = world.deactivateBody.bind(world)
world.addBody = (...a) => { const t = nowMs(); const r = rawAddBody(...a); bodyOpMs += nowMs() - t; addBodyCalls++; return r }
world.removeBody = (...a) => { const t = nowMs(); const r = rawRemoveBody(...a); bodyOpMs += nowMs() - t; removeBodyCalls++; return r }
world.setBodyMotionType = (...a) => { const t = nowMs(); const r = rawSetMotionType(...a); bodyOpMs += nowMs() - t; motionTypeCalls++; return r }
world.deactivateBody = (id) => { deactivateCalls++; return rawDeactivateBody(id) }

let budgetCallsTotal = 0
let budgetSweeps = 0
let budgetDeactivated = 0
let budgetRemoved = 0
let budgetActivePeak = 0
const budgetSamples = []
const rawBudget = runtime._enforceBodyBudget
runtime._enforceBodyBudget = function () {
  const t0 = nowMs()
  const d0 = deactivateCalls
  const r0 = removeBodyCalls
  const activeNow = this._activeDynamicIds.size
  const out = rawBudget.call(this)
  const elapsed = nowMs() - t0
  budgetCallsTotal++
  if (activeNow > this._physicsBodyBudget) budgetSweeps++
  if (activeNow > budgetActivePeak) budgetActivePeak = activeNow
  budgetDeactivated += deactivateCalls - d0
  budgetRemoved += removeBodyCalls - r0
  if (runtime.currentTick > WARM_TICKS) budgetSamples.push(elapsed)
  return out
}

const stepSamples = []
const syncSamples = []
const lodSamples = []
const lodBodyOpSamples = []
let lodCalls = 0
const totalTicks = WARM_TICKS + MEASURE_TICKS
for (let tick = 1; tick <= totalTicks; tick++) {
  const measuring = tick > WARM_TICKS
  runtime.currentTick = tick
  if (PLAYER_SPEED !== 0) placePlayers(tick)
  const t0 = nowMs()
  world.step(DT)
  const t1 = nowMs()
  runtime._syncDynamicBodies()
  const t2 = nowMs()
  if (tick % LOD_INTERVAL === 0) {
    const opsBefore = bodyOpMs
    const addsBefore = addBodyCalls
    const remsBefore = removeBodyCalls
    const mtBefore = motionTypeCalls
    runtime._tickPhysicsLOD(players)
    lodCalls++
    if (measuring) {
      lodSamples.push(nowMs() - t2)
      lodBodyOpSamples.push(bodyOpMs - opsBefore)
      lodAdds = (lodAdds || 0) + (addBodyCalls - addsBefore)
      lodRemoves = (lodRemoves || 0) + (removeBodyCalls - remsBefore)
      lodRebinds = (lodRebinds || 0) + (motionTypeCalls - mtBefore)
    }
  }
  if (measuring) {
    stepSamples.push(t1 - t0)
    syncSamples.push(t2 - t1)
  }
}
var lodAdds = lodAdds || 0
var lodRemoves = lodRemoves || 0
var lodRebinds = lodRebinds || 0

const stepStat = stats(stepSamples)
const syncStat = stats(syncSamples)
const lodStat = stats(lodSamples)
const budgetStat = stats(budgetSamples)
const lodOpStat = stats(lodBodyOpSamples)
let stepOutliers = 0
for (const v of stepSamples) if (v > OUTLIER_MS) stepOutliers++
const amort = (st) => (st.n * st.mean) / MEASURE_TICKS
const frameTotal = stepStat.mean + syncStat.mean + amort(lodStat)

let resident = 0
let orphanMaps = 0
const hashParts = []
for (const e of entities) {
  const hasBody = e._physicsBodyId !== undefined
  if (hasBody) {
    resident++
    if (runtime._physicsBodyToEntityId.get(e._physicsBodyId) !== e.id) orphanMaps++
  }
  hashParts.push(
    e.position[0], e.position[1], e.position[2],
    e.rotation[0], e.rotation[1], e.rotation[2], e.rotation[3],
    e.velocity[0], e.velocity[1], e.velocity[2],
    hasBody ? 1 : 0,
    e._bodyTier === 'physical' ? 2 : e._bodyTier === 'kinematic' ? 1 : 0,
  )
}
const hashFloats = new Float64Array(hashParts)
const stateHash = fnv1aBytes(new Uint8Array(hashFloats.buffer))

expect('lodCalls', lodCalls, v => v >= 4)
expect('budgetRemovedBodies', budgetRemoved, v => v === 0)
expect('residentBodies', resident, v => v > 0)
expect('orphanBodyMaps', orphanMaps, v => v === 0)
expect('stateHash', stateHash, v => EXPECT_HASH === null || String(v) === String(EXPECT_HASH))
if (REQUIRE_ENGAGED) expect('budgetSweeps', budgetSweeps, v => v >= 1)

emit(TAG + ' population=' + POPULATION + ' players=' + PLAYER_COUNT + ' playerSpeed=' + PLAYER_SPEED + ' radius=' + RADIUS + ' budget=' + BUDGET + ' lodInterval=' + LOD_INTERVAL + ' warm=' + WARM_TICKS + ' ticks=' + MEASURE_TICKS + ' dt=' + DT)
emit(TAG + ' step   ms/frame    min=' + fmt(stepStat.min) + ' median=' + fmt(stepStat.median) + ' p95=' + fmt(stepStat.p95) + ' mean=' + fmt(stepStat.mean) + ' max=' + fmt(stepStat.max) + ' n=' + stepStat.n + ' over' + OUTLIER_MS + 'ms=' + stepOutliers)
emit(TAG + ' sync   ms/frame    min=' + fmt(syncStat.min) + ' median=' + fmt(syncStat.median) + ' p95=' + fmt(syncStat.p95) + ' mean=' + fmt(syncStat.mean) + ' max=' + fmt(syncStat.max) + ' n=' + syncStat.n)
emit(TAG + ' lod    ms/call     min=' + fmt(lodStat.min) + ' median=' + fmt(lodStat.median) + ' p95=' + fmt(lodStat.p95) + ' mean=' + fmt(lodStat.mean) + ' max=' + fmt(lodStat.max) + ' n=' + lodStat.n + ' amortizedMsPerFrame=' + fmt(amort(lodStat)))
emit(TAG + ' lod    bodyOps ms  mean=' + fmt(lodOpStat.mean) + ' max=' + fmt(lodOpStat.max) + ' adds=' + lodAdds + ' removes=' + lodRemoves + ' rebinds=' + lodRebinds)
emit(TAG + ' budget ms/call     min=' + fmt(budgetStat.min) + ' median=' + fmt(budgetStat.median) + ' p95=' + fmt(budgetStat.p95) + ' mean=' + fmt(budgetStat.mean) + ' max=' + fmt(budgetStat.max) + ' n=' + budgetStat.n + ' amortizedMsPerFrame=' + fmt(amort(budgetStat)))
emit(TAG + ' budget engagedCalls=' + budgetSweeps + '/' + budgetCallsTotal + ' activeIdsPeak=' + budgetActivePeak + ' deactivated=' + budgetDeactivated + ' removed=' + budgetRemoved)
emit(TAG + ' lodScanMeanMsPerCall=' + fmt(lodStat.mean - budgetStat.mean - lodOpStat.mean) + ' frameTotalMeanMs=' + fmt(frameTotal))
emit(TAG + ' resident=' + resident + ' activeIds=' + runtime._activeDynamicIds.size + ' sleepingIds=' + runtime._sleepingDynamicIds.size + ' worldBodies=' + world.physicsSystem.GetNumBodies() + ' joltActive=' + world.physicsSystem.GetNumActiveBodies() + ' dropped=0')
emit(TAG + ' stateHash=' + stateHash)
emit(TAG + ' RESULT: ' + (failures.length === 0 ? 'PASS' : 'FAIL ' + failures.join(', ')))

const outPath = OUT ? path.resolve(repoRoot, OUT) : path.join(witnessOutDir, 'physics-lod-budget-cpu-witness.txt')
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, lines.join('\n') + '\n')
process.exit(failures.length === 0 ? 0 : 1)
