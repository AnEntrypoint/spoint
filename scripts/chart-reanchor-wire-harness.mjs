#!/usr/bin/env node
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'

process.env.SPOINT_NO_WATCH = '1'
process.env.SPOINT_SKIP_PREWARM = '1'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true'] }))
const SCENARIO = args.scenario || 'forced'
const AWARE = args.aware !== 'off'
const ANCHORS = Number(args.anchors || (SCENARIO === 'natural' ? 32 : 2048))
const HYSTERESIS = Number(args.hyst ?? (SCENARIO === 'natural' ? 0.75 : 0))
const TARGET_EPOCHS = Number(args.epochs || (SCENARIO === 'chain' ? 14 : 1))
const MIRROR = args.mirror !== 'off'
const SERVICE = args.service !== 'off'
const WORLD = args.world || 'smooth'
const SMOOTH_RELIEF_SCALE = Number(args.relief ?? 0.0005)
const CONTROL_SECONDS = Number(args.seconds || 20)
const RUN_LIMIT_MS = Number(args.limitMs || 240000)
const FRAME_MS = 16

const { createServer } = await import('../src/sdk/server.js')
const { PhysicsNetworkClient } = await import('../src/client/PhysicsNetworkClient.js')
const { MSG, isUnreliable } = await import('../src/protocol/MessageTypes.js')
const { unpack, pack } = await import('../src/protocol/msgpack.js')
const { loadWorldModule } = await import('../src/sdk/WorldLocator.js')
const { createChartTransfer } = await import('../src/shared/chartAnchor.js')
const { chartAnchorKeyOfDir } = await import('../src/shared/chartAnchor.js')
const { encodeInputPacket, DEFAULT_INPUT_SCHEMA } = await import('../src/protocol/InputCodec.js')
const { chartWireStatsOf } = await import('../src/sdk/chartWire.js')
const { decodeChart } = await import('../src/shared/chartWireCodec.js')

const log = message => console.error(`[wire-harness ${(performance.now() / 1000).toFixed(1)}s] ${message}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const freePort = () => new Promise((res, rej) => { const s = createNetServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const hypot3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const pct = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))] }
const round = (x, d = 6) => x == null ? x : Number(x.toFixed(d))

async function until(cond, timeoutMs, label) {
  const t0 = performance.now()
  while (!cond()) {
    if (performance.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`)
    await sleep(20)
  }
  return performance.now() - t0
}

async function bootServer() {
  const workDir = resolve(SDK_ROOT, 'data', 'chart-wire-harness', `work-${process.pid}`)
  await mkdir(resolve(workDir, 'data'), { recursive: true })
  process.chdir(workDir)
  const loaded = await loadWorldModule(resolve(SDK_ROOT, 'apps/world/tps-game.js'))
  const reanchor = { enabled: SERVICE, anchorsPerFace: ANCHORS, hysteresisDeg: HYSTERESIS }
  const worldDef = WORLD === 'tps'
    ? { ...loaded, terrain: { ...loaded.terrain, chartReanchor: reanchor } }
    : { ...loaded, entities: [{ id: 'spawn-1', position: [0, 3, 0], app: 'spawn-point', config: { team: 'any' } }], spawnPoint: [0, 3, 0], terrain: { ...loaded.terrain, bakedHeightfield: undefined, carves: [], vegetation: { enabled: false }, reliefScale: SMOOTH_RELIEF_SCALE, chartReanchor: reanchor } }
  const port = await freePort()
  const server = await createServer({ port, tickRate: 60, appsDirs: [resolve(SDK_ROOT, 'apps'), resolve(SDK_ROOT, 'src/stdlib-apps')], sdkRoot: SDK_ROOT, gravity: worldDef.gravity, staticDirs: [], storageDir: resolve(workDir, 'data') })
  await server.loadWorld({ ...worldDef, tickRate: 60 })
  await server.start()
  return { server, url: `ws://127.0.0.1:${port}/ws` }
}

function groundHeightFor(server, probe) {
  const point = [0, 0, 0]
  const cache = { clientEpoch: -1, serverEpoch: -1, transfer: null }
  return (x, z) => {
    const ledger = ledgerOf(server)
    const height = server.physics.terrainHeightAt.bind(server.physics)
    const clientEpoch = probe.groundEpoch ?? probe.client._chart?.epoch ?? 0
    if (!ledger || clientEpoch === ledger.currentEpoch) return height(x, z)
    if (cache.clientEpoch !== clientEpoch || cache.serverEpoch !== ledger.currentEpoch) {
      cache.clientEpoch = clientEpoch; cache.serverEpoch = ledger.currentEpoch
      cache.transfer = createChartTransfer(ledger.chartAt(clientEpoch), ledger.current)
    }
    const t = cache.transfer
    let y = 0
    for (let i = 0; i < 3; i++) {
      point[0] = x; point[1] = y; point[2] = z
      const cur = t.point(point, [0, 0, 0])
      const h = height(cur[0], cur[2])
      if (!Number.isFinite(h)) return NaN
      y += (h - cur[1]) / t.m[4]
    }
    return y
  }
}

