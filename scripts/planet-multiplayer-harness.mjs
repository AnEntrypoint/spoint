#!/usr/bin/env node
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fork } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { Session } from 'node:inspector/promises'
import { summarize, dist3 } from './lib/netcode-metrics.mjs'

process.env.SPOINT_NO_WATCH = '1'
process.env.SPOINT_SKIP_PREWARM = '1'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true'] }))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const round = (x, d = 3) => x == null || !Number.isFinite(x) ? x : Number(x.toFixed(d))
const GOLDEN = 2.39996323
const RELEVANCE_M = 200
const HYSTERESIS_FACTOR = 1.15

if (args.child) await runChild()
else await runParent()

async function runChild() {
  const { PhysicsNetworkClient } = await import('../src/client/PhysicsNetworkClient.js')
  const { unpack } = await import('../src/protocol/msgpack.js')
  const { MSG } = await import('../src/protocol/MessageTypes.js')
  const names = new Map(Object.entries(MSG).map(([k, v]) => [v, k]))
  const clients = new Map()
  let shootTimer = null
  const send = m => process.send(m)
  const finite = v => Array.isArray(v) && v.every(Number.isFinite)

  function makeClient(spec, url) {
    const meter = { inBytes: 0, outBytes: 0, inMsgs: 0, outMsgs: 0, byType: {}, nanStates: 0, errors: [], snapshots: 0, epochs: 0 }
    class Probe extends PhysicsNetworkClient {
      _handleOneMessage(bytes) {
        meter.inBytes += bytes.length; meter.inMsgs++
        let type = -1
        try { type = unpack(bytes).type } catch {}
        const k = names.get(type) || String(type)
        meter.byType[k] = (meter.byType[k] || 0) + bytes.length
        if (type === MSG.SNAPSHOT) { meter.snapshots++; if (meter.firstSnapshotBytes == null) meter.firstSnapshotBytes = bytes.length }
        return super._handleOneMessage(bytes)
      }
      _rawSend(buf, unreliable) { meter.outBytes += buf.length; meter.outMsgs++; return super._rawSend(buf, unreliable) }
    }
    const rec = { spec, meter, client: null, visible: [], walking: false, yaw: spec.yaw, aim: null, lastFire: 0, correctionsBase: 0, acksBase: 0, teleport: null }
    rec.client = new Probe({
      url, predictionEnabled: spec.predict, smoothInterpolation: true, collisionMirror: args.mirror === 'on', autoMigrate: false, webTransport: { enabled: false },
      onStateUpdate: state => {
        const ids = []
        for (const p of state.players) {
          ids.push(p.id)
          if (!finite(p.position)) meter.nanStates++
        }
        rec.visible = ids
        if (rec.firstVisible == null) rec.firstVisible = ids.length
      },
      onMessageError: (kind, e) => { if (meter.errors.length < 8) meter.errors.push(`${kind}:${e?.message || e}`) },
      onChartReanchor: () => { meter.epochs++ }
    })
    rec.client.startInputLoop(() => {
      if (args.trace && !rec.traced) traceCorrections(rec)
      return { forward: rec.walking, sprint: rec.walking, yaw: rec.yaw, pitch: 0 }
    })
    return rec
  }

  function traceCorrections(rec) {
    const pe = rec.client._msgHandler.getPredEngine()
    if (!pe) return
    rec.traced = true
    rec.trace = []
    const original = pe._reconcile.bind(pe)
    pe._reconcile = server => {
      const entry = pe.predictedAt(server.inputSequence ?? -1)
      const before = pe.stats.corrections
      original(server)
      if (entry && pe.stats.corrections > before && rec.trace.length < 24) rec.trace.push({ seq: server.inputSequence, e: [0, 1, 2].map(i => +(server.position[i] - entry.position[i]).toFixed(4)), vS: server.velocity.map(v => +v.toFixed(2)), vP: entry.velocity.map(v => +v.toFixed(2)), sg: server.onGround, pg: entry.onGround, pos: server.position.map(v => +v.toFixed(1)) })
    }
  }

  const predStats = rec => {
    const pe = rec.client._msgHandler.getPredEngine()
    return pe ? { corrections: pe.stats.corrections, acks: pe.stats.acks, maxCorrectionM: pe.stats.maxCorrectionM, lastCorrectionM: pe.stats.lastCorrectionM } : null
  }

  process.on('message', async m => {
    if (m.t === 'connect') {
      for (const s of m.clients) clients.set(s.idx, makeClient(s, m.url))
      await Promise.all([...clients.values()].map(r => r.client.connect()))
      const t0 = performance.now()
      while ([...clients.values()].some(r => r.client.playerId == null) && performance.now() - t0 < 30000) await sleep(20)
      send({ t: 'connected', ids: [...clients.values()].map(r => [r.spec.idx, r.client.playerId]) })
    } else if (m.t === 'teleport') {
      const todo = m.targets.filter(x => clients.has(x.idx))
      const results = []
      for (let i = 0; i < todo.length; i += 4) {
        await Promise.all(todo.slice(i, i + 4).map(async x => {
          const r = clients.get(x.idx), t0 = performance.now()
          try { const res = await r.client.requestTeleport('to', x.spec, 40000); results.push({ idx: x.idx, ok: true, ms: performance.now() - t0, groundY: res.grounded?.groundY ?? null }) }
          catch (e) { results.push({ idx: x.idx, ok: false, error: e.ack?.error || e.message, ms: performance.now() - t0 }) }
        }))
      }
      send({ t: 'teleported', results })
    } else if (m.t === 'walk') {
      for (const r of clients.values()) { r.walking = m.on; if (m.yawJitter) r.yaw = r.spec.yaw }
    } else if (m.t === 'reset') {
      for (const r of clients.values()) {
        const mt = r.meter
        mt.inBytes = 0; mt.outBytes = 0; mt.inMsgs = 0; mt.outMsgs = 0; mt.byType = {}; mt.snapshots = 0; mt.nanStates = 0
        const p = predStats(r)
        r.correctionsBase = p?.corrections ?? 0; r.acksBase = p?.acks ?? 0
      }
    } else if (m.t === 'aim') {
      for (const [idx, pos] of m.aims) { const r = clients.get(idx); if (r) r.aim = pos }
    } else if (m.t === 'shoot') {
      clearInterval(shootTimer)
      shootTimer = setInterval(() => {
        for (const r of clients.values()) {
          if (!r.spec.shooter || !r.aim) continue
          const ls = r.client.getLocalState()?.position
          if (!finite(ls)) continue
          const origin = [ls[0], ls[1] + 0.9, ls[2]], aim = [r.aim[0], r.aim[1] + 0.9, r.aim[2]]
          const d = [aim[0] - origin[0], aim[1] - origin[1], aim[2] - origin[2]], len = Math.hypot(...d) || 1
          r.client.sendFire({ origin, direction: [d[0] / len, d[1] / len, d[2] / len], rangeToAimM: len })
        }
      }, 250)
    } else if (m.t === 'stop-shoot') {
      clearInterval(shootTimer)
    } else if (m.t === 'vis') {
      send({ t: 'vis', rows: [...clients.values()].map(r => [r.client.playerId, r.visible.slice(), performance.now()]) })
    } else if (m.t === 'positions') {
      send({ t: 'positions', rows: [...clients.values()].map(r => [r.client.playerId, r.client.getLocalState()?.position ?? null]) })
    } else if (m.t === 'report') {
      const out = []
      for (const r of clients.values()) {
        const p = predStats(r), mt = r.meter
        const ls = r.client.getLocalState()
        out.push({ idx: r.spec.idx, id: r.client.playerId, connected: r.client.connected, inBytes: mt.inBytes, outBytes: mt.outBytes, inMsgs: mt.inMsgs, outMsgs: mt.outMsgs, byType: mt.byType, snapshots: mt.snapshots, nanStates: mt.nanStates, errors: mt.errors, trace: r.trace ?? null, epochs: mt.epochs, firstVisible: r.firstVisible ?? null, firstSnapshotBytes: mt.firstSnapshotBytes ?? null, localFinite: finite(ls?.position) && finite(ls?.velocity), local: ls?.position ?? null, corrections: p ? p.corrections - r.correctionsBase : null, acks: p ? p.acks - r.acksBase : null, maxCorrectionM: p?.maxCorrectionM ?? null, rttMs: r.client.getRTT(), chart: r.client.getChartStats?.() ?? null })
      }
      send({ t: 'report', rows: out })
    } else if (m.t === 'close') {
      for (const r of clients.values()) { try { r.client.disconnect() } catch {} }
      process.exit(0)
    }
  })
  send({ t: 'ready' })
}

