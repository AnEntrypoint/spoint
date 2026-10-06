#!/usr/bin/env node
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mulberry32 } from './lib/net-conditioner.mjs'

process.env.SPOINT_NO_WATCH = '1'
const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true'] }))
const DURATION_MS = Number(args.duration || 15000)
const [LAT, JIT, LOSS] = (args.cond || '25/5/1').split('/').map(Number)

const { createServerDeps, wireServerHandlers } = await import('../src/sdk/server.js')
const { createPeerSimSession } = await import('../src/netcode/PeerSimSession.js')
const { loadWorldModule } = await import('../src/sdk/WorldLocator.js')
const { AppContext } = await import('../src/apps/AppContext.js')

const firesByCtx = new Map()
const tickTrace = []
const origDefineFire = AppContext.prototype.defineFire
AppContext.prototype.defineFire = function (spec = {}) {
  const fire = origDefineFire.call(this, spec)
  firesByCtx.set(this, fire)
  const host = this
  const inner = fire.tick.bind(fire)
  let calls = 0
  fire.tick = function (dt) {
    const appTick = host.time.tick
    if (calls++ < 40) tickTrace.push({ appTick, tl: fire.simTick })
    try { return inner(dt) } catch (err) { tickTrace.push({ appTick, tl: fire.simTick, err: err.message }); throw err }
  }
  const innerIgnite = fire.igniteCell.bind(fire)
  fire.igniteCell = function (...a) {
    const id = innerIgnite(...a)
    tickTrace.push({ igniteAt: host.time.tick, id })
    return id
  }
  return fire
}
function fireFor(ctx) {
  for (const [appCtx, fire] of firesByCtx) if (appCtx._runtime === ctx.appRuntime) return fire
  return null
}

const baseWorld = await loadWorldModule(resolve(SDK_ROOT, 'apps', 'world', 'fire-duel.js'))

function scriptedInput(ms, phase) {
  const t = (ms + phase) % 2400
  if (t < 600) return { right: true, yaw: 0, pitch: 0 }
  if (t < 900) return { jump: true, yaw: 0, pitch: 0 }
  if (t < 1500) return { left: true, forward: t > 1200, yaw: 0, pitch: 0 }
  if (t < 1800) return { interact: true, yaw: 0, pitch: 0 }
  if (t < 1900) return { shoot: true, yaw: 0, pitch: 0 }
  return { yaw: 0, pitch: 0 }
}

function linkDelay(rng) {
  const halfNormal = () => { let u = 0; while (u === 0) u = rng(); return Math.abs(Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())) }
  return () => LAT + JIT * halfNormal() + (rng() * 100 < LOSS ? 2 * LAT + JIT : 0)
}

