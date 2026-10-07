#!/usr/bin/env node
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createNetServer } from 'node:net'

process.env.SPOINT_NO_WATCH = '1'
process.env.SPOINT_SKIP_PREWARM = '1'
if (!process.env.GM_PROFILE) process.env.GM_PROFILE = '1'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const body = a.replace(/^--/, '')
  const eq = body.indexOf('=')
  if (eq < 0) return [body, 'true']
  return [body.slice(0, eq), body.slice(eq + 1)]
}))

function numericFlag(name, fallback) {
  const raw = args[name]
  if (raw === undefined) return fallback
  const n = raw.trim() === '' ? NaN : Number(raw)
  if (!Number.isFinite(n)) {
    console.error(`[cpu-skip] --${name} must be a number, got "${raw}"`)
    process.exit(2)
  }
  return n
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const ARM = args.arm || 'run'
const PLAYERS = numericFlag('players', 4)
const TICKS = numericFlag('ticks', 400)
const WARMUP = numericFlag('warmup', 0)
const HOLD_CAP_MS = numericFlag('holdCapMs', 180000)
const N_BUTTONS = numericFlag('buttons', 24)
const N_BOXES = numericFlag('boxes', 16)
const N_DYNS = numericFlag('dyns', 12)
const SETTLE_MS = numericFlag('settleMs', 4000)

const MAX_ENCODED_FRACTION_OF_ENTITIES = 0.9
const MAX_REBUCKET_FRACTION_OF_COLLIDERS = 0.25
const MAX_NEW_BUFFER_FRACTION_OF_SAMPLES = 0.5
const MIN_UNCHANGED_FRACTION_OF_COLLIDERS = 0.5
const MIN_TICKS_PER_SEC = 5

const failures = []
const finite = v => Number.isFinite(v)
function expect(name, got, predicate) {
  let ok = false
  try { ok = Boolean(predicate(got)) } catch { ok = false }
  if (!ok) failures.push(`${name}=${JSON.stringify(got)}`)
  return got
}

const { createServer } = await import('../src/sdk/server.js')
const { PhysicsNetworkClient } = await import('../src/client/PhysicsNetworkClient.js')
const { loadWorldModule } = await import('../src/sdk/WorldLocator.js')
const { SnapshotEncoder } = await import('../src/netcode/SnapshotEncoder.js')
const { AppRuntime } = await import('../src/apps/AppRuntime.js')
const { unpackBinRecord } = await import('../src/netcode/SnapshotBinFormat.js')

const M = {
  ticks: 0,
  encodeEntityCalls: 0,
  getSnapshotCalls: 0,
  encodeInSnapshot: 0,
  entityChanged: 0,
  entitySamples: 0,
  dynEntries: 0,
  binSamples: 0,
  primeHits: 0,
  primeSamples: 0,
  binIdentical: 0,
  binNewBuffers: 0,
  binByteMismatch: 0,
  binPosDiff: 0,
  binRotDiff: 0,
  binVelDiff: 0,
  colSamples: 0,
  colUnchanged: 0,
  colRebuckets: 0,
  colGridPath: 0,
  interactTicks: 0,
  interactIdleTicks: 0,
  interactPairs: 0,
  interactTests: 0,
  colMs: 0,
  interactMs: 0,
  snapshotStale: 0,
  snapshotChecks: 0,
  interactEvents: 0,
  collisionEvents: 0,
  clientErrors: 0,
}
let suppress = false
let warmed = WARMUP === 0
let runStartMs = 0

function resetCounters() {
  for (const k of Object.keys(M)) if (k !== 'interactEvents' && k !== 'collisionEvents' && k !== 'clientErrors') M[k] = 0
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createNetServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
  })
}

const port = await freePort()
const worldDef = await loadWorldModule(resolve(SDK_ROOT, 'apps', 'world', 'tps-game.js'))
const server = await createServer({
  port,
  tickRate: worldDef.tickRate || 60,
  appsDirs: [resolve(SDK_ROOT, 'apps'), resolve(SDK_ROOT, 'src', 'stdlib-apps')],
  sdkRoot: SDK_ROOT,
  gravity: worldDef.gravity,
  staticDirs: [],
  storageDir: resolve(SDK_ROOT, 'data', 'cpu-skip-witness'),
})
await server.loadWorld(worldDef)
await server.start()
const runtime = server.runtime
const url = `ws://127.0.0.1:${port}/ws`