async function runParent() {
  const { createServer } = await import('../src/sdk/server.js')
  const { MSG } = await import('../src/protocol/MessageTypes.js')
  const { loadWorldModule } = await import('../src/sdk/WorldLocator.js')
  const { chartAnchorKeyOfDir } = await import('../src/shared/chartAnchor.js')
  const { dirToLocalXZ } = await import('../src/shared/relocation.js')
  const { waterlineLocalY } = await import('../src/terrain/PlanetFrame.js')
  const { PLAYER_LOD_FULL_COUNT } = await import('../src/netcode/SnapshotEncoder.js')
  const { findHitSpatial, buildLiveIndex, resolveFireRequest } = await import('../src/netcode/Hitscan.js')

  const N = Number(args.n || 16)
  const PROCS = Math.max(1, Math.min(Number(args.procs || 4), N))
  const DURATION_S = Number(args.duration || 15)
  const WARM_S = Number(args.warm || 4)
  const WORLD = args.world || 'tps'
  const SERVICE = args.service === 'on'
  const ANCHORS = Number(args.anchors || 32)
  const HYST = Number(args.hyst ?? 0.75)
  const PREDICT_N = Number(args.predict ?? N)
  const SHOOTERS = Number(args.shooters ?? 0)
  const LATE_JOIN = Number(args.lateJoin || 0)
  const scenarios = (args.scenario || 'clustered').split(',')
  const results = []
  const outDir = resolve(SDK_ROOT, 'data', 'planet-harness')
  await mkdir(outDir, { recursive: true })
  const logLines = { heightfield: 0, overrun: 0, dilation: 0, warn: 0, error: 0, other: new Map() }
  const originals = { log: console.log, warn: console.warn, error: console.error }
  const tally = (kind, line) => {
    if (/\[terrain\] heightfield #/.test(line)) logLines.heightfield++
    else if (/overran budget/.test(line)) logLines.overrun++
    else if (/tick-dilation/.test(line)) logLines.dilation++
    else if (kind !== 'log') { logLines[kind]++; const key = line.slice(0, 90); logLines.other.set(key, (logLines.other.get(key) || 0) + 1) }
  }
  for (const kind of ['log', 'warn', 'error']) console[kind] = (...a) => { tally(kind, a.map(String).join(' ')); if (args.verbose) originals[kind](...a) }
  const say = (...a) => originals.log('[planet-harness]', ...a)

  const freePort = () => new Promise((res, rej) => { const s = createNetServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })

  async function bootServer(scenario) {
    const workDir = resolve(outDir, `work-${process.pid}`)
    await mkdir(resolve(workDir, 'data'), { recursive: true })
    process.chdir(workDir)
    const loaded = await loadWorldModule(resolve(SDK_ROOT, 'apps/world/tps-game.js'))
    const reanchor = { enabled: SERVICE, anchorsPerFace: ANCHORS, hysteresisDeg: HYST }
    const terrain = WORLD === 'smooth'
      ? { ...loaded.terrain, bakedHeightfield: undefined, carves: [], vegetation: { enabled: false }, reliefScale: 0.0005, chartReanchor: reanchor }
      : { ...loaded.terrain, chartReanchor: reanchor, ...(args.maxFields ? { physics: { ...(loaded.terrain.physics || {}), maxFields: Number(args.maxFields) }, vegetation: { ...loaded.terrain.vegetation, colliderMaxCenters: Number(args.maxFields) } } : {}) }
    const entities = WORLD === 'smooth'
      ? [{ id: 'spawn-1', position: [0, 3, 0], app: 'spawn-point', config: { team: 'any' } }]
      : loaded.entities.filter(e => e.id !== 'env-sillos')
    const worldDef = { ...loaded, entities, terrain, ...(WORLD === 'smooth' ? { spawnPoint: [0, 3, 0] } : {}), ...(args.snapHz ? { netcode: { ...(loaded.netcode || {}), snapshotRate: Number(args.snapHz) } } : {}) }
    const port = await freePort()
    const tickRate = worldDef.tickRate || 64
    const server = await createServer({ port, tickRate, appsDirs: [resolve(SDK_ROOT, 'apps'), resolve(SDK_ROOT, 'src/stdlib-apps')], sdkRoot: SDK_ROOT, gravity: worldDef.gravity, staticDirs: [], storageDir: resolve(workDir, 'data') })
    await server.loadWorld({ ...worldDef, tickRate })
    await server.start()
    return { server, url: `ws://127.0.0.1:${port}/ws`, tickRate }
  }

  const vec = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    norm: a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l] },
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  }
  function dirAt(frame, center, bearing, arcM) {
    const up = center
    const east0 = vec.norm([up[2], 0, -up[0]]), north0 = vec.norm([up[1] * east0[2] - up[2] * east0[1], up[2] * east0[0] - up[0] * east0[2], up[0] * east0[1] - up[1] * east0[0]])
    const a = arcM / frame.radius, t = vec.add(vec.scale(north0, Math.cos(bearing)), vec.scale(east0, Math.sin(bearing)))
    return vec.norm(vec.add(vec.scale(up, Math.cos(a)), vec.scale(t, Math.sin(a))))
  }
  const disc = (frame, center, i, n, radiusM) => dirAt(frame, center, i * GOLDEN, radiusM * Math.sqrt((i + 0.5) / n))
  const antipode = d => [-d[0], -d[1], -d[2]]
  const cap = (frame, i, n, capDeg) => {
    const z = 1 - (1 - Math.cos(capDeg * Math.PI / 180)) * (i + 0.5) / n, r = Math.sqrt(1 - z * z), phi = i * GOLDEN
    const up = frame.up, east0 = vec.norm([up[2], 0, -up[0]]), north0 = vec.norm([up[1] * east0[2] - up[2] * east0[1], up[2] * east0[0] - up[0] * east0[2], up[0] * east0[1] - up[1] * east0[0]])
    return vec.norm(vec.add(vec.scale(up, z), vec.add(vec.scale(east0, r * Math.cos(phi)), vec.scale(north0, r * Math.sin(phi)))))
  }
  const fibonacci = (i, n) => { const y = 1 - 2 * (i + 0.5) / n, r = Math.sqrt(1 - y * y), phi = i * GOLDEN; return [r * Math.cos(phi), y, r * Math.sin(phi)] }

  function dryBearing(server, frame, anchor, arcM, from) {
    for (let k = 0; k < 32; k++) {
      const bearing = from + k * 0.41
      const p = probeDir(server, frame, dirAt(frame, anchor, bearing, arcM))
      if (p && p.slope <= WALKABLE_MAX_SLOPE_DEG) return bearing
    }
    return from
  }

  function placements(name, frame, server) {
    const anchor = [...frame.up], out = []
    const split = name.match(/^split(\d+)$/), arc = name.match(/^arc([\d.]+)$/)
    const arcBearing = arc ? dryBearing(server, frame, anchor, Number(arc[1]) * 1000, 0) : 0
    const splitBearings = split ? [dryBearing(server, frame, anchor, Number(split[1]) * 500, 0), dryBearing(server, frame, anchor, Number(split[1]) * 500, Math.PI)] : null
    for (let i = 0; i < N; i++) {
      if (arc) out.push({ dir: disc(frame, dirAt(frame, anchor, arcBearing, Number(arc[1]) * 1000), i, N, 20) })
      else if (name === 'clustered') out.push({ dir: disc(frame, anchor, i, N, 100) })
      else if (split) { const half = Number(split[1]) * 500, side = i % 2; out.push({ dir: disc(frame, dirAt(frame, anchor, splitBearings[side], half), Math.floor(i / 2), Math.ceil(N / 2), 100) }) }
      else if (name === 'antipodal') out.push({ dir: disc(frame, i % 2 ? antipode(anchor) : anchor, Math.floor(i / 2), Math.ceil(N / 2), 100) })
      else if (name === 'spread-sphere') out.push({ dir: fibonacci(i, N) })
      else if (name === 'spread-cap') out.push({ dir: cap(frame, i, N, 80) })
      else if (name === 'roam-edge') out.push({ dir: disc(frame, vec.norm([-1, 0, 1]), i, N, 60) })
      else if (name === 'roam-corner') out.push({ dir: disc(frame, vec.norm([-1, 1, 1]), i, N, 60) })
      else if (name === 'roam-pole') out.push({ dir: disc(frame, [0, 1, 0], i, N, 60) })
      else throw new Error(`unknown scenario ${name}`)
    }
    return out
  }

  let unplaceable = 0
  const wetDirs = new Set()
  const WALKABLE_MAX_SLOPE_DEG = Number(args.maxSlope || 20)
  function slopeDegAt(server, x, z) {
    const h = (a, b) => server.physics.terrainHeightAt(a, b), d = 3
    const gx = (h(x + d, z) - h(x - d, z)) / (2 * d), gz = (h(x, z + d) - h(x, z - d)) / (2 * d)
    return Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI
  }
  function probeDir(server, frame, d) {
    const heightAt = (x, z) => server.physics.terrainHeightAt(x, z)
    const xz = dirToLocalXZ(frame, d, heightAt)
    if (!xz || !Number.isFinite(heightAt(xz[0], xz[1]))) return null
    const dry = heightAt(xz[0], xz[1]) > waterlineLocalY(frame, xz[0], xz[1]) + 2
    return { xz, slope: dry ? slopeDegAt(server, xz[0], xz[1]) : 90 }
  }
  function walkableDir(server, frame, dir) {
    if (args.walkable === 'off') return dir
    const probe = d => probeDir(server, frame, d)
    const first = probe(dir)
    if (!first || first.slope <= WALKABLE_MAX_SLOPE_DEG) return dir
    for (let k = 1; k <= 6000; k++) { const cand = dirAt(frame, dir, k * GOLDEN, 12 * Math.sqrt(k)); const p = probe(cand); if (p && p.slope <= WALKABLE_MAX_SLOPE_DEG) return cand }
    unplaceable++
    wetDirs.add(dir)
    return dir
  }

  function chordRel(frame, a, b) {
    const wa = frame.localToWorld(a[0], a[1], a[2]), wb = frame.localToWorld(b[0], b[1], b[2])
    const truth = Math.hypot(wa[0] - wb[0], wa[1] - wb[1], wa[2] - wb[2])
    return { chart: dist3(a, b), truth }
  }

  async function runScenario(name) {
    const { server, url, tickRate } = await bootServer(name)
    const frame = server.physics._planetFrame
    const ring = server.physics._terrainStreamer
    say(`scenario=${name} n=${N} world=${WORLD} service=${SERVICE ? 'on' : 'off'} tickRate=${tickRate} radius=${frame.radius}`)
    unplaceable = 0
    wetDirs.clear()
    const plan = placements(name, frame, server).map(p => ({ dir: walkableDir(server, frame, p.dir) }))
    const children = []
    const pending = new Map()
    const visLatest = new Map()
    const waitFor = (child, type, ms = 120000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout waiting for child ' + type + ' (child exitCode=' + child.exitCode + ')')), ms); child.once('__' + type, m => { clearTimeout(t); res(m) }); child.once('exit', () => { clearTimeout(t); rej(new Error('child exited waiting for ' + type)) }) })
    for (let c = 0; c < PROCS; c++) {
      const child = fork(fileURLToPath(import.meta.url), ['--child', ...(args.mirror === 'on' ? ['--mirror=on'] : []), ...(args.trace ? ['--trace=1'] : [])], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], execArgv: [] })
      child.on('message', m => child.emit('__' + m.t, m))
      child.setMaxListeners(100)
      children.push(child)
    }
    await Promise.all(children.map(c => waitFor(c, 'ready')))
    const specs = Array.from({ length: N }, (_, i) => ({ idx: i, predict: i < PREDICT_N, shooter: i < SHOOTERS, yaw: (i * 0.37) % 0.6 - 0.3 }))
    const owner = i => i % PROCS
    const connectedP = children.map((c, ci) => waitFor(c, 'connected'))
    children.forEach((c, ci) => c.send({ t: 'connect', url, clients: specs.filter(s => owner(s.idx) === ci) }))
    const connected = await Promise.all(connectedP)
    const idxToId = new Map(); for (const m of connected) for (const [idx, id] of m.ids) idxToId.set(idx, id)
    const idOf = i => idxToId.get(i)
    const missingConnect = specs.filter(s => idOf(s.idx) == null).length

    const sendAll = async (msg, replyType) => {
      const replies = children.map(c => waitFor(c, replyType))
      children.forEach(c => c.send(msg))
      return Promise.all(replies)
    }

    const spawnPositions = new Map()
    for (const p of server.playerManager.getConnectedPlayers()) spawnPositions.set(p.id, [...p.state.position])

    const targetsFor = ci => plan.map((p, idx) => ({ idx, spec: { dir: p.dir, clearance: 2 } })).filter(x => owner(x.idx) === ci)
    const tpT0 = performance.now()
    const teleportReplies = children.map(c => waitFor(c, 'teleported'))
    children.forEach((c, ci) => c.send({ t: 'teleport', targets: targetsFor(ci) }))
    const teleports = (await Promise.all(teleportReplies)).flatMap(m => m.results)
    const tpMs = performance.now() - tpT0
    const refusals = {}
    for (const t of teleports) if (!t.ok) refusals[t.error] = (refusals[t.error] || 0) + 1
    say(`teleports ok=${teleports.filter(t => t.ok).length}/${N} in ${Math.round(tpMs)} ms refusals=${JSON.stringify(refusals)}`)

    if (/^roam-/.test(name)) await alignRoamersToBoundary(server, children, plan, owner, waitFor, idOf, ring, chartAnchorKeyOfDir, frame, specs)

    await sleep(WARM_S * 1000)
    children.forEach(c => c.send({ t: 'walk', on: name.startsWith('roam') || args.walk === 'on' }))
    await sleep(1500)

    const ticks = [], tickStamps = []
    const origMeasured = server.tickSystem._onTickMeasured.bind(server.tickSystem)
    server.tickSystem._onTickMeasured = ms => { ticks.push(ms); tickStamps.push(performance.now()); origMeasured(ms) }
    const loop = monitorEventLoopDelay({ resolution: 1 }); loop.enable()
    const profiler = args.profile ? new Session() : null
    if (profiler) { profiler.connect(); await profiler.post('Profiler.enable'); await profiler.post('Profiler.start') }
    const sched0 = { ...server.tickSystem.schedulerStats }
    const mem0 = process.memoryUsage()
    const cpu0 = process.threadCpuUsage()
    const hf0 = ring?.rebuildCount ?? null
    const lc0 = { ...server.lagCompensator.getStats() }
    const logs0 = { hf: logLines.heightfield, overrun: logLines.overrun, dilation: logLines.dilation }
    children.forEach(c => c.send({ t: 'reset' }))
    const shots = []
    const chartEpochs0 = frame.chartEpoch
    const shotListener = (clientId, msg) => {
      if (msg.type !== MSG.APP_EVENT || msg.payload?.type !== 'fire') return
      const shooter = server.playerManager.getPlayer(clientId)
      const targetIdx = shooterTarget.get(clientId)
      const target = targetIdx != null ? server.playerManager.getPlayer(targetIdx) : null
      if (!shooter || !target) return
      const players = server.playerManager.getConnectedPlayers()
      const { origin, viewTick } = resolveFireRequest(server.lagCompensator, clientId, shooter.state.position, msg.payload)
      const dir = msg.payload.direction
      const found = findHitSpatial(players, { shooterId: clientId, origin, direction: dir, viewTick, range: 1000, lagComp: server.lagCompensator, isTargetable: () => true }, buildLiveIndex(players))
      shots.push({ distM: dist3(shooter.state.position, target.state.position), hitTarget: found?.target?.id === target.id, hitOther: !!found && found.target.id !== target.id, rejected: viewTick == null })
    }
    const shooterTarget = new Map()
    const clusterOf = i => plan[i].dir
    for (let i = 0; i < SHOOTERS; i++) {
      let best = (i + 1) % N
      if (!(name === 'clustered' || name.startsWith('roam'))) { let low = 2; for (let j = 0; j < N; j++) { if (j === i) continue; const d = vec.dot(clusterOf(i), clusterOf(j)); if (d < low) { low = d; best = j } } }
      if (idOf(i) != null && idOf(best) != null) shooterTarget.set(idOf(i), idOf(best))
    }
    server.connections.on('message', shotListener)
    const aimTimer = setInterval(() => {
      const aimsByOwner = children.map(() => [])
      for (const [shooterIdx] of specs.filter(s => s.shooter).map(s => [s.idx])) {
        const tid = shooterTarget.get(idOf(shooterIdx)); const tp = tid != null ? server.playerManager.getPlayer(tid) : null
        if (tp) aimsByOwner[owner(shooterIdx)].push([shooterIdx, [...tp.state.position]])
      }
      children.forEach((c, ci) => c.send({ t: 'aim', aims: aimsByOwner[ci] }))
    }, 100)
    children.forEach(c => c.send({ t: 'shoot' }))

    const interest = { samples: 0, viewers: 0, expectedPairs: 0, receivedPairs: 0, missing: 0, extra: 0, extraMaxM: 0, missingMaxM: 0, missingBeyond: [], extraWithinCell: 0, selfMissing: 0 }
    const distortion = { pairs: 0, maxAbsM: 0, maxRel: 0, worst: null }
    const visTimer = setInterval(async () => {
      const replies = children.map(c => waitFor(c, 'vis'))
      children.forEach(c => c.send({ t: 'vis' }))
      const all = (await Promise.all(replies)).flatMap(m => m.rows)
      const positions = new Map(server.playerManager.getConnectedPlayers().map(p => [p.id, p.state.position]))
      interest.samples++
      for (const [pid, ids] of all) {
        const me = positions.get(pid); if (!me) continue
        interest.viewers++
        const got = new Set(ids)
        if (!got.has(pid)) interest.selfMissing++
        const inRange = []
        for (const [oid, op] of positions) if (oid !== pid) { const d = dist3(me, op); if (d <= RELEVANCE_M - 12) inRange.push([d, oid]) }
        inRange.sort((a, b) => a[0] - b[0])
        const mustHave = new Set(inRange.slice(0, PLAYER_LOD_FULL_COUNT).map(x => x[1]))
        for (const [oid, op] of positions) {
          if (oid === pid) continue
          const d = dist3(me, op)
          const inRadius = mustHave.has(oid), outside = d > RELEVANCE_M * HYSTERESIS_FACTOR + 150
          if (d <= RELEVANCE_M - 12 && !inRadius) interest.lodTiered = (interest.lodTiered || 0) + 1
          if (inRadius) { interest.expectedPairs++; if (!got.has(oid)) { interest.missing++; interest.missingMaxM = Math.max(interest.missingMaxM, d) } }
          if (got.has(oid)) { interest.receivedPairs++; if (outside) { interest.extra++; interest.extraMaxM = Math.max(interest.extraMaxM, d) } }
          if (d < 400) {
            const c = chordRel(frame, me, op)
            const abs = Math.abs(c.chart - c.truth)
            distortion.pairs++
            if (abs > distortion.maxAbsM) { distortion.maxAbsM = abs; distortion.worst = { chart: round(c.chart, 2), truth: round(c.truth, 2) } }
            distortion.maxRel = Math.max(distortion.maxRel, abs / Math.max(1, c.truth))
          }
        }
      }
    }, 500)
    const t0 = performance.now()
    await sleep(DURATION_S * 1000)
    const elapsedS = (performance.now() - t0) / 1000
    clearInterval(visTimer); clearInterval(aimTimer)
    children.forEach(c => c.send({ t: 'stop-shoot' }))
    server.connections.removeListener('message', shotListener)
    const posReplies = children.map(c => waitFor(c, 'positions'))
    children.forEach(c => c.send({ t: 'positions' }))
    const clientPositions = (await Promise.all(posReplies)).flatMap(m => m.rows)
    const reports = (await sendAll({ t: 'report' }, 'report')).flatMap(m => m.rows)
    loop.disable()
    if (profiler) { const { profile } = await profiler.post('Profiler.stop'); await writeFile(args.profile, JSON.stringify(profile)); profiler.disconnect() }
    server.tickSystem._onTickMeasured = origMeasured
    const mem1 = process.memoryUsage()
    const cpu1 = process.threadCpuUsage(cpu0)
    const sched1 = server.tickSystem.schedulerStats
    const metrics = server.tickSystem.getStats?.() ?? null
    const inKBps = reports.map(r => r.inBytes / 1024 / elapsedS), outKBps = reports.map(r => r.outBytes / 1024 / elapsedS)
    const snapHz = reports.map(r => r.snapshots / elapsedS)
    const intervals = []
    for (let i = 1; i < tickStamps.length; i++) intervals.push(tickStamps[i] - tickStamps[i - 1])
    const byTypeTotal = {}
    for (const r of reports) for (const [k, v] of Object.entries(r.byType)) byTypeTotal[k] = (byTypeTotal[k] || 0) + v
    const divergence = []
    for (const [pid, pos] of clientPositions) { const sp = server.playerManager.getPlayer(pid)?.state.position; if (pos && sp) divergence.push(dist3(pos, sp)) }
    const poss = server.playerManager.getConnectedPlayers().map(p => p.state.position)
    const nonFinite = poss.filter(p => !p.every(Number.isFinite)).length
    const groundMissing = poss.filter(p => !Number.isFinite(server.physics.terrainHeightAt?.(p[0], p[2]))).length
    const wetIds = new Set(plan.map((p, i) => wetDirs.has(p.dir) ? idOf(i) : null).filter(x => x != null))
    const connectedNow = server.playerManager.getConnectedPlayers().filter(p => !wetIds.has(p.id))
    const aboveGround = connectedNow.map(p => p.state.position[1] - server.physics.terrainHeightAt(p.state.position[0], p.state.position[2]))
    const grounded = connectedNow.filter(p => p.state.onGround).length
    const corr = reports.filter(r => r.corrections != null)
    const result = {
      lateJoin: null,
      scenario: name, n: N, world: WORLD, service: SERVICE, durationS: round(elapsedS, 1), procs: PROCS, tickRate,
      connected: N - missingConnect, teleportsOk: teleports.filter(t => t.ok).length, teleportRefusals: refusals, teleportMs: summarize(teleports.filter(t => t.ok).map(t => t.ms)),
      anchorAngleDeg: summarize(poss.map(p => { const d = frame.localToDir(p[0], p[2], p[1]); return Math.acos(Math.max(-1, Math.min(1, vec.dot(d, frame.up)))) * 180 / Math.PI })),
      serverMainThreadCpuMsPerTick: round((cpu1.user + cpu1.system) / 1000 / Math.max(1, ticks.length), 3), serverTickMs: summarize(ticks), tickIntervalMs: summarize(intervals), tickOver1BudgetPct: round(ticks.filter(t => t > 1000 / tickRate).length / Math.max(1, ticks.length) * 100, 2),
      eventLoopDelayMs: { mean: round(loop.mean / 1e6, 2), p99: round(loop.percentile(99) / 1e6, 2), max: round(loop.max / 1e6, 2) },
      scheduler: { lateMaxMs: round(server.tickSystem.schedulerStats.maxLateMs, 2), droppedMsDelta: round(sched1.droppedMs - (sched0.droppedMs || 0), 1), dilationFactor: server.tickSystem.dilationFactor },
      clientDownKBps: summarize(inKBps), clientUpKBps: summarize(outKBps), snapshotHz: summarize(snapHz), downBytesByTypeTotalKB: Object.fromEntries(Object.entries(byTypeTotal).map(([k, v]) => [k, round(v / 1024, 1)]).sort((a, b) => b[1] - a[1]).slice(0, 6)),
      traces: args.trace ? reports.map(r => r.trace).filter(Boolean).slice(0, 2) : undefined,
      unplaceableOnDryWalkableGround: unplaceable, serverGround: { excludedWetPlacements: wetIds.size, grounded, ofPlayers: connectedNow.length, aboveTerrainM: summarize(aboveGround), fellBelowTerrain5m: aboveGround.filter(v => v < -5).length },
      interest, distortion, joinSnapshotPlayers: summarize(reports.map(r => r.firstVisible)),
      prediction: corr.length ? { clients: corr.length, correctionsPerAck: round(corr.reduce((s, r) => s + r.corrections, 0) / Math.max(1, corr.reduce((s, r) => s + r.acks, 0)), 4), correctionsTotal: corr.reduce((s, r) => s + r.corrections, 0), acksTotal: corr.reduce((s, r) => s + r.acks, 0), maxCorrectionM: round(Math.max(...corr.map(r => r.maxCorrectionM || 0)), 3), clientVsServerM: summarize(divergence) } : null,
      hitReg: { shots: shots.length, byDistance: ['<50', '50-200', '200-1000', '>1000'].map((label, i) => { const lo = [0, 50, 200, 1000][i], hi = [50, 200, 1000, 1e12][i]; const s = shots.filter(x => x.distM >= lo && x.distM < hi); return { label, n: s.length, hitTarget: s.filter(x => x.hitTarget).length, hitOther: s.filter(x => x.hitOther).length, rejected: s.filter(x => x.rejected).length } }), lagComp: { ...server.lagCompensator.getStats(), rewindsDelta: server.lagCompensator.getStats().rewinds - lc0.rewinds } },
      failures: { nonFiniteServerPositions: nonFinite, nonFiniteClientLocal: reports.filter(r => !r.localFinite).length, clientNanStates: reports.reduce((s, r) => s + r.nanStates, 0), clientErrors: reports.flatMap(r => r.errors).slice(0, 8), disconnected: reports.filter(r => !r.connected).length, groundMissing, logLines: { heightfieldBuilds: logLines.heightfield - logs0.hf, overrun: logLines.overrun - logs0.overrun, dilation: logLines.dilation - logs0.dilation, warn: logLines.warn, error: logLines.error, topOther: [...logLines.other.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5) } },
      chart: { serverEpoch: frame.chartEpoch, epochsDuringRun: frame.chartEpoch - chartEpochs0, clientEpochsSeen: summarize(reports.map(r => r.epochs)), clientResyncs: reports.reduce((s, r) => s + (r.chart?.resyncRequests || 0), 0), clientHeldNow: reports.reduce((s, r) => s + (r.chart?.heldNow || 0), 0), reanchorCount: ring?.chartReanchor?.reanchorCount ?? 0, refusals: ring?.chartReanchor?.refusalCount ?? 0 },
      memory: { rssMB: [round(mem0.rss / 1048576, 1), round(mem1.rss / 1048576, 1)], heapMB: [round(mem0.heapUsed / 1048576, 1), round(mem1.heapUsed / 1048576, 1)], rssGrowthMBPerMin: round((mem1.rss - mem0.rss) / 1048576 / (elapsedS / 60), 1) },
      streaming: { heightfieldRebuilds: ring?.rebuildCount ?? null, heightfieldRebuildsDuringRun: (ring?.rebuildCount ?? 0) - (hf0 ?? 0), heightfieldBuildsPerS: round((logLines.heightfield - logs0.hf) / elapsedS, 3) }
    }
    if (LATE_JOIN > 0) {
      const child = fork(fileURLToPath(import.meta.url), ['--child'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], execArgv: [] })
      child.on('message', m => child.emit('__' + m.t, m))
      await waitFor(child, 'ready')
      const joined = waitFor(child, 'connected')
      child.send({ t: 'connect', url, clients: Array.from({ length: LATE_JOIN }, (_, i) => ({ idx: 1000 + i, predict: false, shooter: false, yaw: 0 })) })
      await joined
      await sleep(2500)
      const rows = (await (async () => { const r = waitFor(child, 'report'); child.send({ t: 'report' }); return r })()).rows
      result.lateJoin = { clients: rows.length, playersInFirstSnapshot: summarize(rows.map(r => r.firstVisible)), firstSnapshotBytes: summarize(rows.map(r => r.firstSnapshotBytes)), serverPlayers: server.playerManager.getConnectedPlayers().length }
      child.send({ t: 'close' })
    }
    children.forEach(c => c.send({ t: 'close' }))
    await sleep(300)
    for (const c of children) { try { c.kill() } catch {} }
    try { server.stop() } catch {}
    await sleep(500)
    return result
  }

  async function alignRoamersToBoundary(server, children, plan, owner, waitFor, idOf, ring, chartAnchorKeyOfDir, frame, specs) {
    if (!ring?.chartReanchor) throw new Error('roam scenarios need --service=on')
    const lattice = ring.chartReanchor.lattice
    await sleep(2500)
    const ref = server.playerManager.getPlayer(idOf(0))?.state.position
    if (!ref) throw new Error('no reference player to find a boundary')
    const keyAt = (x, z) => chartAnchorKeyOfDir(lattice, server.physics._planetFrame.localToDir(x, z))
    const startKey = keyAt(ref[0], ref[2])
    let lo = ref[2], hi = ref[2]
    while (keyAt(ref[0], hi) === startKey) { lo = hi; hi += 25; if (hi - ref[2] > 40000) throw new Error('no lattice cell boundary within 40 km of the roam feature') }
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (keyAt(ref[0], mid) === startKey) lo = mid; else hi = mid }
    const bz = hi
    const targets = plan.map((p, idx) => ({ idx, spec: { x: ref[0] + ((idx % 8) - 3.5) * 12, z: bz - 30 - Math.floor(idx / 8) * 6, clearance: 2 } }))
    const replies = children.map(c => waitFor(c, 'teleported'))
    children.forEach((c, ci) => c.send({ t: 'teleport', targets: targets.filter(x => owner(x.idx) === ci) }))
    const res = (await Promise.all(replies)).flatMap(m => m.results)
    say(`roam realigned to lattice boundary z=${bz.toFixed(1)}: ${res.filter(r => r.ok).length}/${res.length} ok`)
    await sleep(2000)
  }

  for (const s of scenarios) {
    try { results.push(await runScenario(s)) }
    catch (e) { say(`scenario ${s} FATAL`, e?.stack || e); results.push({ scenario: s, n: N, fatal: String(e?.stack || e) }) }
  }
  const text = JSON.stringify({ args, results }, (k, v) => v instanceof Map ? [...v] : v, 1)
  const out = args.out || resolve(outDir, `run-${Date.now()}.json`)
  await writeFile(out, text)
  say(`wrote ${out}`)
  const f = (v, d = 2) => v == null ? '-' : Number(v).toFixed(d)
  originals.log('| scenario | n | ok/refused | tick ms p50/p99/max | main-thread cpu ms/tick | loop p99 ms | down KB/s p50/max | up KB/s | snap Hz | interest miss/extra (of exp) | chart-vs-world chord max m | grounded | corr/ack | hit (50-200 / 200-1000 / >1000) | nonfinite | hf builds/s | rss MB/min |')
  originals.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of results) {
    if (r.fatal) { originals.log(`| ${r.scenario} | ${r.n} | FATAL ${r.fatal.split('\n')[0]} |`); continue }
    const h = r.hitReg.byDistance, hs = x => `${x.hitTarget}/${x.n}`
    originals.log(`| ${r.scenario} | ${r.n} | ${r.teleportsOk}/${r.n - r.teleportsOk} ${Object.keys(r.teleportRefusals).join(';').slice(0, 60)} | ${f(r.serverTickMs.p50)}/${f(r.serverTickMs.p99)}/${f(r.serverTickMs.max)} | ${f(r.serverMainThreadCpuMsPerTick, 3)} | ${r.eventLoopDelayMs.p99} | ${f(r.clientDownKBps.p50, 1)}/${f(r.clientDownKBps.max, 1)} | ${f(r.clientUpKBps.p50, 1)} | ${f(r.snapshotHz.p50, 1)} | ${r.interest.missing}/${r.interest.extra} of ${r.interest.expectedPairs} | ${f(r.distortion.maxAbsM)} | ${r.serverGround.grounded}/${r.serverGround.ofPlayers} | ${r.prediction ? r.prediction.correctionsPerAck : '-'} | ${hs(h[1])} / ${hs(h[2])} / ${hs(h[3])} | ${r.failures.nonFiniteServerPositions + r.failures.nonFiniteClientLocal + r.failures.clientNanStates} | ${f(r.streaming.heightfieldBuildsPerS, 3)} | ${r.memory.rssGrowthMBPerMin} |`)
  }
  process.exit(0)
}