function makeClient({ url, aware, server }) {
  const heading = { yaw: 0, pitch: 0, walking: false }
  const probe = { heading, aware, drop: false, delayMs: 0, droppedBroadcasts: 0, delayedBroadcasts: 0, switches: [], frames: [] }
  class Probe extends PhysicsNetworkClient {
    _handleOneMessage(bytes) {
      let type = -1, isBroadcast = false
      try {
        const decoded = unpack(bytes)
        type = decoded.type
        isBroadcast = decoded.payload?.ackSeq !== undefined
        if (type === MSG.CHART_REANCHOR && !isBroadcast && probe.forceHardResync && decoded.payload.from) {
          const { from, ...rest } = decoded.payload
          bytes = pack({ type, payload: { ...rest, resync: true } })
        }
      } catch {}
      if (type === MSG.CHART_REANCHOR && isBroadcast && probe.drop) { probe.droppedBroadcasts++; return }
      if (probe.delayMs > 0 && type !== -1 && !isUnreliable(type)) { if (type === MSG.CHART_REANCHOR && isBroadcast) probe.delayedBroadcasts++; setTimeout(() => super._handleOneMessage(bytes), probe.delayMs); return }
      return super._handleOneMessage(bytes)
    }
  }
  const client = new Probe({
    url, predictionEnabled: true, smoothInterpolation: true, collisionMirror: MIRROR, autoMigrate: false, webTransport: { enabled: false },
    onChartReanchoring: ({ to }) => { probe.groundEpoch = to.chartEpoch },
    onChartReanchor: ({ transfer }) => { probe.groundEpoch = null; const l = transfer.look(heading.yaw, heading.pitch); heading.yaw = l.yaw; heading.pitch = l.pitch }
  })
  probe.client = client
  if (args.ground !== 'off') client.setPredictionGroundSurface(groundHeightFor(server, probe))
  if (!aware) {
    client._chart.admitSnapshot = () => true
    client._chart.onBroadcast = () => {}
  } else if (client._chart) {
    const original = client._chart.onBroadcast
    client._chart.onBroadcast = payload => {
      const epochBefore = client._chart.epoch
      const renderAt = performance.now()
      const renderBefore = worldOf(probe, client.getRenderState(renderAt)?.position)
      const localBefore = worldOf(probe, client.getLocalState()?.position)
      const stats = client._msgHandler.getPredEngine().stats
      const correctionsBefore = stats.corrections
      original(payload)
      if (client._chart.epoch === epochBefore || !payload.from) return
      const renderAfter = worldOf(probe, client.getRenderState(renderAt)?.position)
      const localAfter = worldOf(probe, client.getLocalState()?.position)
      const pos = client.getLocalState().position
      const transfer = createChartTransfer(decodeChart(payload.from), decodeChart(payload.to))
      const moved = transfer.point(pos)
      const record = {
        t: performance.now(), epoch: client._chart.epoch, ackSeq: payload.ackSeq,
        renderJumpM: renderBefore && renderAfter ? hypot3(renderBefore, renderAfter) : null,
        localJumpM: localBefore && localAfter ? hypot3(localBefore, localAfter) : null,
        correctionsDuring: stats.corrections - correctionsBefore,
        chartShiftM: Math.hypot(moved[0] - pos[0], moved[1] - pos[1], moved[2] - pos[2]),
        replayShiftM: stats.chartReplayShiftM, replayInputs: stats.chartReplayInputs, replayBase: stats.chartReplayBase, historyLength: client._msgHandler.getPredEngine().inputHistory.length, lastAckedSeq: client._msgHandler.getPredEngine()._lastAckedSeq, sentSeq: client._msgHandler.getPredEngine()._inputSeq - 1
      }
      probe.switches.push(record)
      for (const windowS of [1, 3]) setTimeout(() => { record[`correctionsWithin${windowS}s`] = stats.corrections - correctionsBefore }, windowS * 1000)
    }
  }
  return probe
}

let baseChart = null
function worldOf(probe, position) {
  if (!position || !baseChart || !probe.aware) return null
  const chart = probe.client._chart?.chart
  if (!chart) return null
  if (probe.cachedFor !== chart) { probe.cachedFor = chart; probe.toBase = createChartTransfer(chart, baseChart) }
  return probe.toBase.point(position)
}