const origEncodeEntity = AppRuntime.prototype._encodeEntity
AppRuntime.prototype._encodeEntity = function (id, e) {
  if (!suppress) M.encodeEntityCalls++
  return origEncodeEntity.call(this, id, e)
}

const origGetSnapshot = AppRuntime.prototype.getSnapshot
AppRuntime.prototype.getSnapshot = function () {
  if (suppress) return origGetSnapshot.call(this)
  M.getSnapshotCalls++
  const before = M.encodeEntityCalls
  const r = origGetSnapshot.call(this)
  M.encodeInSnapshot += M.encodeEntityCalls - before
  return r
}

const binPrev = new Map()
const binPrevPrev = new Map()
const binBytes = new Map()
const _binOut = {}

function sampleEntityBins(cache) {
  let identical = 0, sampled = 0, newBuf = 0, mismatch = 0
  for (const [id, entry] of cache) {
    const enc = entry.enc
    if (!enc) continue
    const buf = enc[2]
    if (!buf) continue
    sampled++
    const cur = binBytes.get(id)
    let same = false
    if (cur) {
      same = true
      for (let i = 0; i < 29; i++) if (cur[i] !== buf[i]) { same = false; break }
    }
    if (same) identical++
    else if (cur) {
      for (let i = 0; i < 12; i++) if (cur[i] !== buf[i]) { M.binPosDiff++; break }
      for (let i = 12; i < 18; i++) if (cur[i] !== buf[i]) { M.binVelDiff++; break }
      for (let i = 18; i < 22; i++) if (cur[i] !== buf[i]) { M.binRotDiff++; break }
    }
    if (cur) { for (let i = 0; i < 29; i++) cur[i] = buf[i] } else binBytes.set(id, Uint8Array.from(buf))
    const p = binPrev.get(id), pp = binPrevPrev.get(id)
    if (buf !== p && buf !== pp) { newBuf++; binPrevPrev.set(id, p); binPrev.set(id, buf) }
    const e = entry.srcEntity
    if (e && e.position) {
      unpackBinRecord(buf, _binOut)
      const wx = Math.round(e.position[0] * 100) / 100
      const wy = Math.round(e.position[1] * 100) / 100
      const wz = Math.round(e.position[2] * 100) / 100
      if (Math.abs(_binOut.px - wx) > 0.02 || Math.abs(_binOut.py - wy) > 0.02 || Math.abs(_binOut.pz - wz) > 0.02) mismatch++
    }
  }
  M.binSamples += sampled
  M.binIdentical += identical
  M.binNewBuffers += newBuf
  M.binByteMismatch += mismatch
  M.dynEntries = sampled
}

let lastDynCache = null
const origRefresh = SnapshotEncoder.refreshDynamicCache
SnapshotEncoder.refreshDynamicCache = function (cache, ...rest) {
  lastDynCache = cache
  const r = origRefresh.call(this, cache, ...rest)
  if (warmed && !suppress) { sampleEntityBins(cache); samplePrimeMemos(cache) }
  return r
}

function samplePrimeMemos(cache) {
  for (const [, entry] of cache) {
    const enc = entry.enc
    if (!enc) continue
    M.primeSamples++
    if (entry._pBin === enc[2]) M.primeHits++
  }
}

const colXf = new Map()
let colLastArray = null
let colLastLen = -1

function writeColXf(xf, e) {
  const p = e.position, r = e.rotation, s = e.scale
  xf[0] = p[0]; xf[1] = p[1]; xf[2] = p[2]
  xf[3] = r[0]; xf[4] = r[1]; xf[5] = r[2]; xf[6] = r[3]
  xf[7] = s[0]; xf[8] = s[1]; xf[9] = s[2]
}

