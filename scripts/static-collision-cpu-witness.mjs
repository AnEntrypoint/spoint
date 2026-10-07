import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createNetServer } from 'node:net'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

process.env.SPOINT_NO_WATCH = '1'
process.env.SPOINT_SKIP_PREWARM = '1'
if (!process.env.GM_PROFILE) process.env.GM_PROFILE = '1'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const eq = a.indexOf('=')
  if (eq < 0) return [a.replace(/^--/, ''), 'true']
  return [a.slice(2, eq), a.slice(eq + 1)]
}))
const sleep = ms => new Promise(r => setTimeout(r, ms))

const MODE = args.mode || 'server'
const ARM = args.arm || 'run'
const OUT = args.out || null
const EXPECT = args.expect || null
const PLAYERS = Number(args.players || 4)
const TICKS = Number(args.ticks || 400)
const COL_STATICS = Number(args.colStatics || 500)
const COL_MOVERS = Number(args.colMovers || 16)
const COL_TICKS = Number(args.colTicks || 1000)
const MICRO_ADDS = Number(args.microAdds || 2000)
const MICRO_MOVES = Number(args.microMoves || 2000)
const MICRO_REMOVES = Number(args.microRemoves || 2000)
const MICRO_TIME_CALLS = Number(args.microTimeCalls || 20000)
const MICRO_JITTER = Number(args.microJitter || 0)
const WORLD = args.world || 'tps-game'
const WALK_STEP_M = Number(args.walkStepM || 0)
const WALK_EVERY_MS = Number(args.walkEveryMs || 100)
const SPREAD_M = Number(args.spreadM || 0)
const BUTTONS = Number(args.buttons || 0)
const BOXES = Number(args.boxes || 0)
const COL_COUNT_MAP = args.colCountMap !== '0'

const failures = []
function expect(cond, label) {
  if (!cond) failures.push(label)
  return cond
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createNetServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
  })
}

const { fnv1aBytes, fnv1aString } = await import('../src/shared/fnv1a.js')

function hashFloats(values) {
  const f = new Float64Array(values.length)
  for (let i = 0; i < values.length; i++) f[i] = values[i]
  return fnv1aBytes(new Uint8Array(f.buffer))
}

function hashString(s) { return fnv1aString(s) }

