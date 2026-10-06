#!/usr/bin/env node
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mulberry32 } from './lib/net-conditioner.mjs'
import { summarize } from './lib/netcode-metrics.mjs'

process.env.SPOINT_NO_WATCH = '1'
const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true'] }))
const WORLD = args.world || 'rollback-duel'
const DURATION_MS = Number(args.duration || 15000)
const [LAT, JIT, LOSS] = (args.cond || '25/5/1').split('/').map(Number)

const { createServerDeps, wireServerHandlers } = await import('../src/sdk/server.js')
const { createPeerSimSession } = await import('../src/netcode/PeerSimSession.js')
const { loadWorldModule } = await import('../src/sdk/WorldLocator.js')
const baseWorld = await loadWorldModule(resolve(SDK_ROOT, 'apps/world', WORLD + '.js'))
const profileName = args.profile || baseWorld.netcode?.profile || 'authoritative'
const overrides = {}
for (const k of ['inputDelayTicks', 'maxRollbackTicks', 'checksumIntervalTicks', 'stallTicks', 'maxCatchUpTicks']) if (args[k] != null) overrides[k] = Number(args[k])
const PEER_COUNT = Number(args.peers || baseWorld.netcode?.peers || 2)
const KILL_PEER = args.killPeer || null, KILL_AT_MS = Number(args.killAtMs || 0)
const CHEAT_PEER = args.cheatPeer || null, CHEAT_AT_MS = Number(args.cheatAtMs || 0)
const DEAD_LANES = new Set(String(args.deadLink || '').split(',').map(s => s.trim()).filter(Boolean))
const worldDef = { ...baseWorld, netcode: { ...baseWorld.netcode, [profileName]: { ...(baseWorld.netcode?.[profileName] || {}), ...overrides } } }

async function bootPeer(pubkey, roster, post) {
  const tickRate = worldDef.tickRate || 60
  const deps = await createServerDeps({ gravity: worldDef.gravity, appsDirs: [resolve(SDK_ROOT, 'apps'), resolve(SDK_ROOT, 'src', 'stdlib-apps')], sdkRoot: SDK_ROOT, storageDir: resolve(SDK_ROOT, 'data', 'netcode-harness', 'peer-storage') }, tickRate)
  const ctx = {
    config: {}, tickRate, gravity: worldDef.gravity, movement: worldDef.movement || {}, ...deps,
    currentWorldDef: worldDef, worldSpawnPoints: worldDef.spawnPoints, worldSpawnPoint: worldDef.spawnPoints[0],
    snapshotSeq: 0, handlerState: { fn: null },
    setTickHandler: fn => { ctx.handlerState.fn = fn; ctx.tickHandlerFn = fn }
  }
  wireServerHandlers(ctx)
  await deps.appLoader.loadAll()
  deps.stageLoader.loadFromDefinition('main', worldDef)
  await deps.appRuntime.waitForPendingTrimeshBuilds?.()
  ctx.peerSession = createPeerSimSession(ctx, { roster, localPubkey: pubkey, post })
  return ctx
}

function linkDelay(rng) {
  const halfNormal = () => { let u = 0; while (u === 0) u = rng(); return Math.abs(Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())) }
  return () => LAT + JIT * halfNormal() + (rng() * 100 < LOSS ? 2 * LAT + JIT : 0)
}

function scriptedInput(ms, phase) {
  const t = (ms + phase) % 2400
  if (t < 600) return { right: true, yaw: 0, pitch: 0 }
  if (t < 900) return { jump: true, yaw: 0, pitch: 0 }
  if (t < 1500) return { left: true, forward: t > 1200, yaw: 0, pitch: 0 }
  if (t < 1800) return { interact: true, yaw: 0, pitch: 0 }
  if (t < 1900) return { shoot: true, yaw: 0, pitch: 0 }
  return { yaw: 0, pitch: 0 }
}