function sampleCollision() {
  const c = runtime._collisionEntities
  if (c.length === 0) return
  M.colSamples += c.length
  if (c.length >= 100) M.colGridPath++
  const rebuilt = c !== colLastArray || c.length !== colLastLen
  colLastArray = c; colLastLen = c.length
  let unchanged = 0
  for (let i = 0; i < c.length; i++) {
    const e = c[i]
    let xf = colXf.get(e.id)
    if (!xf) { xf = new Float64Array(10); colXf.set(e.id, xf); writeColXf(xf, e); continue }
    const p = e.position, r = e.rotation, s = e.scale
    if (xf[0] === p[0] && xf[1] === p[1] && xf[2] === p[2] && xf[3] === r[0] && xf[4] === r[1] && xf[5] === r[2] && xf[6] === r[3] && xf[7] === s[0] && xf[8] === s[1] && xf[9] === s[2]) unchanged++
    else writeColXf(xf, e)
  }
  if (colXf.size > c.length * 4 + 64) colXf.clear()
  M.colUnchanged += rebuilt ? 0 : unchanged
  if (typeof runtime._lastColGridRebuckets === 'number') M.colRebuckets += runtime._lastColGridRebuckets
}

const entXf = new Map()

function sampleEntityChanges() {
  let changed = 0, sampled = 0
  for (const [id, e] of runtime.entities) {
    const p = e.position, s = e.scale, v = e.velocity
    if (!p) continue
    const r = e.rotation
    const rIsArr = Array.isArray(r)
    const r0 = rIsArr ? r[0] : (r?.x || 0), r1 = rIsArr ? r[1] : (r?.y || 0), r2 = rIsArr ? r[2] : (r?.z || 0), r3 = rIsArr ? r[3] : (r?.w || 1)
    sampled++
    let xf = entXf.get(id)
    if (!xf) { xf = new Float64Array(13); entXf.set(id, xf); changed++; writeEntXf(xf, p, r0, r1, r2, r3, s, v); continue }
    const s0 = s ? s[0] : 1, s1 = s ? s[1] : 1, s2 = s ? s[2] : 1
    const v0 = v ? v[0] : 0, v1 = v ? v[1] : 0, v2 = v ? v[2] : 0
    if (xf[0] !== p[0] || xf[1] !== p[1] || xf[2] !== p[2] || xf[3] !== r0 || xf[4] !== r1 || xf[5] !== r2 || xf[6] !== r3 || xf[7] !== s0 || xf[8] !== s1 || xf[9] !== s2 || xf[10] !== v0 || xf[11] !== v1 || xf[12] !== v2) {
      changed++
      writeEntXf(xf, p, r0, r1, r2, r3, s, v)
    }
  }
  if (entXf.size > sampled * 4 + 64) entXf.clear()
  M.entityChanged += changed
  M.entitySamples += sampled
}

function writeEntXf(xf, p, r0, r1, r2, r3, s, v) {
  xf[0] = p[0]; xf[1] = p[1]; xf[2] = p[2]
  xf[3] = r0; xf[4] = r1; xf[5] = r2; xf[6] = r3
  xf[7] = s ? s[0] : 1; xf[8] = s ? s[1] : 1; xf[9] = s ? s[2] : 1
  xf[10] = v ? v[0] : 0; xf[11] = v ? v[1] : 0; xf[12] = v ? v[2] : 0
}

function sampleInteractables() {
  const eIds = runtime._interactableIds.size
  const players = server.playerManager.getConnectedPlayers()
  let pressed = 0
  for (let i = 0; i < players.length; i++) if (players[i].lastInput && players[i].lastInput.interact) pressed++
  M.interactTicks++
  if (pressed === 0) M.interactIdleTicks++
  M.interactPairs += eIds * players.length
  if (typeof runtime._lastInteractTests === 'number') M.interactTests += runtime._lastInteractTests
}

function sampleSnapshotFreshness() {
  const snap = runtime.getSnapshot()
  const ents = snap.entities
  let checked = 0, stale = 0
  for (let i = 0; i < ents.length; i++) {
    const s = ents[i]
    const live = runtime.entities.get(s.id)
    if (!live || !live.position) continue
    checked++
    if (s.position[0] !== live.position[0] || s.position[1] !== live.position[1] || s.position[2] !== live.position[2]) stale++
  }
  M.snapshotChecks += checked
  M.snapshotStale += stale
}