async function runMicro() {
  const { PhysicsWorld } = await import('../src/physics/World.js')
  const { STATIC_TILE_M, STATIC_TILE_MARGIN_M } = await import('../src/physics/StaticTileIndex.js')

  const world = await new PhysicsWorld({ gravity: [0, -18, 0] }).init()
  const J = world.Jolt
  const out = { arm: ARM, mode: 'micro' }

  const aaboxCount = { n: 0 }
  const triCount = { n: 0 }
  const origAABox = J.AABox
  const origTri = J.ShapeGetTriangles
  J.AABox = function (...a) { aaboxCount.n++; return new origAABox(...a) }
  J.ShapeGetTriangles = function (...a) { triCount.n++; return new origTri(...a) }

  const tileM = STATIC_TILE_M
  const marginM = STATIC_TILE_MARGIN_M
  const placed = []

  function spread(i, n) {
    const side = Math.ceil(Math.sqrt(n))
    const gx = i % side, gz = (i / side) | 0
    return [(gx - side / 2) * 7.0, 0.0, (gz - side / 2) * 7.0]
  }

  for (let i = 0; i < 400; i++) placed.push(world.addStaticBox([0.6, 0.6, 0.6], spread(i, 400), [0, 0, 0, 1]))

  const index = world.enableStaticTiles()
  expect(!!index, 'static tile index created on a real PhysicsWorld')

  let updateCalls = 0
  let updateLive = 0
  const stiSrc = readFileSync(resolve(SDK_ROOT, 'src/physics/StaticTileIndex.js'), 'utf8')
  const KEY_CONCATS_PER_UPDATE = stiSrc.includes("minX + ','") ? 19 : 0
  const origUpdate = index.update
  const spanHistory = new Map()
  let unchangedSpanUpdates = 0
  let instrumentedConcats = 0

  index.update = function (id) {
    updateCalls++
    const b = world.bodies.get(id)
    const live = !!b && b.GetMotionType() === J.EMotionType_Static && !b.IsSensor()
    if (!live) return origUpdate.call(this, id)
    updateLive++
    instrumentedConcats += KEY_CONCATS_PER_UPDATE
    const bb = b.GetWorldSpaceBounds(), mn = bb.mMin, mx = bb.mMax
    const tx0 = Math.floor((mn.GetX() - marginM) / tileM), tx1 = Math.floor((mx.GetX() + marginM) / tileM)
    const tz0 = Math.floor((mn.GetZ() - marginM) / tileM), tz1 = Math.floor((mx.GetZ() + marginM) / tileM)
    const excluded = mn.GetY() > 10000 || mx.GetY() < -10000
    const prev = spanHistory.get(id)
    const span = excluded ? null : [tx0, tx1, tz0, tz1]
    if (prev && span && prev[0] === span[0] && prev[1] === span[1] && prev[2] === span[2] && prev[3] === span[3]) unchangedSpanUpdates++
    spanHistory.set(id, span)
    return origUpdate.call(this, id)
  }

  function fingerprint(label) {
    const rows = []
    const membership = new Map()
    let minTx = Infinity, maxTx = -Infinity, minTz = Infinity, maxTz = -Infinity
    for (const id of world.bodies.keys()) {
      const b = world.bodies.get(id)
      if (!b) continue
      const bb = b.GetWorldSpaceBounds(), mn = bb.mMin, mx = bb.mMax
      minTx = Math.min(minTx, Math.floor((mn.GetX() - marginM) / tileM)); maxTx = Math.max(maxTx, Math.floor((mx.GetX() + marginM) / tileM))
      minTz = Math.min(minTz, Math.floor((mn.GetZ() - marginM) / tileM)); maxTz = Math.max(maxTz, Math.floor((mx.GetZ() + marginM) / tileM))
    }
    if (!Number.isFinite(minTx)) return { label, tiles: 0, hash: 0, vertsTotal: 0, membership: [] }
    let vertsTotal = 0
    const hashes = []
    for (let tx = minTx; tx <= maxTx; tx++) {
      for (let tz = minTz; tz <= maxTz; tz++) {
        const t = index.get(tx, tz, 1e15)
        vertsTotal += t.verts ? t.verts.length : 0
        hashes.push(tx, tz, t.hash >>> 0, t.verts ? t.verts.length : 0)
        for (const bid of t.bodies) {
          let m = membership.get(bid)
          if (!m) { m = []; membership.set(bid, m) }
          m.push(tx, tz)
        }
      }
    }
    const memberRows = [...membership.entries()].sort((a, b) => a[0] - b[0]).map(([id, m]) => `${id}:${m.join(',')}`)
    return {
      label,
      tiles: hashes.length / 4,
      hash: hashFloats(hashes),
      vertsTotal,
      membership: memberRows,
      membershipHash: hashString(memberRows.join('|')),
    }
  }

  const seq = {}
  seq.afterBuild = fingerprint('after-initial-build')

  const added = []
  for (let i = 0; i < MICRO_ADDS; i++) added.push(world.addStaticBox([0.4, 0.4, 0.4], spread(i, MICRO_ADDS), [0, 0, 0, 1]))
  seq.afterAdds = fingerprint('after-adds')

  for (let k = 0; k < MICRO_MOVES; k++) {
    const id = placed[k % placed.length]
    const p = spread(k, MICRO_MOVES)
    world.setBodyPosition(id, [p[0] * 1.7, 0.0, p[2] * 1.7])
  }
  seq.afterMoves = fingerprint('after-moves')

  for (let k = 0; k < MICRO_REMOVES; k++) {
    const id = added[k]
    if (id != null) world.removeBody(id)
  }
  seq.afterRemoves = fingerprint('after-removes')

  let jitterMs = 0, jitterUpdates = 0, jitterUnchanged = 0
  if (MICRO_JITTER > 0) {
    const jitterBase = []
    for (let i = 0; i < placed.length; i++) {
      const id = placed[i]
      const b = world.bodies.get(id)
      const p = b.GetCenterOfMassPosition()
      jitterBase.push([p.GetX(), p.GetY(), p.GetZ()])
    }
    const spanBefore = unchangedSpanUpdates
    const jt0 = performance.now()
    for (let k = 0; k < MICRO_JITTER; k++) {
      const i = k % placed.length
      const base = jitterBase[i]
      const wobble = ((k % 7) - 3) * 0.15
      world.setBodyPosition(placed[i], [base[0] + wobble, base[1], base[2] - wobble])
    }
    jitterMs = Number((performance.now() - jt0).toFixed(3))
    jitterUpdates = MICRO_JITTER
    jitterUnchanged = unchangedSpanUpdates - spanBefore
  }
  seq.afterJitter = MICRO_JITTER > 0 ? fingerprint('after-jitter') : null

  const movedWithin = placed[0]
  const homePos = spread(0, 400)
  world.setBodyPosition(movedWithin, [homePos[0] + 0.35, 0, homePos[2] + 0.35])
  seq.afterMoveWithinTile = fingerprint('after-move-within-tile')

  world.setBodyPosition(movedWithin, [homePos[0] + 4 * tileM, 0, homePos[2] + 4 * tileM])
  seq.afterMoveAcrossTile = fingerprint('after-move-across-tile')

  const shapeChangedId = world.addStaticBox([0.3, 0.3, 0.3], [homePos[0], 0, homePos[2]], [0, 0, 0, 1])
  seq.afterShapeAdd = fingerprint('after-shape-add')
  world.removeBody(shapeChangedId)
  seq.afterShapeRemove = fingerprint('after-shape-remove')

  out.tileUpdateCalls = updateCalls
  out.tileUpdateLive = updateLive
  out.tileUnchangedSpanUpdates = unchangedSpanUpdates
  out.tileUnchangedSpanFraction = Number((unchangedSpanUpdates / Math.max(1, updateLive)).toFixed(4))
  out.tileStringConcats = instrumentedConcats
  out.tileJitterUpdates = jitterUpdates
  out.tileJitterUnchangedSpan = jitterUnchanged
  out.tileJitterFraction = Number((jitterUnchanged / Math.max(1, jitterUpdates)).toFixed(4))
  out.tileJitterMs = jitterMs
  out.tileJitterUsPerUpdate = jitterUpdates ? Number((jitterMs * 1000 / jitterUpdates).toFixed(4)) : 0
  out.tileTriHits = index.stats.triHits
  out.tileTriMisses = index.stats.triMisses
  out.tileAABoxAllocations = aaboxCount.n
  out.tileShapeGetTrianglesCalls = triCount.n
  out.tileBuilds = index.stats.builds
  out.tileBuildMs = Number(index.stats.buildMs.toFixed(3))
  out.tileTriangles = index.stats.triangles
  out.tileBodiesPerBuild = Number((out.tileAABoxAllocations / Math.max(1, out.tileBuilds)).toFixed(2))
  out.tileMsPerBuild = Number((out.tileBuildMs / Math.max(1, out.tileBuilds)).toFixed(5))

  const clean = { update: 0, build: 0 }
  index.update = origUpdate
  J.AABox = origAABox
  J.ShapeGetTriangles = origTri

  const timingIds = world.bodies.keys()
  const timingList = [...timingIds].slice(0, Math.min(64, world.bodies.size))
  const updateSamples = []
  for (let pass = 0; pass < 6; pass++) {
    const t0 = performance.now()
    for (let i = 0; i < MICRO_TIME_CALLS; i++) index.update(timingList[i % timingList.length])
    updateSamples.push((performance.now() - t0) * 1000 / MICRO_TIME_CALLS)
  }
  updateSamples.sort((a, b) => a - b)
  clean.update = Number(updateSamples[0].toFixed(4))
  out.tileUpdateUsPerCallMin = clean.update
  out.tileUpdateUsPerCallMedian = Number(updateSamples[3].toFixed(4))

  const getSamples = []
  const bspan = 6
  for (let pass = 0; pass < 6; pass++) {
    let buildTicks = 0
    const bt0 = performance.now()
    for (let tx = -bspan; tx <= bspan; tx++) for (let tz = -bspan; tz <= bspan; tz++) { index.get(tx, tz, 1e15); buildTicks++ }
    getSamples.push((performance.now() - bt0) * 1000 / buildTicks)
  }
  getSamples.sort((a, b) => a - b)
  clean.build = Number(getSamples[0].toFixed(4))
  out.tileGetUsPerCallMin = clean.build
  out.tileGetUsPerCallMedian = Number(getSamples[3].toFixed(4))

  const forcedSamples = []
  for (let pass = 0; pass < 6; pass++) {
    let forced = 0
    const ft0 = performance.now()
    for (let tx = -bspan; tx <= bspan; tx++) for (let tz = -bspan; tz <= bspan; tz++) {
      const t = index.get(tx, tz, 1e15)
      t.builtVersion = -1
      index.get(tx, tz, 1e15)
      forced++
    }
    forcedSamples.push((performance.now() - ft0) * 1000 / forced)
  }
  forcedSamples.sort((a, b) => a - b)
  out.tileForcedBuildUsPerCallMin = Number(forcedSamples[0].toFixed(4))
  out.tileForcedBuildUsPerCallMedian = Number(forcedSamples[3].toFixed(4))
  out.tileForcedBuildUsPerCallMax = Number(forcedSamples[5].toFixed(4))

  const keySets = []
  for (const id of timingList) {
    const b = world.bodies.get(id)
    if (!b) continue
    const bb = b.GetWorldSpaceBounds(), mn = bb.mn || bb.mMin, mx = bb.mx || bb.mMax, r = b.GetRotation()
    keySets.push([mn.GetX(), mn.GetY(), mn.GetZ(), mx.GetX(), mx.GetY(), mx.GetZ(), r.GetX(), r.GetY(), r.GetZ(), r.GetW()])
  }
  const KEY_N = Math.max(1, keySets.length)
  const stringSamples = [], compareSamples = []
  const strMap = new Map()
  const cmpArr = new Float64Array(16)
  for (let pass = 0; pass < 6; pass++) {
    let t0 = performance.now()
    for (let i = 0; i < MICRO_TIME_CALLS; i++) {
      const s = keySets[i % KEY_N]
      const key = s[0] + ',' + s[1] + ',' + s[2] + ',' + s[3] + ',' + s[4] + ',' + s[5] + ',' + s[6] + ',' + s[7] + ',' + s[8] + ',' + s[9]
      if (strMap.get(i % KEY_N) !== key) strMap.set(i % KEY_N, key)
    }
    stringSamples.push((performance.now() - t0) * 1000 / MICRO_TIME_CALLS)
    t0 = performance.now()
    for (let i = 0; i < MICRO_TIME_CALLS; i++) {
      const s = keySets[i % KEY_N]
      if (cmpArr[0] === s[0] && cmpArr[1] === s[1] && cmpArr[2] === s[2] && cmpArr[3] === s[3] && cmpArr[4] === s[4] && cmpArr[5] === s[5] && cmpArr[6] === s[6] && cmpArr[7] === s[7] && cmpArr[8] === s[8] && cmpArr[9] === s[9]) continue
      for (let q = 0; q < 10; q++) cmpArr[q] = s[q]
    }
    compareSamples.push((performance.now() - t0) * 1000 / MICRO_TIME_CALLS)
  }
  stringSamples.sort((a, b) => a - b); compareSamples.sort((a, b) => a - b)
  out.keyStringUsPerOp = Number(stringSamples[0].toFixed(5))
  out.keyCompareUsPerOp = Number(compareSamples[0].toFixed(5))
  out.tileUpdateUsPerCall = clean.update
  out.tileGetUsPerCall = clean.build

  out.sequence = {}
  for (const [k, v] of Object.entries(seq)) out.sequence[k] = { label: v.label, tiles: v.tiles, hash: v.hash, vertsTotal: v.vertsTotal, membershipHash: v.membershipHash }

  out.microMembershipSamples = {}
  for (const key of ['afterBuild', 'afterMoves', 'afterMoveAcrossTile', 'afterJitter']) {
    if (!seq[key]) continue
    out.microMembershipSamples[key] = seq[key].membership.slice(0, 24)
  }

  index.destroy()
  world.destroy?.()
  return out
}

