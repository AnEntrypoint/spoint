#!/usr/bin/env node
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { createPreciseScheduler, ConditionedTransport, mulberry32 } from './lib/net-conditioner.mjs'
import { summarize, stdev, dist3, createTruthTrack, effectiveDelay, detectPops, fmt } from './lib/netcode-metrics.mjs'

process.env.SPOINT_NO_WATCH = '1'
process.env.SPOINT_SKIP_PREWARM = '1'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = resolve(SDK_ROOT, 'data', 'netcode-harness')
const FEET_OFFSET = 0.91
const HITBOX_CENTER_HEIGHT = 0.9
const HITBOX_RADIUS = 0.6
const MOVE_ONSET_M = 0.03
const MISPREDICT_M = 0.02

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true'] }))
if (args.precise === 'true') process.env.SPOINT_PRECISE_TICKS = '1'
const DURATION_MS = Number(args.duration || 20000)
const WORLD = args.world || 'arena'
const HARNESS_ARENA = {
  name: 'netcode-harness-arena', tickRate: 60, gravity: [0, -9.81, 0], spawnPoints: [[0, 3, 0], [0, 3, 8]],
  entities: [{ id: 'floor', app: 'box-static', position: [0, -1, 0], config: { hx: 100, hy: 1, hz: 100 } }]
}
const FPS = Number(args.fps || 60)
const BOTS = Number(args.bots || 0)
const CHANNEL = args.channel || 'ws'
const TICK_OVERRIDE = args.tick ? Number(args.tick) : null
const PREDICT_MODES = (args.predict || 'off,on').split(',').map(s => s === 'on')
const CONDITIONS = args.cond
  ? args.cond.split(';').map(c => { const [l, j, p] = c.split('/').map(Number); return { latencyMs: l, jitterMs: j, lossPct: p } })
  : [{ latencyMs: 0, jitterMs: 0, lossPct: 0 }, { latencyMs: 25, jitterMs: 5, lossPct: 1 }, { latencyMs: 50, jitterMs: 10, lossPct: 2 }, { latencyMs: 75, jitterMs: 15, lossPct: 5 }]

const { createServer } = await import('../src/sdk/server.js')
const { PhysicsNetworkClient } = await import('../src/client/PhysicsNetworkClient.js')
const { MSG } = await import('../src/protocol/MessageTypes.js')
const { unpack } = await import('../src/protocol/msgpack.js')
const MSG_NAMES = new Map(Object.entries(MSG).map(([k, v]) => [v, k]))
const { createSceneGraph } = await import('../client/core/SceneGraph.js')
const { resolveTargetPoint, resolveFireRequest, findHitLinear } = await import('../apps/tps-game/server.js')

function freePort() {
  return new Promise((res, rej) => { const s = createNetServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
}

function fakeGroup() {
  const position = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z } }
  const quaternion = { x: 0, y: 0, z: 0, w: 1, normalize() {} }
  return { position, quaternion, userData: {}, visible: true, removeFromParent() {} }
}

function wishDir(input) {
  let fx = 0, fz = 0
  if (input.forward) fz += 1; if (input.backward) fz -= 1; if (input.left) fx -= 1; if (input.right) fx += 1
  const len = Math.hypot(fx, fz)
  if (!len) return null
  fx /= len; fz /= len
  const yaw = input.yaw || 0, cy = Math.cos(yaw), sy = Math.sin(yaw)
  return [fz * sy - fx * cy, 0, fx * sy + fz * cy]
}

const MOVER_SCRIPT = [
  [700, {}], [500, { right: true }], [700, {}], [500, { left: true }], [700, {}],
  [450, { forward: true }], [350, { forward: true, right: true }], [350, { left: true }], [700, {}],
  [500, { backward: true, sprint: true }], [700, {}], [400, { forward: true, jump: true }], [900, {}]
]
const SCRIPT_MS = MOVER_SCRIPT.reduce((s, [d]) => s + d, 0)
function moverInputAt(ms) {
  let t = ms % SCRIPT_MS
  for (const [d, inp] of MOVER_SCRIPT) { if (t < d) return { ...inp, yaw: 0, pitch: 0 }; t -= d }
  return { yaw: 0, pitch: 0 }
}