async function run(profileName) {
  tickTrace.length = 0
  const worldDef = { ...baseWorld, netcode: { ...baseWorld.netcode, profile: profileName } }
  const roster = ['peer-a', 'peer-b']
  const peers = new Map()
  const lanes = new Map()
  for (const a of roster) for (const b of roster) if (a !== b) lanes.set(a + '>' + b, { at: 0, delay: linkDelay(mulberry32(lanes.size + 3)) })
  const postFor = from => msg => {
    if (msg.type !== 'BRIDGE_BROADCAST') return
    for (const [pk, ctx] of peers) {
      if (pk === from) continue
      const lane = lanes.get(from + '>' + pk)
      const at = Math.max(lane.at, performance.now() + lane.delay())
      lane.at = at
      setTimeout(() => ctx.peerSession.bridge.deliver(from, msg.data), Math.max(0, at - performance.now()))
    }
  }

  const fireLog = new Map()
  for (const pk of roster) {
    const tickRate = worldDef.tickRate || 60
    const deps = await createServerDeps({ gravity: worldDef.gravity, appsDirs: [resolve(SDK_ROOT, 'apps'), resolve(SDK_ROOT, 'src', 'stdlib-apps')], sdkRoot: SDK_ROOT, storageDir: resolve(SDK_ROOT, 'data', 'fire-peer-witness', pk) }, tickRate)
    const ctx = {
      config: {}, tickRate, gravity: worldDef.gravity, movement: worldDef.movement || {}, ...deps,
      currentWorldDef: worldDef, worldSpawnPoints: worldDef.spawnPoints, worldSpawnPoint: worldDef.spawnPoints[0],
      snapshotSeq: 0, handlerState: { fn: null },
      setTickHandler: fn => { ctx.handlerState.fn = fn; ctx.tickHandlerFn = fn },
    }
    wireServerHandlers(ctx)
    await deps.appLoader.loadAll()
    deps.stageLoader.loadFromDefinition('main', worldDef)
    await deps.appRuntime.waitForPendingTrimeshBuilds?.()
    ctx.peerSession = createPeerSimSession(ctx, { roster, localPubkey: pk, post: postFor(pk) })
    const origTick = ctx.appRuntime.tick.bind(ctx.appRuntime)
    ctx.appRuntime.tick = function (tickNum, dt) {
      origTick(tickNum, dt)
      const fire = fireFor(ctx)
      let row = fireLog.get(tickNum)
      if (!row) { row = {}; fireLog.set(tickNum, row) }
      row[pk] = fire ? { checksum: fire.checksum(), simTick: fire.simTick, active: fire.activeCount, step: fire.activeCount > 0 ? fire.world.kernel.stepIndex : -1, log: fire.activeCount > 0 ? fire.world.timeline.log.length : 0 } : null
    }
    peers.set(pk, ctx)
  }

  const t0 = performance.now()
  let seq = 1
  const feeders = roster.map((pk, i) => setInterval(() => {
    const ctx = peers.get(pk)
    ctx.playerManager.addInput(ctx.peerSession.localPlayerId, scriptedInput(performance.now() - t0, i * 700), seq++)
  }, 1000 / 60))
  for (const [i, pk] of roster.entries()) setTimeout(() => peers.get(pk).peerSession.start(), i * Number(args.startSkewMs || 400))
  await new Promise(r => setTimeout(r, DURATION_MS))
  feeders.forEach(clearInterval)

  const perPeer = {}
  for (const [pk, ctx] of peers) {
    const st = ctx.peerSession.getStats()
    ctx.peerSession.stop()
    ctx.tickSystem.stop()
    ctx.physics.destroy()
    const fire = fireFor(ctx)
    perPeer[pk] = {
      simTicks: st.loop?.simTick ?? null,
      rollbacks: st.loop?.rollbacks ?? null,
      maxRollbackDepth: st.loop?.maxRollbackDepth ?? null,
      desyncs: st.loop?.desyncs ?? null,
      firstDesyncTick: st.loop?.firstDesyncTick ?? null,
      fireRewinds: fire ? fire.rollbackStats.rewinds : null,
      fireResimTicks: fire ? fire.rollbackStats.resimTicks : null,
      fireDroppedRows: fire ? fire.rollbackStats.droppedRows : null,
      timelineRewinds: fire ? fire.world.timeline.stats.rewinds : null,
      timelineReplayedTicks: fire ? fire.world.timeline.stats.replayedTicks : null,
      timelineBeyondWindow: fire ? fire.world.timeline.stats.beyondWindow : null,
      activeCells: fire ? fire.activeCount : null,
      fireSimTick: fire ? fire.simTick : null,
      checksum: fire ? fire.checksum() : null,
    }
  }

  const ordered = [...fireLog.entries()].sort((a, b) => a[0] - b[0])
  const clockOf = pk => perPeer[pk].simTicks ?? perPeer[pk].fireSimTick ?? 0
  const settled = Math.min(...roster.map(clockOf)) - 14
  const comparable = ordered.filter(([t, row]) => t <= settled && roster.every(pk => row[pk] && row[pk].checksum !== null))
  let mismatches = 0, firstMismatch = null, simTickLag = 0
  for (const [t, row] of comparable) {
    if (row['peer-a'].checksum !== row['peer-b'].checksum) { mismatches++; if (firstMismatch === null) firstMismatch = t }
    if (row['peer-a'].simTick !== row['peer-b'].simTick) simTickLag++
  }
  console.log(`-- ${profileName} for ${DURATION_MS} ms at ${LAT}/${JIT}/${LOSS}`)
  for (const pk of roster) console.log(`  ${pk}: ${JSON.stringify(perPeer[pk])}`)
  console.log(`  fire checksums compared on ${comparable.length} tick(s) up to tick ${settled}: ${mismatches} mismatch(es), first ${firstMismatch}, fire simTick skew on ${simTickLag} tick(s)`)
  if (comparable.length === 0) failures.push(`${profileName}: no tick had a fire checksum on every peer, so no desync could be measured`)
  if (mismatches > 0) failures.push(`${profileName}: ${mismatches} fire checksum mismatch(es) over ${comparable.length} comparable tick(s), first at tick ${firstMismatch}`)
  if (mismatches > 0) {
    const bad = ordered.find(([t]) => t === firstMismatch)
    console.log(`  rows at first mismatch: ${JSON.stringify(bad?.[1])}`)
    console.log(`  tick trace: ${JSON.stringify(tickTrace.filter(e => e.igniteAt !== undefined || e.err).slice(0, 16))}`)
    console.log(`  tick trace head: ${JSON.stringify(tickTrace.slice(0, 24))}`)
  }
  return { mismatches, comparable: comparable.length }
}

const out = []
const failures = []
out.push(await run('rollback'))
out.push(await run('lockstep'))
console.log(JSON.stringify(out))
if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL ${f}`)
  process.exit(1)
}
process.exit(0)