class CountingMap extends Map {
  constructor(metrics) { super(); this.m = metrics }
  get(k) { this.m.mapGet++; return super.get(k) }
  set(k, v) { this.m.mapSet++; if (!this.m.seen.has(v)) { this.m.seen.add(v); this.m.newArrays++ } return super.set(k, v) }
}

async function runCollisionFixture() {
  const { mixinTick } = await import('../src/apps/AppRuntimeTick.js')
  const { COLLISION_GRID_CODE_VERSION } = await import('../src/shared/cacheCodeVersions.js')

  const rt = {
    _timers: new Map(),
    _updateList: [],
    _entityTickDivisor: 1,
    _physicsLODInterval: 1,
    _interactableIds: new Set(),
    _proximityWatches: new Map(),
    _playerContactWatches: new Map(),
    _interactCooldowns: new Map(),
    _collisionEntities: [],
    _activeDynamicIds: new Set(),
    _respawnTimer: new Map(),
    currentTick: 0,
    deltaTime: 1 / 64,
    elapsed: 0,
    events: [],
    fireEvent(id, name, payload) { if (name === 'onCollision') this.events.push([id, payload.id, payload.point[0], payload.point[1], payload.point[2], payload.normal[0], payload.normal[1], payload.normal[2], payload.impactSpeed]) },
    getPlayers() { return [] },
    _syncDynamicBodies() {}, _tickPhysicsLOD() {}, _tickRespawn() {},
    _spatialSync() {}, _syncPlayerIndex() {}, _tickInteractables() {},
    _tickProximityWatches() {}, _tickPlayerContactWatches() {}, _tickAttachments() {},
  }
  mixinTick(rt)
  rt._syncDynamicBodies = () => {}
  rt.getPlayers = () => []
  rt._tickPhysicsLOD = () => {}
  rt._tickRespawn = () => {}
  rt._spatialSync = () => {}
  rt._syncPlayerIndex = () => {}
  rt._tickInteractables = () => {}
  rt._tickProximityWatches = () => {}
  rt._tickPlayerContactWatches = () => {}
  rt._tickAttachments = () => {}

  let seed = 0x9e3779b9
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }

  const list = []
  for (let i = 0; i < COL_STATICS; i++) {
    list.push({ id: 's' + String(i).padStart(5, '0'), position: [rnd() * 320 - 160, rnd() * 4, rnd() * 320 - 160], rotation: [0, 0, 0, 1], scale: [1, 1, 1], velocity: [0, 0, 0], collider: { type: 'sphere', radius: 0.5 } })
  }
  const movers = []
  for (let i = 0; i < COL_MOVERS; i++) {
    movers.push({ id: 'm' + String(i).padStart(5, '0'), position: [rnd() * 320 - 160, rnd() * 4, rnd() * 320 - 160], rotation: [0, 0, 0, 1], scale: [1, 1, 1], velocity: [rnd() * 2 - 1, 0, rnd() * 2 - 1], collider: { type: 'sphere', radius: 0.6 } })
  }
  rt._collisionEntities = list.concat(movers)

  const metrics = { mapGet: 0, mapSet: 0, newArrays: 0, seen: new Set() }
  rt._colBuckets = COL_COUNT_MAP ? new CountingMap(metrics) : new Map()
  rt._colGridVersion = null

  const all = rt._collisionEntities
  const homeStatic = list.map(e => e.position.slice())
  const homeMover = movers.map(e => e.position.slice())
  const homeVel = movers.map(e => e.velocity.slice())
  const homeRadius = all.map(e => e.collider.radius)

  function restoreHomes() {
    rt._collisionEntities.length = 0
    for (const e of list) rt._collisionEntities.push(e)
    for (const e of movers) rt._collisionEntities.push(e)
    for (let i = 0; i < list.length; i++) { const p = homeStatic[i], q = list[i].position; q[0] = p[0]; q[1] = p[1]; q[2] = p[2] }
    for (let i = 0; i < movers.length; i++) { const p = homeMover[i], q = movers[i].position; q[0] = p[0]; q[1] = p[1]; q[2] = p[2]; movers[i].velocity[0] = homeVel[i][0]; movers[i].velocity[2] = homeVel[i][2] }
    for (let i = 0; i < all.length; i++) { all[i].collider.radius = homeRadius[i]; delete all[i].collider._cachedRadius }
    for (const e of all) e._colCache = undefined
    rt._colGridVersion = null
  }

  function runPass(ticks, uncached, before) {
    const parts = []
    for (let tick = 1; tick <= ticks; tick++) {
      rt.currentTick = tick
      if (before) before(tick)
      for (let i = 0; i < movers.length; i++) {
        const m = movers[i]
        m.position[0] += m.velocity[0] * (1 / 64)
        m.position[2] += m.velocity[2] * (1 / 64)
        if (m.position[0] > 160 || m.position[0] < -160) m.velocity[0] *= -1
        if (m.position[2] > 160 || m.position[2] < -160) m.velocity[2] *= -1
      }
      if (uncached) for (let i = 0; i < all.length; i++) all[i]._colCache = undefined
      rt.events.length = 0
      rt._tickCollisions()
      let h = 0
      for (const e of rt.events) h = (h * 31 + hashFloats(e)) >>> 0
      parts.push(tick, rt.events.length, h)
    }
    return parts
  }

  const eventHashParts = []
  restoreHomes()
  runPass(128, false, null)
  metrics.mapGet = 0
  metrics.mapSet = 0
  metrics.newArrays = 0
  metrics.seen.clear()
  const t0 = performance.now()
  const cachedParts = runPass(COL_TICKS, false, null)
  const t1 = performance.now()
  const measuredMapGetPerTick = Number((metrics.mapGet / COL_TICKS).toFixed(2))
  const measuredMapSetPerTick = Number((metrics.mapSet / COL_TICKS).toFixed(2))
  const measuredNewArraysPerTick = Number((metrics.newArrays / COL_TICKS).toFixed(2))
  const measuredRebucketsPerTick = Number((rt._lastColGridRebuckets / COL_TICKS).toFixed(2))
  const measuredMsPerTick = Number(((t1 - t0) / COL_TICKS).toFixed(5))
  for (const v of cachedParts) eventHashParts.push(v)

  restoreHomes()
  runPass(128, true, null)
  const uncachedParts = runPass(COL_TICKS, true, null)
  const streamCached = hashFloats(cachedParts)
  const streamUncached = hashFloats(uncachedParts)
  expect(streamCached === streamUncached, `cached event stream identical to forced-uncached over ${COL_TICKS} ticks`)

  const MUT_TICKS = 64
  function mutPhase(label, before) {
    restoreHomes()
    const a = runPass(MUT_TICKS, false, before)
    restoreHomes()
    const b = runPass(MUT_TICKS, true, before)
    const ha = hashFloats(a), hb = hashFloats(b)
    expect(ha === hb, `cached event stream identical under ${label}`)
    return ha >>> 0
  }

  const teleported = list[7]
  const teleportHome = homeStatic[7]
  const mutTeleportHash = mutPhase('teleport a static every 8th tick', tick => {
    if (tick % 8 !== 0) return
    teleported.position[0] = teleportHome[0] + 41
    teleported.position[2] = teleportHome[2] - 27
  })

  const extraEntity = { id: 'x00001', position: [homeStatic[3][0] + 0.4, homeStatic[3][1], homeStatic[3][2] + 0.4], rotation: [0, 0, 0, 1], scale: [1, 1, 1], velocity: [0, 0, 0], collider: { type: 'sphere', radius: 0.6 } }
  const mutAddRemoveHash = mutPhase('add an entity at tick 16 and remove it at tick 40', tick => {
    if (tick === 16) rt._collisionEntities.push(extraEntity)
    else if (tick === 40) { const at = rt._collisionEntities.indexOf(extraEntity); if (at >= 0) rt._collisionEntities.splice(at, 1) }
  })

  const removed = list[11]
  const mutRemoveHash = mutPhase('remove an entity at tick 12', tick => {
    if (tick !== 12) return
    const at = rt._collisionEntities.indexOf(removed)
    if (at >= 0) rt._collisionEntities.splice(at, 1)
  })

  const resized = list[19]
  const mutColliderSizeHash = mutPhase('change a collider radius every 4th tick', tick => {
    if (tick % 4 !== 0) return
    resized.collider.radius = 0.5 + (tick % 5) * 0.35
    delete resized.collider._cachedRadius
  })

  restoreHomes()
  runPass(MUT_TICKS, false, null)
  const moverIds = new Set(movers.map(m => m.id))
  let pairStaticStatic = 0, pairStaticMover = 0, pairMoverMover = 0
  const pairTests = (() => {
    let n = 0
    const buckets = rt._colBuckets
    for (const a of all) {
      const acx = Math.floor(a.position[0] / 4), acz = Math.floor(a.position[2] / 4)
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const cell = buckets.get((acx + dx) * 65536 + (acz + dz))
        if (!cell) continue
        const inner = cell.list || cell
        n += inner.length
        for (const b of inner) {
          if (moverIds.has(a.id)) { if (moverIds.has(b.id)) pairMoverMover++; else pairStaticMover++ }
          else if (moverIds.has(b.id)) pairStaticMover++
          else pairStaticStatic++
        }
      }
    }
    return n
  })()

  let overlapStaticStatic = 0, overlapAny = 0
  for (let i = 0; i < all.length; i++) {
    const a = all[i], ar = a._cachedColR || 0
    for (let j = i + 1; j < all.length; j++) {
      const b = all[j]
      const dx = b.position[0] - a.position[0], dy = b.position[1] - a.position[1], dz = b.position[2] - a.position[2]
      const rr = ar + (b._cachedColR || 0)
      if (dx * dx + dy * dy + dz * dz < rr * rr) {
        overlapAny++
        if (!moverIds.has(a.id) && !moverIds.has(b.id)) overlapStaticStatic++
      }
    }
  }

  let cachedLastTick = 0
  for (const a of all) if (a._colCache !== undefined && a._colCache.grid === rt._colGridSerial) cachedLastTick++

  const out = {
    colStatics: COL_STATICS,
    colMovers: COL_MOVERS,
    colTicks: COL_TICKS,
    colGridCodeVersion: COLLISION_GRID_CODE_VERSION,
    colMapGetPerTick: measuredMapGetPerTick,
    colMapSetPerTick: measuredMapSetPerTick,
    colNewArraysPerTick: measuredNewArraysPerTick,
    colRebucketsPerTick: measuredRebucketsPerTick,
    colPairTestsLastTick: pairTests,
    colPairStaticStatic: pairStaticStatic,
    colPairStaticMover: pairStaticMover,
    colPairMoverMover: pairMoverMover,
    colOverlapPairsAny: overlapAny,
    colOverlapPairsStaticStatic: overlapStaticStatic,
    colMsPerTick: measuredMsPerTick,
    colCachedFractionLastTick: Number((cachedLastTick / Math.max(1, all.length)).toFixed(4)),
    colEventStreamHash: hashFloats(eventHashParts),
    colEventStreamLen: eventHashParts.length,
    colEventStreamHashUncachedControl: streamUncached >>> 0,
    colMutTeleportHash: mutTeleportHash,
    colMutAddRemoveHash: mutAddRemoveHash,
    colMutRemoveHash: mutRemoveHash,
    colMutColliderSizeHash: mutColliderSizeHash,
  }
  return out
}