function createHarnessClient({ url, profile, predict, scheduler, seed }) {
  const meter = { inBytes: 0, outBytes: 0, inMsgs: 0, outMsgs: 0, byType: {} }
  const view = { sceneGraph: createSceneGraph({ add() {} }, null), nodes: new Map() }
  let client
  class HarnessClient extends PhysicsNetworkClient {
    _resolveNetSimProfile() { return profile }
    _wrapNetSim(t) { const c = new ConditionedTransport(t, profile, scheduler, meter, seed); this._netSim = c; return c }
    _handleOneMessage(bytes) {
      let type = -1
      try { type = unpack(bytes).type } catch {}
      const k = MSG_NAMES.get(type) || String(type)
      meter.byType[k] = (meter.byType[k] || 0) + bytes.length
      return super._handleOneMessage(bytes)
    }
  }
  const snapTimes = []
  client = new HarnessClient({
    url, predictionEnabled: predict, smoothInterpolation: true, autoMigrate: false, webTransport: { enabled: false },
    onSnapshot: () => snapTimes.push(performance.now()),
    onStateUpdate: state => {
      const lid = client.playerId
      for (const p of state.players) if (!view.nodes.has(p.id)) { const g = fakeGroup(); view.nodes.set(p.id, g); view.sceneGraph.addNode(p.id, g, { isPlayer: true, feetOffset: FEET_OFFSET }) }
      view.sceneGraph.setPlayerTransforms(state.players, lid, () => client.getRenderState())
    }
  })
  return { client, meter, view, snapTimes }
}

function viewPos(h, id) {
  const g = h.view.nodes.get(id)
  return g && g.userData.initialized ? [g.position.x, g.position.y + FEET_OFFSET, g.position.z] : null
}

function instrumentPrediction(h, rec) {
  const pe = h.client._msgHandler.getPredEngine()
  if (!pe || pe.__harness) return !!pe
  pe.__harness = true
  const onSnap = pe.onServerSnapshot.bind(pe)
  let lastAck = -1
  pe.onServerSnapshot = (snap, tick) => {
    const sp = snap.players?.[0]
    const before = pe.stats.corrections
    if (sp && sp.inputSequence > lastAck) {
      lastAck = sp.inputSequence
      const pred = pe.predictedAt(sp.inputSequence)
      if (pred) {
        const e = dist3(sp.position, pred.position)
        rec.mispredict.push(e)
        if (e > MISPREDICT_M && rec.worst.length < 40) rec.worst.push({ seq: sp.inputSequence, errM: e, server: { p: [...sp.position], v: [...sp.velocity], g: sp.onGround }, predicted: { p: [...pred.position], v: [...pred.velocity], g: pred.onGround }, input: pred.data })
      }
    }
    const r = onSnap(snap, tick)
    if (pe.stats.corrections > before) { rec.corrections++; rec.correctionJumpM.push(pe.stats.lastCorrectionM) }
    return r
  }
  return true
}