function cheat(ctx) {
  const e = ctx.appRuntime.entities.get('unit-0-0') || [...ctx.appRuntime.entities.values()].find(x => x.bodyType === 'dynamic')
  if (e) e.position[1] += 0.01
}

function peerSummary(st, elapsedS) {
  const l = st.loop, c = st.corrections
  const base = { simTicks: l.simTick, simHz: +(l.simTick / elapsedS).toFixed(1), stalls: l.stalls, desyncs: l.desyncs, checksumsCompared: l.checksumsCompared, firstDesyncTick: l.firstDesyncTick }
  if (st.profile === 'lockstep') {
    return { ...base, timeSyncYields: l.timeSyncYields, advantage: l.localAdvantage, catchUpTicks: l.catchUpTicks, maxStallRun: l.maxStallRun, inputLatencyMs: l.inputLatencyMs, drops: l.dropLog, evicted: l.evicted, ejections: l.voter?.ejectionsFired ?? 0, unattributedDesyncs: l.voter?.unattributedDesyncs ?? 0, lateInputsIgnored: l.lateInputsIgnored,
      driverTicks: l.driverTicks, driverHz: +(l.driverTicks / elapsedS).toFixed(1), simPerDriver: +(l.simTick / Math.max(1, l.driverTicks)).toFixed(3), smoothedAdvantage: l.smoothedAdvantage, remoteAdvantageMax: l.remoteAdvantageMax, connectingTicks: l.connectingTicks, connectingTicksByPeer: l.connectingTicksByPeer }
  }
  return {
    ...base, timeSyncYields: l.timeSyncYields, advantage: l.localAdvantage,
    rollbacks: l.rollbacks, rollbacksPerS: +(l.rollbacks / elapsedS).toFixed(2), avgDepth: +l.avgRollbackDepth.toFixed(2), maxDepth: l.maxRollbackDepth, unrecoverable: l.unrecoverableRollbacks,
    mispredictions: l.mispredictions, remoteCorrectionAvgCm: c.count ? +(c.remoteSumM / Math.max(1, c.count / 2) * 100).toFixed(2) : 0, remoteCorrectionMaxCm: +(c.remoteMaxM * 100).toFixed(2),
    inputLatencyMs: +(l.simTick ? (st.options.inputDelayTicks * 1000 / (worldDef.tickRate || 60)) : 0).toFixed(1)
  }
}