const origFireEvent = runtime.fireEvent.bind(runtime)
runtime.fireEvent = function (id, name, payload) {
  if (name === 'onInteract') M.interactEvents++
  else if (name === 'onCollision') M.collisionEvents++
  return origFireEvent(id, name, payload)
}

const origTick = runtime.tick
runtime.tick = function (tickNum, dt) {
  origTick.call(this, tickNum, dt)
  if (!warmed) {
    M.ticks++
    if (M.ticks >= WARMUP) { resetCounters(); warmed = true; colXf.clear(); entXf.clear(); runStartMs = Date.now() }
    return
  }
  if (suppress) return
  M.ticks++
  sampleCollision()
  sampleInteractables()
  sampleEntityChanges()
  sampleSnapshotFreshness()
  M.colMs += runtime._lastCollisionMs || 0
  M.interactMs += runtime._lastInteractMs || 0
}

const clients = []
for (let i = 0; i < PLAYERS; i++) {
  const c = new PhysicsNetworkClient({ url, predictionEnabled: false, smoothInterpolation: false, webTransport: { enabled: false } })
  c.onMessageError = () => { M.clientErrors++ }
  clients.push(c)
}
const connectFailures = []
await Promise.all(clients.map(c => c.connect().catch(e => connectFailures.push(e))))
if (connectFailures.length) { console.error(`[cpu-skip] ${connectFailures.length} of ${clients.length} client(s) failed to connect to ${url}: ${connectFailures[0].name}: ${connectFailures[0].message}`); process.exit(1) }
const t0 = Date.now()
while (server.playerManager.getConnectedPlayers().length < PLAYERS && Date.now() - t0 < 30000) await sleep(50)
for (let i = 0; i < clients.length; i++) clients[i].startInputLoop(() => ({ forward: false, sprint: false, yaw: i, pitch: 0 }))
await sleep(1500)

let interactableIdsBeforePopulate = 0
let dynamicEntityIdsBeforePopulate = 0
let collisionEntitiesBeforePopulate = 0
let entitiesBeforePopulate = 0

function populate(count, appName, extra) {
  if (count <= 0) return
  const spawn = worldDef.spawnPoint || [0, 2, 0]
  const side = Math.ceil(Math.sqrt(count))
  for (let i = 0; i < count; i++) {
    const gx = i % side, gz = (i / side) | 0
    const x = spawn[0] + (gx - side / 2) * 2.5
    const z = spawn[2] + (gz - side / 2) * 2.5
    const g = server.physics.terrainHeightAt(x, z)
    const y = (Number.isFinite(g) ? g : spawn[1]) + 0.6
    runtime.spawnEntity(null, { app: appName, position: [x, y, z], ...(extra || {}) })
  }
}

entitiesBeforePopulate = runtime.entities.size
interactableIdsBeforePopulate = runtime._interactableIds.size
dynamicEntityIdsBeforePopulate = runtime._dynamicEntityIds.size
collisionEntitiesBeforePopulate = runtime._collisionEntities.length

populate(N_BUTTONS, 'button', { config: { radius: 3 } })
populate(N_BOXES, 'destructible-box', { config: { hx: 0.3, hy: 0.3, hz: 0.3 } })
populate(N_DYNS, 'prop-dynamic', { bodyType: 'dynamic' })
if (N_BUTTONS + N_BOXES + N_DYNS > 0) await sleep(SETTLE_MS)

const shape = {
  arm: ARM,
  players: expect('players', server.playerManager.getConnectedPlayers().length, v => v === PLAYERS),
  entities: expect('entities', runtime.entities.size, v => v >= entitiesBeforePopulate + N_BUTTONS + N_BOXES + N_DYNS),
  dynamicEntityIds: expect('dynamicEntityIds', runtime._dynamicEntityIds.size, v => v >= dynamicEntityIdsBeforePopulate + N_DYNS),
  activeDynamicIds: expect('activeDynamicIds', runtime._activeDynamicIds.size, v => v > 0),
  collisionEntities: expect('collisionEntities', runtime._collisionEntities.length, v => v >= Math.max(2, collisionEntitiesBeforePopulate + N_BOXES)),
  interactableIds: expect('interactableIds', runtime._interactableIds.size, v => v >= interactableIdsBeforePopulate + N_BUTTONS),
  tickRate: worldDef.tickRate || 60,
}