async function runOne(cond, predict, worldDef) {
  const port = await freePort()
  const tickRate = TICK_OVERRIDE || worldDef.tickRate || 60
  const server = await createServer({ port, tickRate, appsDirs: [resolve(SDK_ROOT, 'apps')], sdkRoot: SDK_ROOT, gravity: worldDef.gravity, staticDirs: [], storageDir: resolve(process.cwd(), 'data') })
  await server.loadWorld(worldDef)
  await server.start()
  const scheduler = createPreciseScheduler()
  const truth = new Map(), tickTimes = []
  server.tickSystem.onTick(() => {
    const now = performance.now()
    tickTimes.push(now)
    for (const p of server.playerManager.getConnectedPlayers()) {
      let tr = truth.get(p.id)
      if (!tr) { tr = createTruthTrack(); truth.set(p.id, tr) }
      tr.push(now, p.state.position)
    }
  })
  const profile = { ...cond, channel: CHANNEL }
  const url = `ws://127.0.0.1:${port}/ws`
  const mover = createHarnessClient({ url, profile, predict, scheduler, seed: 11 })
  const shooter = createHarnessClient({ url, profile, predict, scheduler, seed: 23 })
  const bots = Array.from({ length: BOTS }, (_, i) => createHarnessClient({ url, profile, predict, scheduler, seed: 100 + i }))
  const all = [mover, shooter, ...bots]
  const shots = []
  server.connections.on('message', (clientId, msg) => {
    if (msg.type !== MSG.APP_EVENT || msg.payload?.type !== 'fire') return
    const pl = msg.payload
    const shooterP = server.playerManager.getPlayer(clientId), target = server.playerManager.getPlayer(mover.client.playerId)
    if (!shooterP || !target) return
    const lc = server.lagCompensator
    const { origin, viewTick } = resolveFireRequest(lc, clientId, shooterP.state.position, pl)
    const tpsCtx = { lagCompensator: lc, state: { respawning: new Map(), invuln: new Map(), config: { health: 100 } } }
    const found = findHitLinear(tpsCtx, [target], clientId, origin, pl.direction, viewTick, 1000)
    const resolved = resolveTargetPoint(target, lc, viewTick)
    const c = [resolved.tp[0], resolved.tp[1] + HITBOX_CENTER_HEIGHT, resolved.tp[2]]
    const d = pl.direction, to = [c[0] - origin[0], c[1] - origin[1], c[2] - origin[2]]
    const along = to[0] * d[0] + to[1] * d[1] + to[2] * d[2]
    const missM = Math.hypot(to[0] - d[0] * along, to[1] - d[1] * along, to[2] - d[2] * along)
    const rewindTicks = viewTick == null ? 0 : lc.latestTick - viewTick
    shots.push({ hit: !!found, missM, rewindMs: rewindTicks * 1000 / lc.tickRate, victimBehindLiveM: dist3(resolved.tp, target.state.position), shooterViewErrM: pl.viewErrM, rejected: viewTick == null })
  })
  await Promise.all(all.map(h => h.client.connect()))
  const t0 = performance.now()
  while (!all.every(h => h.client.playerId) && performance.now() - t0 < 10000) await new Promise(r => setTimeout(r, 20))
  const place = (h, pos) => { const p = server.playerManager.getPlayer(h.client.playerId); if (!p) return; p.state.position[0] = pos[0]; p.state.position[1] = pos[1]; p.state.position[2] = pos[2]; server.physicsIntegration.setPlayerPosition(p.id, pos) }
  place(mover, [0, 1.2, 0]); place(shooter, [0, 1.2, 10])
  bots.forEach((b, i) => place(b, [20 + 4 * i, 1.2, -20]))
  const rec = { mispredict: [], correctionJumpM: [], corrections: 0, worst: [] }
  const localFrames = [], remoteFrames = [], interpStats = [], meshLag = []
  const onsets = []
  let lastMoverInput = {}, runStart = 0, lastFrameAt = 0, shootAcc = 0, meterBase = null
  const botRng = mulberry32(7)
  const botInputs = bots.map(() => ({ yaw: 0, pitch: 0 }))
  runStart = performance.now() + 1500
  const shooterRec = { mispredict: [], correctionJumpM: [], corrections: 0, worst: [] }
  mover.client.startInputLoop(() => {
    const now = performance.now()
    if (!meterBase && now >= runStart) meterBase = all.map(h => ({ inBytes: h.meter.inBytes, outBytes: h.meter.outBytes, inMsgs: h.meter.inMsgs, snap: h.meter.byType.SNAPSHOT || 0 }))
    instrumentPrediction(mover, rec)
    const inp = now < runStart ? { yaw: 0, pitch: 0 } : moverInputAt(now - runStart)
    const dir = wishDir(inp)
    if (dir && !wishDir(lastMoverInput) && now >= runStart) {
      const mid = mover.client.playerId
      onsets.push({ t: now, dir, localStart: viewPos(mover, mid), remoteStart: viewPos(shooter, mid), truthStart: truth.get(mid)?.at(now) ? [...truth.get(mid).at(now)] : null, local: null, remote: null, server: null })
    }
    lastMoverInput = inp
    return inp
  })
  shooter.client.startInputLoop(() => { instrumentPrediction(shooter, shooterRec); return { yaw: 0, pitch: 0 } })
  bots.forEach((b, i) => b.client.startInputLoop(() => { if (botRng() < 0.03) botInputs[i] = { forward: botRng() < 0.6, left: botRng() < 0.3, right: botRng() < 0.3, yaw: botRng() * 6.28, pitch: 0 }; return botInputs[i] }))
  const stopInput = () => all.forEach(h => h.client.stopInputLoop())
  const stopFrames = scheduler.every(1000 / FPS, now => {
    const frameDt = lastFrameAt ? (now - lastFrameAt) / 1000 : 1 / FPS
    lastFrameAt = now
    for (const h of all) {
      const lerp = 1.0 - Math.exp(-((h.client.getRTT() > 100 ? 24 : 16)) * frameDt)
      if (h.client.config.predictionEnabled && h.client.playerId != null) h.view.sceneGraph.setLocalPlayerTransform(h.client.playerId, h.client.getRenderState())
      if (h.client.getInterpolatedState) h.view.sceneGraph.setRemotePlayerTransforms(h.client.getInterpolatedState(now).players, h.client.playerId)
      h.view.sceneGraph.tick(frameDt, lerp)
    }
    if (!runStart || now < runStart) return
    const mid = mover.client.playerId, sid = shooter.client.playerId
    const lp = viewPos(mover, mid), rp = viewPos(shooter, mid)
    const ls = mover.client.getLocalState()
    if (lp && ls) { localFrames.push({ t: now, p: lp, v: [...ls.velocity] }); meshLag.push(dist3(lp, ls.position)) }
    if (rp) remoteFrames.push({ t: now, p: rp })
    if (shooter.client.getInterpolationStats) interpStats.push(shooter.client.getInterpolationStats())
    const trM = truth.get(mid)
    for (const o of onsets) {
      const along = (p, s) => p && s ? (p[0] - s[0]) * o.dir[0] + (p[2] - s[2]) * o.dir[2] : -Infinity
      if (o.local == null && along(lp, o.localStart) >= MOVE_ONSET_M) o.local = now - o.t
      if (o.remote == null && along(rp, o.remoteStart) >= MOVE_ONSET_M) o.remote = now - o.t
      if (o.server == null && trM && along(trM.at(now), o.truthStart) >= MOVE_ONSET_M) o.server = now - o.t
    }
    shootAcc += frameDt
    if (shootAcc >= 0.2 && rp && sid) {
      shootAcc = 0
      const sp = shooter.client.getLocalState()?.position
      if (sp) {
        const origin = [sp[0], sp[1] + HITBOX_CENTER_HEIGHT, sp[2]], aim = [rp[0], rp[1] + HITBOX_CENTER_HEIGHT, rp[2]]
        const len = Math.hypot(aim[0] - origin[0], aim[1] - origin[1], aim[2] - origin[2]) || 1
        const truthNow = trM?.at(now)
        shooter.client.sendFire({ origin, direction: [(aim[0] - origin[0]) / len, (aim[1] - origin[1]) / len, (aim[2] - origin[2]) / len], viewErrM: truthNow ? dist3(rp, truthNow) : null })
      }
    }
  })
  await new Promise(r => setTimeout(r, DURATION_MS + 1500))
  stopInput(); stopFrames()
  const elapsedS = (performance.now() - runStart) / 1000
  const mid = mover.client.playerId
  const trM = truth.get(mid)
  const intervals = []
  for (let i = 1; i < tickTimes.length; i++) intervals.push(tickTimes[i] - tickTimes[i - 1])
  const sTimes = shooter.snapTimes.filter(t => t >= runStart)
  const snapGaps = []
  for (let i = 1; i < sTimes.length; i++) snapGaps.push(sTimes[i] - sTimes[i - 1])
  const tickSpanS = (tickTimes[tickTimes.length - 1] - tickTimes[0]) / 1000
  const result = {
    cond, predict, channel: CHANNEL, tickRate, fps: FPS, bots: BOTS, durationS: elapsedS,
    rttMs: mover.client.getRTT(),
    inputToVisual: {
      localMs: summarize(onsets.map(o => o.local)), remoteMs: summarize(onsets.map(o => o.remote)), serverMs: summarize(onsets.map(o => o.server)), onsets: onsets.length
    },
    mispredict: predict ? { rate: rec.mispredict.filter(e => e > MISPREDICT_M).length / Math.max(1, rec.mispredict.length), errM: summarize(rec.mispredict), correctionsApplied: rec.corrections, correctionRate: rec.corrections / Math.max(1, rec.mispredict.length), correctionJumpM: summarize(rec.correctionJumpM), shooterCorrections: shooterRec.corrections, worst: rec.worst } : null,
    serverInput: (() => { const p = server.playerManager.getPlayer(mid); return p ? { starves: p.inputStarves || 0, catchUps: p.inputCatchUps || 0, depth: p.inputBufferDepth ?? null, starvesPerS: (p.inputStarves || 0) / elapsedS } : null })(),
    inputRateAdjust: mover.client._inputRateAdjust,
    localVisual: { ...detectPops(localFrames), popsPerMin: detectPops(localFrames).pops / (elapsedS / 60), meshBehindPredictedM: summarize(meshLag), vsServerPresent: trM ? summarize(localFrames.map(f => dist3(f.p, trM.at(f.t)))) : null },
    remoteInterp: trM ? effectiveDelay(remoteFrames, trM) : null,
    interpolation: interpStats.length ? { targetDelayMs: summarize(interpStats.map(s => s.delayMs)), jitterMs: summarize(interpStats.map(s => s.jitterMs)), intervalMs: summarize(interpStats.map(s => s.intervalMs)), ahead: summarize(interpStats.map(s => s.ahead)), final: interpStats[interpStats.length - 1] } : null,
    remotePops: detectPops(remoteFrames.map((f, i) => ({ ...f, v: i ? [(f.p[0] - remoteFrames[i - 1].p[0]) / ((f.t - remoteFrames[i - 1].t) / 1000 || 1), 0, (f.p[2] - remoteFrames[i - 1].p[2]) / ((f.t - remoteFrames[i - 1].t) / 1000 || 1)] : [0, 0, 0] }))),
    hitReg: { shots: shots.length, hitRate: shots.filter(s => s.hit).length / Math.max(1, shots.length), missM: summarize(shots.map(s => s.missM)), shooterViewVsPresentM: summarize(shots.map(s => s.shooterViewErrM)), rewindMs: summarize(shots.map(s => s.rewindMs)), victimBehindLiveM: summarize(shots.map(s => s.victimBehindLiveM)), rejectedViewTicks: shots.filter(s => s.rejected).length, lagCompStats: server.lagCompensator.getStats() },
    bandwidth: { downKBps: (mover.meter.inBytes - meterBase[0].inBytes) / 1024 / elapsedS, upKBps: (mover.meter.outBytes - meterBase[0].outBytes) / 1024 / elapsedS, downMsgsPerS: (mover.meter.inMsgs - meterBase[0].inMsgs) / elapsedS, snapshotBytesAvg: ((mover.meter.byType.SNAPSHOT || 0) - meterBase[0].snap) / Math.max(1, mover.snapTimes.filter(t => t >= runStart).length), shooterDownKBps: (shooter.meter.inBytes - meterBase[1].inBytes) / 1024 / elapsedS, moverDownBytesByType: mover.meter.byType },
    snapshots: { hz: sTimes.length / elapsedS, gapMs: summarize(snapGaps), gapStdevMs: stdev(snapGaps) },
    ticks: { hz: (tickTimes.length - 1) / tickSpanS, intervalMs: summarize(intervals), intervalStdevMs: stdev(intervals), burstFrac: intervals.filter(x => x < 2).length / Math.max(1, intervals.length) },
    conditioner: { mover: mover.client._netSim?.getStats?.() || null }
  }
  for (const h of all) { try { h.client.disconnect() } catch {} }
  scheduler.stop()
  await new Promise(r => setTimeout(r, 200))
  server.stop()
  await new Promise(r => setTimeout(r, 300))
  return result
}