async function runServer() {
  const { createServer } = await import('../src/sdk/server.js')
  const { PhysicsNetworkClient } = await import('../src/client/PhysicsNetworkClient.js')
  const { loadWorldModule } = await import('../src/sdk/WorldLocator.js')
  const { _ringCache, _spatialCache, _cellCenterWorld } = await import('../src/sdk/TickHandlerAOI.js')
  const { neighborCells, packCellKey } = await import('../src/terrain/CubeSphereCells.js')

  const port = await freePort()
  const worldDef = await loadWorldModule(resolve(SDK_ROOT, 'apps', 'world', WORLD + '.js'))
  const server = await createServer({
    port,
    tickRate: worldDef.tickRate || 60,
    appsDirs: [resolve(SDK_ROOT, 'apps'), resolve(SDK_ROOT, 'src', 'stdlib-apps')],
    sdkRoot: SDK_ROOT,
    gravity: worldDef.gravity,
    staticDirs: [],
    storageDir: resolve(SDK_ROOT, 'data', 'static-collision-cpu-witness'),
  })
  await server.loadWorld(worldDef)
  await server.start()
  const runtime = server.runtime
  const physics = server.physics
  const url = `ws://127.0.0.1:${port}/ws`

  const clients = []
  for (let i = 0; i < PLAYERS; i++) clients.push(new PhysicsNetworkClient({ url, predictionEnabled: false, smoothInterpolation: false, webTransport: { enabled: false } }))
  const connectFailures = []
  await Promise.all(clients.map(c => c.connect().catch(e => connectFailures.push(e))))
  if (connectFailures.length) { console.error(`[static-collision] ${connectFailures.length} of ${clients.length} client(s) failed to connect to ${url}: ${connectFailures[0].name}: ${connectFailures[0].message}`); process.exit(1) }
  const tJoin = Date.now()
  while (server.playerManager.getConnectedPlayers().length < PLAYERS && Date.now() - tJoin < 30000) await sleep(50)
  for (let i = 0; i < clients.length; i++) clients[i].startInputLoop(() => ({ forward: true, sprint: false, yaw: i, pitch: 0 }))
  await sleep(2500)

  let marchSteps = 0
  const march = WALK_STEP_M > 0 ? setInterval(() => {
    marchSteps++
    const ps = server.playerManager.getConnectedPlayers()
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i]
      const at = p.state?.position
      if (!at) continue
      const next = SPREAD_M > 0
        ? [at[0] + WALK_STEP_M, at[1], p._baseZ ?? at[2]]
        : [at[0] + WALK_STEP_M, at[1], at[2] + WALK_STEP_M * 0.25 * i]
      const g = server.physics.terrainHeightAt ? server.physics.terrainHeightAt(next[0], next[2]) : null
      if (Number.isFinite(g)) next[1] = g + 1.2
      p.state.position[0] = next[0]; p.state.position[1] = next[1]; p.state.position[2] = next[2]
      try { server.physicsIntegration.setPlayerPosition(p.id, next) } catch {}
    }
  }, WALK_EVERY_MS) : null

  if (SPREAD_M > 0) {
    const ps = server.playerManager.getConnectedPlayers()
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i]
      const at = p.state?.position
      if (!at) continue
      p._baseZ = at[2] + i * SPREAD_M
      const next = [at[0], at[1], p._baseZ]
      const g = server.physics.terrainHeightAt ? server.physics.terrainHeightAt(next[0], next[2]) : null
      if (Number.isFinite(g)) next[1] = g + 1.2
      p.state.position[0] = next[0]; p.state.position[1] = next[1]; p.state.position[2] = next[2]
      try { server.physicsIntegration.setPlayerPosition(p.id, next) } catch {}
    }
    await sleep(1200)
  }

  if (BUTTONS > 0) {
    const spawn = worldDef.spawnPoint || [0, 2, 0]
    const side = Math.ceil(Math.sqrt(BUTTONS))
    for (let i = 0; i < BUTTONS; i++) {
      const gx = i % side, gz = (i / side) | 0
      const x = spawn[0] + (gx - side / 2) * 2.5
      const z = spawn[2] + (gz - side / 2) * 2.5
      const g = server.physics.terrainHeightAt(x, z)
      const y = (Number.isFinite(g) ? g : spawn[1]) + 0.6
      runtime.spawnEntity(null, { app: 'button', position: [x, y, z], config: { radius: 3 } })
    }
    await sleep(2500)
  }

  if (BOXES > 0) {
    const spawn = worldDef.spawnPoint || [0, 2, 0]
    const side = Math.ceil(Math.sqrt(BOXES))
    for (let i = 0; i < BOXES; i++) {
      const gx = i % side, gz = (i / side) | 0
      const x = spawn[0] + (gx - side / 2) * 2.5
      const z = spawn[2] + (gz - side / 2) * 2.5
      const g = server.physics.terrainHeightAt(x, z)
      const y = (Number.isFinite(g) ? g : spawn[1]) + 0.6
      runtime.spawnEntity(null, { app: 'destructible-box', position: [x, y, z], config: { hx: 0.3, hy: 0.3, hz: 0.3 } })
    }
    await sleep(2500)
  }

  let tilesEnabled = true
  const tTiles = Date.now()
  while (!physics._staticTiles && Date.now() - tTiles < 30000) await sleep(50)
  if (!physics._staticTiles) tilesEnabled = false

  const tileMetrics = { updateCalls: 0, updateLive: 0, unchangedSpan: 0, concats: 0, aabox: 0, tris: 0, builds0: 0, buildMs0: 0, updateMs: 0 }
  const spanHistory = new Map()
  const J = physics.Jolt
  const origAABox = J.AABox
  const origTri = J.ShapeGetTriangles
  J.AABox = function (...a) { tileMetrics.aabox++; return new origAABox(...a) }
  J.ShapeGetTriangles = function (...a) { tileMetrics.tris++; return new origTri(...a) }

  if (tilesEnabled) {
    const index = physics._staticTiles
    tileMetrics.builds0 = index.stats.builds
    tileMetrics.buildMs0 = index.stats.buildMs
    const tileM = index.tileM, marginM = index.marginM
    const origUpdate = index.update
    index.update = function (id) {
      tileMetrics.updateCalls++
      const b = physics.bodies.get(id)
      const live = !!b && b.GetMotionType() === J.EMotionType_Static && !b.IsSensor()
      if (!live) return origUpdate.call(this, id)
      tileMetrics.updateLive++
      tileMetrics.concats += 19
      const bb = b.GetWorldSpaceBounds(), mn = bb.mMin, mx = bb.mMax
      const tx0 = Math.floor((mn.GetX() - marginM) / tileM), tx1 = Math.floor((mx.GetX() + marginM) / tileM)
      const tz0 = Math.floor((mn.GetZ() - marginM) / tileM), tz1 = Math.floor((mx.GetZ() + marginM) / tileM)
      const excluded = mn.GetY() > 10000 || mx.GetY() < -10000
      const prev = spanHistory.get(id)
      const span = excluded ? null : [tx0, tx1, tz0, tz1]
      if (prev && span && prev[0] === span[0] && prev[1] === span[1] && prev[2] === span[2] && prev[3] === span[3]) tileMetrics.unchangedSpan++
      if (span) spanHistory.set(id, span); else spanHistory.delete(id)
      const u0 = performance.now()
      const r = origUpdate.call(this, id)
      tileMetrics.updateMs += performance.now() - u0
      return r
    }
  }

  const colMetrics = { mapGet: 0, mapSet: 0, newArrays: 0, seen: new Set() }
  runtime._colBuckets = COL_COUNT_MAP ? new CountingMap(colMetrics) : new Map()
  runtime._colGridVersion = null

  const aoiRingCells = []
  const aoiSpatialCells = []
  let ringComputes = 0
  const appRuntime = runtime
  const origNearby = appRuntime.nearbyPlayerIdsHysteresis?.bind(appRuntime)
  if (origNearby) appRuntime.nearbyPlayerIdsHysteresis = function (...a) { ringComputes++; return origNearby(...a) }
  let servedCalls = 0
  const origNearbyPlain = appRuntime.nearbyPlayerIds?.bind(appRuntime)
  if (origNearbyPlain) appRuntime.nearbyPlayerIds = function (...a) { servedCalls++; return origNearbyPlain(...a) }

  let colMs = 0
  let collisionEvents = 0
  const eventHashParts = []
  const origFireEvent = runtime.fireEvent.bind(runtime)
  runtime.fireEvent = function (id, name, payload) {
    if (name === 'onCollision') {
      collisionEvents++
      eventHashParts.push(id, payload.id, payload.point[0], payload.point[1], payload.point[2], payload.impactSpeed)
    }
    return origFireEvent(id, name, payload)
  }

  const origTick = runtime.tick
  let sampledTicks = 0
  let rebucketSum = 0
  let syncMs = 0, spatialMs = 0, interactMs = 0, respawnMs = 0
  runtime.tick = function (tickNum, dt) {
    origTick.call(this, tickNum, dt)
    sampledTicks++
    aoiRingCells.push(_ringCache.size)
    aoiSpatialCells.push(_spatialCache.size)
    colMs += runtime._lastCollisionMs || 0
    rebucketSum += runtime._lastColGridRebuckets || 0
    syncMs += runtime._lastSyncMs || 0
    spatialMs += runtime._lastSpatialMs || 0
    interactMs += runtime._lastInteractMs || 0
    respawnMs += runtime._lastRespawnMs || 0
  }

  const runStart = Date.now()
  const startTicks = sampledTicks
  while (sampledTicks - startTicks < TICKS && Date.now() - runStart < 240000) await sleep(50)
  const measuredTicks = Math.max(1, sampledTicks - startTicks)
  if (march) clearInterval(march)
  const servedPlayers = server.playerManager.getConnectedPlayers().length
  const snapshotPasses = servedPlayers > 0 ? servedCalls / servedPlayers : 0

  const index = physics._staticTiles
  const tileBuilds = index ? index.stats.builds - tileMetrics.builds0 : 0
  const tileBuildMs = index ? index.stats.buildMs - tileMetrics.buildMs0 : 0

  let aoiCellsPerPass = 0, aoiSpatialPerPass = 0, aoiPasses = 0
  let prevRing = -1
  for (let i = 0; i < aoiRingCells.length; i++) {
    const r = aoiRingCells[i]
    if (r !== prevRing) { aoiPasses++; aoiCellsPerPass += r; aoiSpatialPerPass += aoiSpatialCells[i]; prevRing = r }
  }
  aoiCellsPerPass = aoiPasses ? aoiCellsPerPass / aoiPasses : 0

  let neighborMsPerCall = 0, centerMsPerCall = 0
  const cellsPerFace = 64
  const neighSamples = [], centerSamples = []
  {
    const reps = 20000
    for (let pass = 0; pass < 6; pass++) {
      const n0 = performance.now()
      for (let i = 0; i < reps; i++) neighborCells(i % 6, (i * 7) % cellsPerFace, (i * 13) % cellsPerFace, cellsPerFace)
      neighSamples.push((performance.now() - n0) * 1000 / reps)
      const c0 = performance.now()
      for (let i = 0; i < reps; i++) _cellCenterWorld(i % 6, (i % 64) * 3.5 - 100, (i % 64) * 3.5 - 100, 6371000, 6371000)
      centerSamples.push((performance.now() - c0) * 1000 / reps)
    }
    neighSamples.sort((a, b) => a - b); centerSamples.sort((a, b) => a - b)
  }

  let neighborFreshMismatch = 0
  {
    for (let face = 0; face < 6; face++) {
      for (const [cx, cy] of [[0, 0], [1, 1], [31, 31], [0, 63], [63, 0]]) {
        const ns = neighborCells(face, cx, cy, cellsPerFace)
        const keys = ns.map(n => packCellKey(n.face, n.cx, n.cy, cellsPerFace)).sort()
        const again = neighborCells(face, cx, cy, cellsPerFace).map(n => packCellKey(n.face, n.cx, n.cy, cellsPerFace)).sort()
        if (keys.length !== 8 || keys.join('|') !== again.join('|')) neighborFreshMismatch++
      }
    }
  }

  const out = {
    arm: ARM,
    mode: 'server',
    players: server.playerManager.getConnectedPlayers().length,
    entities: runtime.entities.size,
    collisionEntities: runtime._collisionEntities.length,
    ticks: measuredTicks,
    tilesEnabled,
    tileUpdateCallsPerTick: Number((tileMetrics.updateCalls / measuredTicks).toFixed(3)),
    tileUpdateLivePerTick: Number((tileMetrics.updateLive / measuredTicks).toFixed(3)),
    tileUnchangedSpanPerTick: Number((tileMetrics.unchangedSpan / measuredTicks).toFixed(3)),
    tileUnchangedSpanFraction: Number((tileMetrics.unchangedSpan / Math.max(1, tileMetrics.updateLive)).toFixed(4)),
    tileStringConcatsPerTick: Number((tileMetrics.concats / measuredTicks).toFixed(3)),
    tileUpdateMsPerTick: Number((tileMetrics.updateMs / measuredTicks).toFixed(5)),
    tileBuildsPerTick: Number((tileBuilds / measuredTicks).toFixed(4)),
    tileBuildMsPerTick: Number((tileBuildMs / measuredTicks).toFixed(5)),
    tileAABoxPerTick: Number((tileMetrics.aabox / measuredTicks).toFixed(3)),
    tileShapeGetTrianglesPerTick: Number((tileMetrics.tris / measuredTicks).toFixed(3)),
    tileAABoxPerBuild: Number((tileMetrics.aabox / Math.max(1, tileBuilds)).toFixed(2)),
    colMapGetPerTick: Number((colMetrics.mapGet / measuredTicks).toFixed(2)),
    colMapSetPerTick: Number((colMetrics.mapSet / measuredTicks).toFixed(2)),
    colNewArraysPerTick: Number((colMetrics.newArrays / measuredTicks).toFixed(2)),
    colRebucketsPerTick: Number((rebucketSum / measuredTicks).toFixed(3)),
    colMsPerTick: Number((colMs / measuredTicks).toFixed(5)),
    syncMsPerTick: Number((syncMs / measuredTicks).toFixed(5)),
    spatialMsPerTick: Number((spatialMs / measuredTicks).toFixed(5)),
    interactMsPerTick: Number((interactMs / measuredTicks).toFixed(5)),
    respawnMsPerTick: Number((respawnMs / measuredTicks).toFixed(5)),
    tickMsPerTick: Number(((Date.now() - runStart) / measuredTicks).toFixed(5)),
    colEventsPerTick: Number((collisionEvents / measuredTicks).toFixed(3)),
    colEventStreamHash: hashFloats(eventHashParts.slice(0, 20000)),
    colEventStreamSamples: eventHashParts.length,
    aoiRingCellsPerPass: Number(aoiCellsPerPass.toFixed(3)),
    aoiSpatialCellsPerPass: Number((aoiPasses ? aoiSpatialPerPass / aoiPasses : 0).toFixed(3)),
    aoiRingComputesPerTick: Number((ringComputes / measuredTicks).toFixed(3)),
    aoiRingComputesPerPass: Number((ringComputes / Math.max(1, snapshotPasses)).toFixed(3)),
    aoiSnapshotPasses: Number(snapshotPasses.toFixed(1)),
    aoiMarchSteps: marchSteps,
    aoiPasses,
    aoiNeighborUsPerCallMin: Number(neighSamples[0].toFixed(5)),
    aoiNeighborUsPerCallMedian: Number(neighSamples[3].toFixed(5)),
    aoiCenterUsPerCallMin: Number(centerSamples[0].toFixed(5)),
    aoiCenterUsPerCallMedian: Number(centerSamples[3].toFixed(5)),
    aoiRingUsPerCompute: Number((neighSamples[0] + 8 * centerSamples[0]).toFixed(5)),
    aoiRingUsPerTick: Number((ringComputes / measuredTicks * (neighSamples[0] + 8 * centerSamples[0])).toFixed(5)),
    aoiNeighborFreshMismatch: neighborFreshMismatch,
    aoiRingCostMsPerPass: Number(((ringComputes / Math.max(1, snapshotPasses)) * (neighSamples[0] + 8 * centerSamples[0]) / 1000).toFixed(6)),
    aoiRingCostMsPerTick: Number(((ringComputes / measuredTicks) * (neighSamples[0] + 8 * centerSamples[0]) / 1000).toFixed(6)),
    tileCount: index ? index.tileCount : 0,
  }

  for (const c of clients) { try { c.close?.() } catch {} }
  try { await server.stop?.() } catch {}
  return out
}

const out = { arm: ARM }
if (MODE === 'micro') {
  Object.assign(out, await runMicro())
} else if (MODE === 'fixture') {
  Object.assign(out, await runCollisionFixture())
} else {
  Object.assign(out, await runServer())
}

if (EXPECT) {
  const ref = JSON.parse(readFileSync(EXPECT, 'utf8'))
  for (const key of Object.keys(ref)) {
    const a = JSON.stringify(ref[key]), b = JSON.stringify(out[key])
    expect(a === b, `field ${key} differs from ${EXPECT}: expected ${a} got ${b}`)
  }
}

if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(out, null, 2))
}

console.log(JSON.stringify(out, null, 2))
if (failures.length) {
  for (const f of failures) console.log('FAIL: ' + f)
  console.log('RESULT: FAIL')
  process.exit(1)
}
console.log('RESULT: PASS')
process.exit(0)