function traceErrors(probe, pe) {
  if (pe._traced) return
  pe._traced = true
  probe.errors = []
  probe.allErrors = []
  const original = pe._reconcile.bind(pe)
  pe._reconcile = server => {
    const entry = pe.predictedAt(server.inputSequence ?? -1)
    const before = pe.stats.corrections
    original(server)
    if (entry && probe.allErrors.length < 3000) probe.allErrors.push({ t: performance.now(), seq: server.inputSequence, ey: server.position[1] - entry.position[1], ex: server.position[0] - entry.position[0], ez: server.position[2] - entry.position[2], sy: server.position[1], corrected: pe.stats.corrections > before })
    if (entry && pe.stats.corrections > before && probe.errors.length < 400) {
      const e = [server.position[0] - entry.position[0], server.position[1] - entry.position[1], server.position[2] - entry.position[2]]
      probe.errors.push({ seq: server.inputSequence, ex: e[0], ez: e[2], vxS: server.velocity[0], vzS: server.velocity[2], vxP: entry.velocity[0], vzP: entry.velocity[2], t: performance.now(), h: Math.hypot(e[0], e[2]), v: e[1], sg: server.onGround, pg: entry.onGround, speed: Math.hypot(server.velocity[0], server.velocity[2]), vyS: server.velocity[1], vyP: entry.velocity[1], offset: pe._surface?.standOffset, onSurface: pe._surface?.onSurface })
    }
  }
}

function startFrames(probe) {
  const timer = setInterval(() => {
    const client = probe.client
    const pe = client._msgHandler.getPredEngine()
    const render = client.getRenderState(performance.now())
    if (!pe || !render) return
    traceErrors(probe, pe)
    const off = pe.reconciliationEngine.errorOffset
    probe.frames.push({ t: performance.now(), offsetM: Math.hypot(off[0], off[1], off[2]), world: worldOf(probe, render.position), local: [...render.position] })
  }, FRAME_MS)
  return () => clearInterval(timer)
}

function startInput(probe) {
  const watch = { at: performance.now(), pos: null }
  probe.client.startInputLoop(() => {
    const now = performance.now()
    const pos = probe.client.getLocalState()?.position
    if (probe.heading.walking && pos && now - watch.at > 1500) {
      const world = probe.aware ? worldOf(probe, pos) : pos
      if (watch.pos && world && hypot3(world, watch.pos) < 2) probe.heading.yaw += 0.7
      watch.pos = world ? [...world] : null
      watch.at = now
    }
    return { forward: probe.heading.walking, sprint: args.sprint === 'on', yaw: probe.heading.yaw, pitch: probe.heading.pitch }
  })
}

function ledgerOf(server) { return server.physics._terrainStreamer.chartReanchor?.chartState?.ledger ?? null }
function serverChart(server) { return ledgerOf(server).current }
function wireStats(server) { return chartWireStatsOf({ physics: server.physics }) }
function serverEpoch(server) { return server.physics._planetFrame.chartEpoch }

function findBoundaryZ(server, from, marginM) {
  const frame = server.physics._planetFrame
  const lattice = server.physics._terrainStreamer.chartReanchor.lattice
  const keyAt = z => chartAnchorKeyOfDir(lattice, frame.localToDir(from[0], z))
  const startKey = keyAt(from[2])
  let lo = from[2], hi = from[2]
  while (keyAt(hi) === startKey) { lo = hi; hi += 25; if (hi - from[2] > 20000) throw new Error('no cell boundary within 20 km') }
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (keyAt(mid) === startKey) lo = mid; else hi = mid }
  return hi - marginM
}

async function settle(server, probe) {
  const client = probe.client
  await until(() => client.playerId && client._msgHandler.getPredEngine()?.stats.acks > 20, 20000, 'first acks')
  let lastEpoch = serverEpoch(server), stableSince = performance.now()
  await until(() => {
    const e = serverEpoch(server)
    if (e !== lastEpoch) { lastEpoch = e; stableSince = performance.now() }
    const grounded = client.getLocalState()?.onGround
    const synced = !probe.aware || client._chart.epoch === e
    return performance.now() - stableSince > 3000 && grounded && synced
  }, 60000, 'epoch and ground to settle')
}