function row(r) {
  const c = r.cond, iv = r.inputToVisual, m = r.mispredict, ri = r.remoteInterp, h = r.hitReg
  return `| ${c.latencyMs}/${c.jitterMs}/${c.lossPct}% | ${r.predict ? 'on' : 'off'} | ${fmt(r.rttMs, 0)} | ${fmt(iv.localMs.p50, 0)}/${fmt(iv.localMs.p95, 0)} | ${fmt(iv.remoteMs.p50, 0)} | ${m ? fmt(m.rate * 100, 0) + '%' : '-'} | ${m ? fmt(m.errM.p95 * 100, 1) : '-'} | ${fmt(r.localVisual.popsPerMin, 0)} | ${fmt(r.localVisual.maxBackM * 100, 1)} | ${ri ? ri.delayMs : '-'} | ${ri ? fmt(ri.errAtDelay.mean * 100, 1) : '-'} | ${ri ? fmt(ri.errVsPresent.mean * 100, 0) : '-'} | ${fmt(h.hitRate * 100, 0)}% | ${fmt(h.missM.p50 * 100, 0)} | ${fmt(r.bandwidth.downKBps, 1)}/${fmt(r.bandwidth.upKBps, 1)} | ${fmt(r.snapshots.hz, 1)} | ${fmt(r.ticks.hz, 1)} p99 ${fmt(r.ticks.intervalMs.p99, 1)} | ${r.serverInput ? fmt(r.serverInput.starvesPerS, 1) : '-'} |`
}

