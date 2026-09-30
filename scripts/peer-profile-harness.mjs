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
const baseWorld = (await import(pathToFileURL(resolve(SDK_ROOT, 'apps/world', WORLD + '.js')).href)).default
const profileName = baseWorld.netcode?.profile
const overrides = {}
for (const k of ['inputDelayTicks', 'maxRollbackTicks', 'checksumIntervalTicks']) if (args[k] != null) overrides[k] = Number(args[k])
const worldDef = { ...baseWorld, netcode: { ...baseWorld.netcode, [profileName]: { ...(baseWorld.netcode?.[profileName] || {}), ...overrides } } }

async function bootPeer(pubkey, roster, post) {
  const tickRate = worldDef.tickRate || 60
  const deps = await createServerDeps({ gravity: worldDef.gravity, appsDirs: [resolve(SDK_ROOT, 'apps')], sdkRoot: SDK_ROOT, storageDir: resolve(SDK_ROOT, 'data', 'netcode-harness', 'peer-storage') }, tickRate)
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
  return { yaw: 0, pitch: 0 }
}

async function main() {
  const roster = ['peer-a', 'peer-b']
  const peers = new Map()
  const lanes = new Map(roster.map((pk, i) => [pk, { at: 0, delay: linkDelay(mulberry32(i + 3)) }]))
  const postFor = from => msg => {
    if (msg.type !== 'BRIDGE_BROADCAST') return
    for (const [pk, ctx] of peers) {
      if (pk === from) continue
      const lane = lanes.get(pk)
      const at = Math.max(lane.at, performance.now() + lane.delay())
      lane.at = at
      setTimeout(() => ctx.peerSession.bridge.deliver(from, msg.data), Math.max(0, at - performance.now()))
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
  const ordered = [...tickLog.entries()].sort((a, b) => a[0] - b[0])
  const settledTick = Math.min(...[...peers.values()].map(c => c.peerSession.loop.simTick)) - (worldDef.netcode?.[profileName]?.maxRollbackTicks ?? 12) - 2
  const inBoth = ([t, row]) => t <= settledTick && row['peer-a']?.players && row['peer-b']?.players
  const firstInputMismatch = ordered.filter(inBoth).find(([, row]) => JSON.stringify(row['peer-a'].used) !== JSON.stringify(row['peer-b'].used))
  const firstStateMismatch = ordered.filter(inBoth).find(([, row]) => JSON.stringify([row['peer-a'].players, row['peer-a'].bodies]) !== JSON.stringify([row['peer-b'].players, row['peer-b'].bodies]))
  feeders.forEach(clearInterval)
  const elapsedS = (performance.now() - t0) / 1000
  const summary = {}
  for (const [pk, ctx] of peers) {
    const st = ctx.peerSession.getStats()
    ctx.peerSession.stop()
    const l = st.loop, c = st.corrections
    summary[pk] = {
      simTicks: l.simTick, simHz: +(l.simTick / elapsedS).toFixed(1), stalls: l.stalls, timeSyncYields: l.timeSyncYields, advantage: l.localAdvantage, desyncs: l.desyncs, checksumsCompared: l.checksumsCompared,
      rollbacks: l.rollbacks, rollbacksPerS: +(l.rollbacks / elapsedS).toFixed(2), avgDepth: +l.avgRollbackDepth.toFixed(2), maxDepth: l.maxRollbackDepth, unrecoverable: l.unrecoverableRollbacks,
      mispredictions: l.mispredictions, remoteCorrectionAvgCm: c.count ? +(c.remoteSumM / Math.max(1, c.count / 2) * 100).toFixed(2) : 0, remoteCorrectionMaxCm: +(c.remoteMaxM * 100).toFixed(2),
      inputLatencyMs: +(l.simTick ? (st.options.inputDelayTicks * 1000 / (worldDef.tickRate || 60)) : 0).toFixed(1)
    }
  }
  console.log(JSON.stringify({ world: WORLD, profile: profileName, cond: { latencyMs: LAT, jitterMs: JIT, lossPct: LOSS }, peers: summary, firstInputMismatchTick: firstInputMismatch?.[0] ?? null, firstStateMismatchTick: firstStateMismatch?.[0] ?? null }))
  for (const ctx of peers.values()) { ctx.tickSystem.stop(); ctx.physics.destroy() }
  process.exit(0)
}

main().catch(e => { console.error('[peer-profile-harness] FATAL', e?.stack || e); process.exit(1) })