function summarizeRun(server, probe, extra) {
  const client = probe.client
  const pe = client._msgHandler.getPredEngine()
  const offsets = probe.frames.map(f => f.offsetM)
  const steps = []
  for (let i = 1; i < probe.frames.length; i++) {
    const a = probe.frames[i - 1], b = probe.frames[i]
    if (a.world && b.world) steps.push({ step: hypot3(a.world, b.world), dt: (b.t - a.t) / 1000 })
  }
  const stepM = steps.map(s => s.step)
  return {
    epochsServer: serverEpoch(server), clientEpoch: client._chart?.epoch ?? null,
    corrections: pe.stats.corrections, lastCorrectionM: round(pe.stats.lastCorrectionM, 4), maxCorrectionM: round(pe.stats.maxCorrectionM, 4),
    switches: probe.switches.map(s => ({ ...s, t: undefined, correctionsWithin1s: s.correctionsWithin1s, correctionsWithin3s: s.correctionsWithin3s, renderJumpM: round(s.renderJumpM, 9), localJumpM: round(s.localJumpM, 9), chartShiftM: round(s.chartShiftM, 3), replayShiftM: round(s.replayShiftM, 9) })),
    ackErrorsAfterSwitch: args.trace === '2' && probe.switches.length ? probe.allErrors.filter(e => e.t >= probe.switches[probe.switches.length - 1].t - 200).slice(0, 60).map(e => ({ dtMs: Math.round(e.t - probe.switches[probe.switches.length - 1].t), seq: e.seq, ex: round(e.ex, 4), ey: round(e.ey, 4), ez: round(e.ez, 4), sy: round(e.sy, 4), c: e.corrected })) : undefined,
    errorSamples: args.trace ? probe.errors?.map(e => ({ seq: e.seq, ex: round(e.ex, 4), ez: round(e.ez, 4), vS: [round(e.vxS, 3), round(e.vzS, 3)], vP: [round(e.vxP, 3), round(e.vzP, 3)], swAck: probe.switches.filter(s => s.t <= e.t).pop()?.ackSeq, sw: probe.switches.filter(s => s.t <= e.t).length, dtMs: (() => { const prior = probe.switches.filter(s => s.t <= e.t).pop(); return prior ? Math.round(e.t - prior.t) : null })(), h: round(e.h, 4), v: round(e.v, 4), vyS: round(e.vyS, 4), vyP: round(e.vyP, 4), offset: round(e.offset, 4), onSurface: e.onSurface, sg: e.sg, pg: e.pg })) : undefined,
    correctionErrors: probe.errors ? { n: probe.errors.length, horizontalP50: round(pct(probe.errors.map(e => e.h), 0.5), 4), horizontalP95: round(pct(probe.errors.map(e => e.h), 0.95), 4), verticalP50: round(pct(probe.errors.map(e => Math.abs(e.v)), 0.5), 4), verticalP95: round(pct(probe.errors.map(e => Math.abs(e.v)), 0.95), 4), groundMismatch: probe.errors.filter(e => e.sg !== e.pg).length, speedP50: round(pct(probe.errors.map(e => e.speed), 0.5), 2) } : null,
    mirror: (() => { const m = pe.collisionMirrorStats?.(); const mirror = client._msgHandler.getCollisionMirror?.(); return m ? { ...m, coversPlayerNow: mirror ? mirror.covers(pe.localState.position) : null } : null })(),
    renderOffsetM: { p50: round(pct(offsets, 0.5), 5), p95: round(pct(offsets, 0.95), 5), max: round(Math.max(0, ...offsets), 5) },
    renderWorldStepM: stepM.length ? { p50: round(pct(stepM, 0.5), 5), p95: round(pct(stepM, 0.95), 5), max: round(Math.max(...stepM), 5) } : null,
    chart: client.getChartStats?.() ?? null, wire: wireStats(server),
    reanchorCount: server.physics._terrainStreamer.chartReanchor?.reanchorCount ?? 0, refusals: server.physics._terrainStreamer.chartReanchor?.refusalCount ?? 0,
    ...extra
  }
}

async function walkSeconds(probe, seconds) {
  probe.heading.walking = true
  await sleep(seconds * 1000)
  probe.heading.walking = false
  await sleep(1200)
}

async function walkUntilEpochs(server, probe, epochsWanted) {
  const startEpoch = serverEpoch(server)
  log(`walking from server epoch ${startEpoch}, want ${epochsWanted} more`)
  probe.heading.walking = true
  await until(() => serverEpoch(server) - startEpoch >= epochsWanted, RUN_LIMIT_MS, `${epochsWanted} epoch(s)`)
  log(`reached server epoch ${serverEpoch(server)}`)
  await sleep(4500)
  probe.heading.walking = false
  await sleep(1200)
}