async function main() {
  const workDir = resolve(OUT_DIR, `work-${process.pid}`)
  await mkdir(resolve(workDir, 'data'), { recursive: true })
  process.chdir(workDir)
  const worldDef = WORLD === 'arena' ? HARNESS_ARENA : (await import(pathToFileURL(resolve(SDK_ROOT, 'apps/world', WORLD + '.js')).href)).default
  const results = []
  for (const cond of CONDITIONS) for (const predict of PREDICT_MODES) {
    console.log(`[netcode-harness] run latency=${cond.latencyMs}ms jitter=${cond.jitterMs}ms loss=${cond.lossPct}% predict=${predict} channel=${CHANNEL}`)
    results.push(await runOne(cond, predict, worldDef))
  }
  const header = '| one-way ms/jitter/loss | predict | RTT | local in->visual p50/p95 ms | remote in->visual p50 ms | mispredict rate | mispredict p95 cm | local pops/min | max pop cm | remote eff. delay ms | remote err@delay cm | remote err vs present cm | hit% (aim at view) | miss p50 cm | KB/s down/up | snap Hz | tick Hz / p99 interval ms | input starves/s |\n|' + '---|'.repeat(18)
  const table = [header, ...results.map(row)].join('\n')
  console.log('\n' + table + '\n')
  const outPath = resolve(OUT_DIR, `run-${Date.now()}.json`)
  await writeFile(outPath, JSON.stringify({ world: WORLD, channel: CHANNEL, fps: FPS, results, table }, null, 2))
  console.log(`[netcode-harness] wrote ${outPath}`)
  process.exit(0)
}

main().catch(e => { console.error('[netcode-harness] FATAL', e?.stack || e); process.exit(1) })