const instruments = {
  lastInteractTests: expect('instrument.lastInteractTests', typeof runtime._lastInteractTests === 'number', v => v === true),
  lastColGridRebuckets: expect('instrument.lastColGridRebuckets', typeof runtime._lastColGridRebuckets === 'number', v => v === true),
  lastCollisionMs: expect('instrument.lastCollisionMs', typeof runtime._lastCollisionMs === 'number', v => v === true),
  lastInteractMs: expect('instrument.lastInteractMs', typeof runtime._lastInteractMs === 'number', v => v === true),
}

if (WARMUP > 0) {
  const warmDeadline = Date.now() + HOLD_CAP_MS
  while (!warmed && Date.now() < warmDeadline) await sleep(50)
}
resetCounters()
colXf.clear()
entXf.clear()
const runStart = Date.now()
runStartMs = runStart
while (M.ticks < TICKS && Date.now() - runStart < HOLD_CAP_MS) await sleep(50)
const runMs = Date.now() - (runStartMs || runStart)
const measuredTicks = M.ticks
suppress = true

let interactArm = 'skipped-no-interactable'
if (runtime._interactableIds.size > 0) {
  const players = server.playerManager.getConnectedPlayers()
  if (players.length > 0) {
    const target = [...runtime._interactableIds][0]
    const e = runtime.entities.get(target)
    const p = players[0]
    if (e && p) {
      p.state.position[0] = e.position[0]; p.state.position[1] = e.position[1]; p.state.position[2] = e.position[2]
      server.physicsIntegration.setPlayerPosition(p.id, p.state.position)
      const before = M.interactEvents
      clients[0].startInputLoop(() => ({ forward: false, sprint: false, yaw: 0, pitch: 0, interact: true }))
      await sleep(700)
      clients[0].startInputLoop(() => ({ forward: false, sprint: false, yaw: 0, pitch: 0, interact: false }))
      interactArm = M.interactEvents > before ? 'fired' : 'not-fired'
    }
  }
}

let overlapArm = 'skipped-too-few'
{
  const c = runtime._collisionEntities
  if (c.length >= 2) {
    const a = c[0], b = c[1]
    const before = M.collisionEvents
    const home = [b.position[0], b.position[1], b.position[2]]
    b.position[0] = a.position[0] + 0.01
    b.position[1] = a.position[1]
    b.position[2] = a.position[2] + 0.01
    await sleep(400)
    const fired = M.collisionEvents > before
    b.position[0] = home[0]; b.position[1] = home[1]; b.position[2] = home[2]
    await sleep(200)
    overlapArm = fired ? 'fired' : 'not-fired'
  }
}

let movedEntityArm = 'skipped-no-dynamic'
{
  const id = [...runtime._activeDynamicIds][0] ?? [...runtime._dynamicEntityIds][0]
  const e = id !== undefined ? runtime.entities.get(id) : null
  if (e) {
    const target = [e.position[0] + 40, e.position[1], e.position[2] + 40]
    let seen = false
    for (let i = 0; i < 40 && !seen; i++) {
      runtime._activeDynamicIds.add(id)
      if (e._physicsBodyId !== undefined && runtime._physics) runtime._physics.setBodyPosition(e._physicsBodyId, target)
      e.position[0] = target[0]; e.position[1] = target[1]; e.position[2] = target[2]
      await sleep(25)
      const entry = lastDynCache && lastDynCache.get(id)
      if (!entry || !entry.enc || !entry.enc[2]) continue
      unpackBinRecord(entry.enc[2], _binOut)
      if (Math.abs(_binOut.px - target[0]) < 0.05 && Math.abs(_binOut.pz - target[2]) < 0.05) seen = true
    }
    movedEntityArm = seen ? 'seen-moved' : 'not-seen'
  }
}

let snapshotMembershipArm = 'skipped'
{
  const snap = runtime.getSnapshot()
  snapshotMembershipArm = snap.entities.length === runtime.entities.size ? 'complete' : `${snap.entities.length} of ${runtime.entities.size}`
}