async function scenarioWalk(name) {
  const { server, url } = await bootServer()
  baseChart = ledgerOf(server)?.base ?? null
  const mover = makeClient({ url, aware: AWARE, server })
  await mover.client.connect()
  startInput(mover)
  await settle(server, mover)
  if (name === 'natural') {
    const pos = server.playerManager.getPlayer(mover.client.playerId).state.position
    const z = findBoundaryZ(server, pos, 20)
    await mover.client.requestTeleport('to', { x: pos[0], z })
    await settle(server, mover)
  } else {
    await mover.client.requestTeleport('to', { x: 300, z: 300 })
    await settle(server, mover)
  }
  log(`settled at server epoch ${serverEpoch(server)}`)
  const pe = mover.client._msgHandler.getPredEngine()
  const baseline = { corrections: pe.stats.corrections, maxCorrectionM: pe.stats.maxCorrectionM }
  const stopFrames = startFrames(mover)
  const epochStart = serverEpoch(server)
  mover.frames.length = 0
  if (SERVICE) await walkUntilEpochs(server, mover, TARGET_EPOCHS)
  else await walkSeconds(mover, CONTROL_SECONDS)
  stopFrames()
  const result = summarizeRun(server, mover, { scenario: name, service: SERVICE, aware: AWARE, anchors: ANCHORS, hysteresisDeg: HYSTERESIS, epochsWalked: serverEpoch(server) - epochStart, baselineCorrections: baseline.corrections })
  mover.client.disconnect()
  server.stop()
  return result
}

async function scenarioInflight() {
  const { server, url } = await bootServer()
  baseChart = ledgerOf(server)?.base ?? null
  const mover = makeClient({ url, aware: true, server })
  await mover.client.connect()
  startInput(mover)
  await settle(server, mover)
  await walkUntilEpochs(server, mover, 2)
  const id = mover.client.playerId
  const current = serverEpoch(server)
  const ledger = ledgerOf(server)
  const results = {}
  const probeInput = (epoch, seq) => {
    const before = server.playerManager.getInputs(id).length
    server.connections.emit('message', id, { type: MSG.INPUT, payload: encodeInputPacket(DEFAULT_INPUT_SCHEMA, [{ sequence: seq, data: { yaw: 1.0, pitch: 0.2, forward: true } }], epoch) })
    const buffered = server.playerManager.getInputs(id).find(e => e.sequence === seq)
    return { buffered: !!buffered, yaw: buffered?.data.yaw, pitch: buffered?.data.pitch, queueGrew: server.playerManager.getInputs(id).length - before }
  }
  const expected = ledger.transferToCurrent(current - 1).look(1.0, 0.2)
  const stale = probeInput(current - 1, 5000001)
  results.staleInput = { ...stale, expectedYaw: expected.yaw, expectedPitch: expected.pitch, yawErr: stale.yaw == null ? null : Math.abs(stale.yaw - expected.yaw), pitchErr: stale.pitch == null ? null : Math.abs(stale.pitch - expected.pitch) }
  const fresh = probeInput(current, 5000002)
  results.currentInput = { ...fresh, yawRaw: Math.abs(fresh.yaw - 1.0) < 1e-4 }
  const future = probeInput(current + 3, 5000003)
  results.futureInput = { buffered: future.buffered }
  const seenShots = []
  server.connections.on('message', (cid, msg) => { if (msg.type === MSG.APP_EVENT && msg.payload?.type === 'fire') seenShots.push({ ...msg.payload }) })
  const origin = [10, 20, 30], direction = [0, 0, 1]
  server.connections.emit('message', id, { type: MSG.APP_EVENT, payload: { type: 'fire', origin: [...origin], direction: [...direction], chartEpoch: current - 1 } })
  const xf = ledger.transferToCurrent(current - 1)
  const expectedOrigin = xf.point(origin), expectedDirection = xf.vec(direction)
  const shot = seenShots[0]
  results.staleShot = { originErr: shot ? hypot3(shot.origin, expectedOrigin) : null, directionErr: shot ? hypot3(shot.direction, expectedDirection) : null, moved: shot ? hypot3(shot.origin, origin) : null }
  results.wire = wireStats(server)
  mover.client.disconnect()
  server.stop()
  return { scenario: 'inflight', currentEpoch: current, ...results }
}