async function main() {
  const roster = Array.from({ length: PEER_COUNT }, (_, i) => 'peer-' + String.fromCharCode(97 + i))
  const peers = new Map()
  const dead = new Set()
  const lanes = new Map()
  for (const a of roster) for (const b of roster) if (a !== b) lanes.set(a + '>' + b, { at: 0, delay: linkDelay(mulberry32(lanes.size + 3)) })
  const postFor = from => msg => {
    if (msg.type !== 'BRIDGE_BROADCAST' || dead.has(from)) return
    for (const [pk, ctx] of peers) {
      if (pk === from || DEAD_LANES.has(from + '>' + pk)) continue
      const lane = lanes.get(from + '>' + pk)
      const at = Math.max(lane.at, performance.now() + lane.delay())
      lane.at = at
      setTimeout(() => { if (!dead.has(from)) ctx.peerSession.bridge.deliver(from, msg.data) }, Math.max(0, at - performance.now()))
    }
  }
  for (const pk of roster) peers.set(pk, await bootPeer(pk, roster, postFor(pk)))
  const t0 = performance.now()
  let seq = 1
  const feeders = roster.map((pk, i) => setInterval(() => {
    const ctx = peers.get(pk)
    ctx.playerManager.addInput(ctx.peerSession.localPlayerId, scriptedInput(performance.now() - t0, i * 700), seq++)
  }, 1000 / 60))
  for (const [i, pk] of roster.entries()) setTimeout(() => peers.get(pk).peerSession.start(), i * Number(args.startSkewMs || 400))
  if (KILL_PEER) setTimeout(() => { dead.add(KILL_PEER); peers.get(KILL_PEER).peerSession.loop.stop() }, KILL_AT_MS)
  let cheater = null
  if (CHEAT_PEER) setTimeout(() => { cheater = setInterval(() => cheat(peers.get(CHEAT_PEER)), 1000 / 60) }, CHEAT_AT_MS)
  const tickLog = new Map()
  const logger = setInterval(() => {
    for (const [pk, ctx] of peers) {
      const loop = ctx.peerSession.loop
      for (let t = Math.max(1, loop.simTick - 40); t <= loop.simTick; t++) {
        const info = loop.inspectTick(t)
        if (!info.used) continue
        let row = tickLog.get(t); if (!row) { row = {}; tickLog.set(t, row) }
        const players = info.snapshot ? [...info.snapshot.players.entries()].map(([id, p]) => [id, p.state.position, p.state.onGround]) : null
        const bodies = info.snapshot ? [...info.snapshot.bodies.entries()].map(([id, b]) => [id, b.position]) : null
        row[pk] = { used: info.used, checksum: info.checksum ?? row[pk]?.checksum ?? null, players, bodies }
      }
    }
  }, 50)
  await new Promise(r => setTimeout(r, DURATION_MS))
  clearInterval(logger)
  if (cheater) clearInterval(cheater)
  const honest = roster.filter(pk => pk !== KILL_PEER && pk !== CHEAT_PEER)
  if (honest.length < 2) {
    console.error(`[peer-profile-harness] ${honest.length} honest peer(s) to compare -- a single peer is compared against itself, so no divergence can be seen`)
    process.exit(1)
  }
  const ordered = [...tickLog.entries()].sort((a, b) => a[0] - b[0])
  const settleMargin = profileName === 'rollback' ? (worldDef.netcode?.rollback?.maxRollbackTicks ?? 12) + 2 : 0
  const settledTick = Math.min(...honest.map(pk => peers.get(pk).peerSession.loop.simTick)) - settleMargin
  const inAll = ([t, row]) => t <= settledTick && honest.every(pk => row[pk])
  const differs = (row, pick) => honest.some(pk => JSON.stringify(pick(row[pk])) !== JSON.stringify(pick(row[honest[0]])))
  const comparable = ordered.filter(inAll)
  const firstInputMismatch = comparable.find(([, row]) => differs(row, r => r.used))
  const firstStateMismatch = comparable.filter(([, row]) => honest.every(pk => row[pk].players)).find(([, row]) => differs(row, r => [r.players, r.bodies]))
  feeders.forEach(clearInterval)
  const elapsedS = (performance.now() - t0) / 1000
  const summary = {}
  for (const [pk, ctx] of peers) {
    const st = ctx.peerSession.getStats()
    ctx.peerSession.stop()
    summary[pk] = peerSummary(st, elapsedS)
  }
  console.log(JSON.stringify({ world: WORLD, profile: profileName, peers: PEER_COUNT, cond: { latencyMs: LAT, jitterMs: JIT, lossPct: LOSS }, killed: KILL_PEER, cheater: CHEAT_PEER, ticksCompared: comparable.length, peerStats: summary, firstInputMismatchTick: firstInputMismatch?.[0] ?? null, firstStateMismatchTick: firstStateMismatch?.[0] ?? null }))
  for (const ctx of peers.values()) { ctx.tickSystem.stop(); ctx.physics.destroy() }
  if (!(comparable.length > 0 && !firstInputMismatch && !firstStateMismatch)) {
    console.error(`[peer-profile-harness] FAIL: ${comparable.length} tick(s) compared, firstInputMismatchTick=${firstInputMismatch?.[0] ?? null}, firstStateMismatchTick=${firstStateMismatch?.[0] ?? null}`)
    process.exit(1)
  }
  process.exit(0)
}

main().catch(e => { console.error('[peer-profile-harness] FATAL', e?.stack || e); process.exit(1) })