let retainArm = 'skipped'
{
  const held = runtime.getSnapshot()
  const n = Math.min(5, held.entities.length)
  const heldAt = held.entities.slice(0, n).map(s => [s.position[0], s.position[1], s.position[2]])
  const liveAt = new Map()
  for (const [id, e] of runtime.entities) if (e.position) liveAt.set(id, [e.position[0], e.position[1], e.position[2]])
  let mover = null
  for (const id of runtime._staticEntityIds) {
    const e = runtime.entities.get(id)
    if (e && e.position) { mover = e; break }
  }
  if (!mover) for (const [, e] of runtime.entities) if (e.position && e._physicsBodyId === undefined) { mover = e; break }
  for (let i = 0; i < 10; i++) {
    await sleep(50)
    if (mover) { mover.position[0] += 0.25; mover.position[2] += 0.25 }
  }
  let heldSame = true
  for (let i = 0; i < n; i++) {
    const s = held.entities[i]
    if (s.position[0] !== heldAt[i][0] || s.position[1] !== heldAt[i][1] || s.position[2] !== heldAt[i][2]) heldSame = false
  }
  let liveChanged = 0
  for (const [id, at] of liveAt) {
    const e = runtime.entities.get(id)
    if (e && e.position && (e.position[0] !== at[0] || e.position[1] !== at[1] || e.position[2] !== at[2])) liveChanged++
  }
  const tickAdvanced = runtime.getSnapshot().tick !== held.tick
  retainArm = heldSame && tickAdvanced && liveChanged > 0 ? 'stable-and-live-moved' : `heldSame=${heldSame} tickAdvanced=${tickAdvanced} liveChanged=${liveChanged}`
}

const ticks = Math.max(1, measuredTicks)
const rate = (n, digits) => Number((n / ticks).toFixed(digits))
const entitiesPerSnapshotCall = Number((M.entitySamples / Math.max(1, M.getSnapshotCalls)).toFixed(2))
const encodePerSnapshotCall = Number((M.encodeInSnapshot / Math.max(1, M.getSnapshotCalls)).toFixed(2))
const colEntitiesPerTick = rate(M.colSamples, 2)
const colUnchangedFraction = Number((M.colUnchanged / Math.max(1, M.colSamples)).toFixed(4))
const rebucketsPerTick = rate(M.colRebuckets, 2)
const newBuffersPerSample = Number((M.binNewBuffers / Math.max(1, M.binSamples)).toFixed(4))