async function scenarioJoin() {
  const { server, url } = await bootServer()
  baseChart = ledgerOf(server)?.base ?? null
  const mover = makeClient({ url, aware: true, server })
  await mover.client.connect()
  startInput(mover)
  await settle(server, mover)
  await walkUntilEpochs(server, mover, TARGET_EPOCHS)
  const epochAtJoin = serverEpoch(server)
  const joiner = makeClient({ url, aware: true, server })
  await joiner.client.connect()
  startInput(joiner)
  await until(() => joiner.client.playerId && joiner.client._msgHandler.getPredEngine()?.stats.acks > 10, 20000, 'joiner acks')
  const joinerEpochAtAck = joiner.client._chart.epoch
  joiner.heading.walking = true
  const stopFrames = startFrames(joiner)
  await sleep(6000)
  stopFrames()
  joiner.heading.walking = false
  const jp = joiner.client._msgHandler.getPredEngine()
  const serverPos = server.playerManager.getPlayer(joiner.client.playerId).state.position
  const localPos = joiner.client.getLocalState().position
  const reconnectEpochBefore = joiner.client._chart.epoch
  const adoptionsBefore = joiner.client.getChartStats().adoptions
  joiner.client.ws.close()
  await until(() => joiner.client.getChartStats().adoptions > adoptionsBefore, 30000, 'reconnect ack')
  await sleep(1500)
  const out = {
    scenario: 'join', serverEpochAtJoin: epochAtJoin, joinerEpochAtFirstAcks: joinerEpochAtAck, joinerCorrections: jp.stats.corrections, joinerMaxCorrectionM: round(jp.stats.maxCorrectionM, 4),
    joinerVsServerM: round(hypot3(serverPos, localPos), 4), heldSnapshots: joiner.client.getChartStats().heldSnapshots,
    reconnect: { epochBefore: reconnectEpochBefore, epochAfter: joiner.client._chart.epoch, serverEpoch: serverEpoch(server), connected: joiner.client.connected }
  }
  mover.client.disconnect(); joiner.client.disconnect()
  server.stop()
  return out
}

async function scenarioMissed() {
  const { server, url } = await bootServer()
  baseChart = ledgerOf(server)?.base ?? null
  const mover = makeClient({ url, aware: true, server })
  await mover.client.connect()
  startInput(mover)
  await settle(server, mover)
  mover.drop = true
  mover.forceHardResync = args.hard === '1'
  const pe = mover.client._msgHandler.getPredEngine()
  const baseline = { corrections: pe.stats.corrections, epoch: mover.client._chart.epoch }
  const switchedAt = { t: 0 }
  const startEpoch = serverEpoch(server)
  mover.heading.walking = true
  await until(() => serverEpoch(server) > startEpoch, RUN_LIMIT_MS, 'a server epoch')
  switchedAt.t = performance.now()
  const stats = () => mover.client.getChartStats()
  await until(() => stats().heldSnapshots > 0 || mover.client._chart.epoch === serverEpoch(server), 10000, 'snapshot hold')
  const heldAt = performance.now()
  await until(() => stats().resyncRequests > 0 || mover.client._chart.epoch === serverEpoch(server), 10000, 'resync request')
  const requestedAt = performance.now()
  let teleportReject = null
  const probeTeleport = mover.client.requestTeleport('probe', { x: 0, z: 0 }).catch(e => { teleportReject = e.ack?.error || e.message })
  await until(() => mover.client._chart.epoch === serverEpoch(server), 20000, 'chart resync')
  const recoveredAt = performance.now()
  await probeTeleport
  mover.heading.walking = false
  await sleep(2000)
  const serverPos = server.playerManager.getPlayer(mover.client.playerId).state.position
  const serverWorld = createChartTransfer(serverChart(server), baseChart).point(serverPos)
  const clientWorld = worldOf(mover, mover.client.getLocalState().position)
  const out = {
    scenario: 'missed', hardResyncForced: args.hard === '1', droppedBroadcasts: mover.droppedBroadcasts, correctionsBefore: baseline.corrections, correctionsAfter: pe.stats.corrections,
    firstHeldSnapshotMs: Math.round(heldAt - switchedAt.t), resyncRequestedMs: Math.round(requestedAt - switchedAt.t), recoveryMs: Math.round(recoveredAt - switchedAt.t), chart: stats(), staleTeleportRejected: teleportReject,
    finalClientVsServerWorldM: round(hypot3(serverWorld, clientWorld), 4), wire: wireStats(server)
  }
  mover.client.disconnect()
  server.stop()
  return out
}

async function scenarioReorder() {
  const { server, url } = await bootServer()
  baseChart = ledgerOf(server)?.base ?? null
  const mover = makeClient({ url, aware: true, server })
  await mover.client.connect()
  startInput(mover)
  await mover.client.requestTeleport('to', { x: 300, z: 300 })
  await settle(server, mover)
  const stopFrames = startFrames(mover)
  mover.delayMs = Number(args.delayMs ?? 120)
  const serverTrace = []
  const clientSteps = new Map()
  if (args.serverTrace === '1') { const peT = mover.client._msgHandler.getPredEngine(); const addInputOriginal = peT.addInput.bind(peT); peT.addInput = (input, a, b) => { const seq = addInputOriginal(input, a, b); clientSteps.set(seq, { z: peT.localState.position[2], x: peT.localState.position[0], y: peT.localState.position[1], vz: peT.localState.velocity[2], epoch: mover.client._chart.epoch }); return seq }; const applyOriginal = peT.applyChartTransfer.bind(peT); peT.applyChartTransfer = (pass, ackSeq) => { applyOriginal(pass, ackSeq); for (const e of peT.inputHistory) clientSteps.set(e.sequence, { ...clientSteps.get(e.sequence), replayedZ: e.position[2], replayedX: e.position[0], replayedY: e.position[1], replayedVz: e.velocity[2] }) } }
  if (args.serverTrace === '1') server.tickSystem.onTick(tick => {
    const p = server.playerManager.getPlayer(mover.client.playerId)
    if (p) serverTrace.push({ tick, epoch: serverEpoch(server), x: p.state.position[0], y: p.state.position[1], z: p.state.position[2], vy: p.state.velocity[1], g: p.state.onGround, ack: p.ackSequence, nrm: p.state.groundNormal ? [...p.state.groundNormal] : null })
  })
  const pe = mover.client._msgHandler.getPredEngine()
  if (args.noreplay === '1') pe._replayInputsAfterChartSwitch = () => {}
  const replayLog = []
  const stepLog = []
  if (args.stepTrace === '1') { const stepOriginal = pe._step.bind(pe); let replaying = false; pe._step = (input, seq, normal) => { const before = [...pe.localState.position]; const result = stepOriginal(input, seq, normal); stepLog.push({ ph: replaying ? 'R' : 'O', seq, n: pe._env.groundNormal ? pe._env.groundNormal.map(v => +v.toFixed(5)) : null, ground: !!pe._env.ground, collider: !!pe._env.collider, wedged: pe._env.wedged, dy: +(pe.localState.position[1] - before[1]).toFixed(5), dz: +(pe.localState.position[2] - before[2]).toFixed(5), vz: +pe.localState.velocity[2].toFixed(3), gY: +pe.localState.groundY.toFixed(5) }); return result }; const replayWrap = pe._replayInputsAfterChartSwitch.bind(pe); pe._replayInputsAfterChartSwitch = a => { replaying = true; replayWrap(a); replaying = false } }
  if (args.replayTrace === '1') { const replayOriginal = pe._replayInputsAfterChartSwitch.bind(pe); pe._replayInputsAfterChartSwitch = ackSeq => { const before = [...pe.inputHistory].map(e => ({ seq: e.sequence, p: [...e.position], v: [...e.velocity], g: e.onGround, gy: e.groundY, yaw: e.data.yaw, pitch: e.data.pitch })); const gn = pe.lastServerState.groundNormal ? [...pe.lastServerState.groundNormal] : null; const surf = pe._surface ? { so: pe._surface.standOffset, on: pe._surface.onSurface } : null; replayOriginal(ackSeq); const after = [...pe.inputHistory]; replayLog.push({ ackSeq, gn, surf, lsOnGround: pe.localState.onGround, rows: before.map((b, i) => ({ seq: b.seq, dx: +(after[i].position[0] - b.p[0]).toFixed(5), dy: +(after[i].position[1] - b.p[1]).toFixed(5), dz: +(after[i].position[2] - b.p[2]).toFixed(5), vyOld: +b.v[1].toFixed(4), vyNew: +after[i].velocity[1].toFixed(4), gOld: b.g, gNew: after[i].onGround, yawD: +(after[i].data.yaw - b.yaw).toFixed(6) })) }) } }
  if (args.keepSurface === '1') { const applyOriginal = pe.applyChartTransfer.bind(pe); pe.applyChartTransfer = (pass, ackSeq) => { const s = pe._surface, saved = s && { o: s.standOffset, on: s.onSurface }; applyOriginal(pass, ackSeq); if (s) { s.standOffset = saved.o; s.onSurface = saved.on } } }
  const correctionsBefore = pe.stats.corrections
  await walkUntilEpochs(server, mover, 1)
  stopFrames()
  const firstNew = serverTrace.findIndex(s => s.epoch >= 2)
  const sw2 = mover.switches[mover.switches.length - 1]
  const stepTable = sw2 ? serverTrace.filter(s => s.ack >= sw2.ackSeq - 3 && s.ack <= sw2.ackSeq + 6).map(s => ({ ack: s.ack, sEpoch: s.epoch, sx: +s.x.toFixed(4), sy: +s.y.toFixed(4), sz: +s.z.toFixed(4), cl: clientSteps.get(s.ack) ? Object.fromEntries(Object.entries(clientSteps.get(s.ack)).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(4) : v])) : null })) : []
  const out = summarizeRun(server, mover, { stepLog: stepLog.filter(s => s.seq >= (mover.switches[1]?.ackSeq ?? 1e9) - 3 && s.seq <= (mover.switches[1]?.ackSeq ?? 0) + 14), replayLog, stepTable, serverAround: firstNew >= 0 ? serverTrace.slice(Math.max(0, firstNew - 3), firstNew + 70).map(s => [s.tick, s.epoch, +s.y.toFixed(4), +s.vy.toFixed(4), s.g ? 1 : 0, s.ack, s.nrm ? s.nrm.map(v => +v.toFixed(4)).join(',') : null].join(' ')) : undefined, scenario: 'reorder', delayMs: mover.delayMs, delayedBroadcasts: mover.delayedBroadcasts, correctionsDuringWalk: pe.stats.corrections - correctionsBefore })
  mover.client.disconnect()
  server.stop()
  return out
}