const out = {
  arm: ARM,
  ...shape,
  ...instruments,
  ticks: expect('ticks', measuredTicks, v => v >= TICKS),
  runMs: expect('runMs', runMs, v => v > 0),
  ticksPerSec: expect('ticksPerSec', Number((measuredTicks / (runMs / 1000)).toFixed(2)), v => Number.isFinite(v) && v >= MIN_TICKS_PER_SEC),
  row1_activeDynPerTick: expect('row1_activeDynPerTick', rate(M.binSamples, 2), v => v > 0),
  row1_binIdenticalPerTick: expect('row1_binIdenticalPerTick', rate(M.binIdentical, 2), finite),
  row1_identicalFraction: expect('row1_identicalFraction', Number((M.binIdentical / Math.max(1, M.binSamples)).toFixed(4)), finite),
  row1_newBuffersPerTick: expect('row1_newBuffersPerTick', rate(M.binNewBuffers, 2), finite),
  row1_binByteMismatchTotal: expect('row1_binByteMismatchTotal', M.binByteMismatch, v => v === 0),
  row1_newBuffersPerSample: expect('row1_newBuffersPerSample', newBuffersPerSample, v => Number.isFinite(v) && v <= MAX_NEW_BUFFER_FRACTION_OF_SAMPLES),
  row1_primeHitsPerTick: expect('row1_primeHitsPerTick', rate(M.primeHits, 2), finite),
  row1_primeHitFraction: expect('row1_primeHitFraction', Number((M.primeHits / Math.max(1, M.binIdentical)).toFixed(4)), finite),
  row1_changedWithPosDiff: expect('row1_changedWithPosDiff', M.binPosDiff, finite),
  row1_changedWithRotDiff: expect('row1_changedWithRotDiff', M.binRotDiff, finite),
  row1_changedWithVelDiff: expect('row1_changedWithVelDiff', M.binVelDiff, finite),
  row2_entitiesPerSnapshotCall: expect('row2_entitiesPerSnapshotCall', entitiesPerSnapshotCall, v => v > 0),
  row2_encodeEntityPerTick: expect('row2_encodeEntityPerTick', rate(M.encodeEntityCalls, 2), finite),
  row2_getSnapshotCallsPerTick: expect('row2_getSnapshotCallsPerTick', rate(M.getSnapshotCalls, 3), v => v > 0),
  row2_encodePerSnapshotCall: expect('row2_encodePerSnapshotCall', encodePerSnapshotCall, v => Number.isFinite(v) && v <= entitiesPerSnapshotCall * MAX_ENCODED_FRACTION_OF_ENTITIES),
  row2_entitiesChangedPerTick: expect('row2_entitiesChangedPerTick', rate(M.entityChanged, 2), finite),
  row2_entitiesSampledPerTick: expect('row2_entitiesSampledPerTick', rate(M.entitySamples, 2), v => v > 0),
  row2_snapshotStaleTotal: expect('row2_snapshotStaleTotal', M.snapshotStale, v => v === 0),
  row2_snapshotChecks: expect('row2_snapshotChecks', M.snapshotChecks, v => v > 0),
  row3_colEntitiesPerTick: expect('row3_colEntitiesPerTick', colEntitiesPerTick, v => v > 0),
  row3_colUnchangedPerTick: expect('row3_colUnchangedPerTick', rate(M.colUnchanged, 2), finite),
  row3_unchangedFraction: expect('row3_unchangedFraction', colUnchangedFraction, v => v >= MIN_UNCHANGED_FRACTION_OF_COLLIDERS),
  row3_gridPathTicks: expect('row3_gridPathTicks', M.colGridPath, finite),
  row3_rebucketsPerTick: expect('row3_rebucketsPerTick', rebucketsPerTick, v => Number.isFinite(v) && v <= colEntitiesPerTick * MAX_REBUCKET_FRACTION_OF_COLLIDERS),
  row3_colMsPerTick: expect('row3_colMsPerTick', rate(M.colMs, 5), finite),
  row4_interactPairsPerTick: expect('row4_interactPairsPerTick', rate(M.interactPairs, 2), v => v > 0),
  row4_idleTickFraction: expect('row4_idleTickFraction', Number((M.interactIdleTicks / Math.max(1, M.interactTicks)).toFixed(4)), v => v === 1),
  row4_distanceTestsPerTick: expect('row4_distanceTestsPerTick', rate(M.interactTests, 2), v => v === 0),
  row4_interactMsPerTick: expect('row4_interactMsPerTick', rate(M.interactMs, 5), finite),
  correctness_interactArm: expect('correctness_interactArm', interactArm, v => v === 'fired'),
  correctness_overlapArm: expect('correctness_overlapArm', overlapArm, v => v === 'fired'),
  correctness_snapshotMembership: expect('correctness_snapshotMembership', snapshotMembershipArm, v => v === 'complete'),
  correctness_retainArm: expect('correctness_retainArm', retainArm, v => v === 'stable-and-live-moved'),
  correctness_movedEntityArm: expect('correctness_movedEntityArm', movedEntityArm, v => v === 'seen-moved'),
  clientErrors: expect('clientErrors', M.clientErrors, v => v === 0),
}

console.log(JSON.stringify(out, null, 2))
for (const f of failures) console.log(`FAIL: ${f}`)
if (failures.length) console.log(`RESULT: FAIL (${failures.length} of ${Object.keys(out).length} measurement(s))`)
else console.log('RESULT: PASS')
process.exitCode = failures.length ? 1 : 0

for (const c of clients) { try { c.close?.() } catch {} }
try { await server.stop?.() } catch {}

const drainDeadline = Date.now() + 2000
const activeHandles = () => (typeof process._getActiveHandles === 'function' ? process._getActiveHandles().length : 0)
while (Date.now() < drainDeadline && activeHandles() > 0) await sleep(25)
process.exit(process.exitCode)