async function scenarioExpired() {
  const { createChartEpochLedger } = await import('../src/shared/chartEpochLedger.js')
  const { snapshotChart } = await import('../src/shared/chartAnchor.js')
  const { createChartResyncReply } = await import('../src/sdk/chartWire.js')
  const { server } = await bootServer()
  const frame = server.physics._planetFrame
  server.stop()
  const retained = createChartEpochLedger({ frame, retainedEpochs: 2 })
  const stepDir = [0.2, 0.9, 0.1]
  for (let i = 0; i < 5; i++) { frame.reanchor(stepDir.map((c, k) => c + i * 0.01 * (k + 1))); retained.record(snapshotChart(frame)) }
  const ctx = { chartEpochLedger: retained, physics: server.physics, tickSystem: server.tickSystem }
  const old = createChartResyncReply(ctx, 1)
  const base = createChartResyncReply(ctx, 0)
  const recent = createChartResyncReply(ctx, retained.currentEpoch - 1)
  return { scenario: 'expired', currentEpoch: retained.currentEpoch, requestFromExpiredEpoch1: { resync: old.resync === true, hasFrom: !!old.from, to: old.to.e }, requestFromBaseEpoch0: { resync: base.resync === true, from: base.from?.e, to: base.to.e }, requestFromRecent: { resync: recent.resync === true, from: recent.from?.e, to: recent.to.e }, wire: ctx.chartWireStats }
}

const scenarios = { reorder: scenarioReorder, forced: () => scenarioWalk('forced'), natural: () => scenarioWalk('natural'), chain: () => scenarioWalk('chain'), inflight: scenarioInflight, join: scenarioJoin, missed: scenarioMissed, expired: scenarioExpired }
const run = scenarios[SCENARIO]
if (!run) { console.error(`unknown scenario ${SCENARIO}; one of ${Object.keys(scenarios).join(', ')}`); process.exit(2) }
const EXPECTATIONS = {
  expired: r => [
    [r.requestFromExpiredEpoch1?.resync === true, 'requestFromExpiredEpoch1.resync !== true -- an epoch outside the retained window must force a hard resync'],
    [r.requestFromExpiredEpoch1?.hasFrom === false, 'requestFromExpiredEpoch1.hasFrom !== false -- an expired epoch must not be re-expressed'],
    [r.requestFromBaseEpoch0?.resync === false, 'requestFromBaseEpoch0.resync !== false -- the base epoch is always re-expressible'],
    [r.requestFromRecent?.resync === false, 'requestFromRecent.resync !== false -- a retained epoch is re-expressible'],
  ],
  missed: r => [
    [Number.isFinite(r.finalClientVsServerWorldM), `finalClientVsServerWorldM is ${JSON.stringify(r.finalClientVsServerWorldM ?? null)} -- the missed arm produced no convergence measurement`],
    [r.droppedBroadcasts > 0, `droppedBroadcasts is ${JSON.stringify(r.droppedBroadcasts ?? null)} -- the drop path never ran, so the missed arm measured nothing`],
  ],
  reorder: r => [
    [r.delayedBroadcasts > 0, `delayedBroadcasts is ${JSON.stringify(r.delayedBroadcasts ?? null)} -- the reorder delay path never ran, so the reorder arm measured nothing`],
    [(r.switches || []).length > 0, 'no chart switch was recorded -- the reorder arm produced no switch data'],
    [(r.switches || []).every(s => s.renderJumpM == null || Number.isFinite(s.renderJumpM)), 'a recorded switch carries a non-finite renderJumpM'],
  ],
}

const result = await run()
const text = JSON.stringify(result, null, 1)
if (args.out) await writeFile(args.out, text)
console.log('RESULT_JSON_BEGIN')
console.log(text)
console.log('RESULT_JSON_END')

if (!result || typeof result !== 'object' || Object.keys(result).length === 0) {
  console.error(`[wire-harness] FAIL: scenario ${SCENARIO} produced no result`)
  process.exit(1)
}
const broken = (EXPECTATIONS[SCENARIO] ? EXPECTATIONS[SCENARIO](result) : []).filter(([ok]) => !ok).map(([, message]) => message)
if (broken.length) {
  for (const message of broken) console.error(`[wire-harness] FAIL: ${message}`)
  process.exit(1)
}
process.exit(0)
