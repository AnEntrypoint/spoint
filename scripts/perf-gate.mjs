#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import WebSocket from 'ws'
import { MSG } from '../src/protocol/MessageTypes.js'
import { pack, unpack, ensurePacked } from '../src/protocol/msgpack.js'
import { contentionMark, contentionVerdict, contentionWatch, formatContention } from './lib/host-contention.mjs'
import { measureUncontested, fingerprintFields, formatRowContention, describeContested } from './lib/timing-gate.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASELINE_PATH = join(__dirname, '..', '.perf-baseline.json')
const THRESHOLD = 1.10
const UPDATE = process.argv.includes('--update-baseline')

const WARMUP_MS = 3000
const MEASURE_MS = 4000
const IDLE_SETTLE_MS = 250
const CPU_BUDGET_FRACTION = 0.85
const CONTEST_RETRIES = Math.max(1, parseInt(process.env.PERF_GATE_CONTEST_RETRIES || '3', 10))

const CLIENT_COUNT = Math.max(0, parseInt(process.env.PERF_GATE_CLIENTS || '4', 10))
const CLIENT_SETTLE_MS = 1500
const CLIENT_MEASURE_MS = 4000
const CLIENT_INPUT_HZ = 30

const COALESCE_SENTINEL = 0xff
function decodeFrame(data) {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (!(bytes.length > 0 && bytes[0] === COALESCE_SENTINEL)) return [unpack(bytes)]
  const out = [], view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let off = 1
  while (off + 4 <= bytes.length) {
    const len = view.getUint32(off, true); off += 4
    if (off + len > bytes.length) break
    out.push(unpack(bytes.subarray(off, off + len))); off += len
  }
  return out
}

function mulberry32(a) { return function() { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } }

async function readTickMetrics(port) {
  const txt = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text()
  const g = re => { const m = txt.match(re); return m ? parseFloat(m[1]) : NaN }
  return {
    snapAvgMs: g(/spoint_tick_phase_avg_ms\{phase="snap"\} ([0-9.]+)/),
    totalAvgMs: g(/spoint_tick_phase_avg_ms\{phase="total"\} ([0-9.]+)/),
    sampleCount: g(/spoint_tick_phase_sample_count ([0-9.]+)/),
    snapBytes: g(/spoint_snapshot_bytes_total ([0-9.]+)/),
    snapPacks: g(/spoint_snapshot_bytes_count ([0-9.]+)/),
  }
}

function connectClient(port, seed) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    ws.binaryType = 'arraybuffer'
    const timer = setTimeout(() => reject(new Error('timeout waiting for HANDSHAKE_ACK')), 10000)
    let playerId = null, snapshots = 0, timerHandle = null, seq = 0, k = 0
    const rng = mulberry32(seed)
    ws.on('message', d => {
      let msgs; try { msgs = decodeFrame(d) } catch (_) { return }
      for (const m of msgs) {
        if (m.type === MSG.HANDSHAKE_ACK && playerId == null) {
          playerId = m.payload.playerId; clearTimeout(timer)
          timerHandle = setInterval(() => {
            const input = { forward: rng() < 0.7 ? 1 : 0, backward: rng() < 0.1 ? 1 : 0, left: rng() < 0.25 ? 1 : 0, right: rng() < 0.25 ? 1 : 0, jump: rng() < 0.05, sprint: rng() < 0.3, yaw: (k * 0.03 + playerId) % 6.28, pitch: Math.sin(k * 0.05) * 0.5 }
            k++; seq++
            try { ws.send(pack({ type: MSG.PLAYER_INPUT, payload: { input, sequence: seq } })) } catch (_) {}
          }, 1000 / CLIENT_INPUT_HZ)
          resolve({ get playerId() { return playerId }, get snapshots() { return snapshots }, stop() { clearInterval(timerHandle); try { ws.close() } catch (_) {} } })
        } else if (m.type === MSG.SNAPSHOT) snapshots++
      }
    })
    ws.on('error', err => { clearTimeout(timer); reject(err) })
  })
}

async function measureWithClients(server, port, mark) {
  if (CLIENT_COUNT === 0) return null
  const tickSystem = server.tickSystem
  await ensurePacked
  console.log(`[perf-gate] connecting ${CLIENT_COUNT} real WebSocket clients (PLAYER_INPUT @ ${CLIENT_INPUT_HZ}Hz each) ...`)
  const clients = []
  try {
    for (let i = 0; i < CLIENT_COUNT; i++) clients.push(await connectClient(port, 1234 + i * 977))
    await new Promise(r => setTimeout(r, CLIENT_SETTLE_MS))
    const m0 = await readTickMetrics(port)
    const before = tickSystem.currentTick
    cpuReset()
    console.log(`[perf-gate] measuring ${CLIENT_MEASURE_MS}ms of real ticks with ${clients.length} players (tick=${before}) ...`)
    await new Promise(r => setTimeout(r, CLIENT_MEASURE_MS / 2))
    if (mark) mark()
    await new Promise(r => setTimeout(r, CLIENT_MEASURE_MS / 2))
    const samples = tickSystem._tickBudgetMs.slice()
    const m1 = await readTickMetrics(port)
    const after = tickSystem.currentTick
    const win = cpuReset()
    const sorted = samples.slice().sort((a, b) => a - b)
    const n = m1.sampleCount - m0.sampleCount
    const winSnap = n > 0 ? (m1.snapAvgMs * m1.sampleCount - m0.snapAvgMs * m0.sampleCount) / n : NaN
    const winTotal = n > 0 ? (m1.totalAvgMs * m1.sampleCount - m0.totalAvgMs * m0.sampleCount) / n : NaN
    const packs = m1.snapPacks - m0.snapPacks, bytes = m1.snapBytes - m0.snapBytes
    return {
      clients: clients.length, ticks: after - before, snapshotsReceived: clients.reduce((s, c) => s + c.snapshots, 0),
      avgMs: samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length), p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95), maxMs: sorted.length ? sorted[sorted.length - 1] : 0,
      snapAvgMs: winSnap, totalAvgMs: winTotal, packs, bytes, bytesPerPack: packs > 0 ? bytes / packs : NaN,
      cpuMsPerTick: win.ticks > 0 ? win.cpuMs / win.ticks : NaN, cpuTickCount: win.ticks,
    }
  } finally {
    for (const c of clients) c.stop()
  }
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return null
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
}

function writeBaseline(data) {
  writeFileSync(BASELINE_PATH, JSON.stringify(data, null, 2) + '\n')
  console.log(`[perf-gate] baseline written: ${BASELINE_PATH}`)
  console.log(JSON.stringify(data, null, 2))
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length))
  return sorted[idx]
}

const tickCpu = { user: 0, system: 0, ticks: 0 }
function cpuReset() {
  const cpuMs = (tickCpu.user + tickCpu.system) / 1000
  const ticks = tickCpu.ticks
  tickCpu.user = 0
  tickCpu.system = 0
  tickCpu.ticks = 0
  return { cpuMs, ticks }
}

function instrumentTickCpu(tickSystem) {
  const realRunOneTick = tickSystem._runOneTick.bind(tickSystem)
  tickSystem._runOneTick = function () {
    const since = process.cpuUsage()
    const out = realRunOneTick()
    const d = process.cpuUsage(since)
    tickCpu.user += d.user
    tickCpu.system += d.system
    tickCpu.ticks++
    return out
  }
}

async function measureRealTickBudget() {
  console.log('[perf-gate] booting real server (WORLD=tps-game) ...')
  process.env.WORLD = process.env.WORLD || 'tps-game'
  process.env.PORT = process.env.PORT || '3097'
  const { boot } = await import('../src/sdk/server.js')
  const server = await boot()
  const tickSystem = server.tickSystem
  if (!tickSystem) throw new Error('boot() did not return a server with a tickSystem -- perf-gate cannot measure')
  instrumentTickCpu(tickSystem)

  console.log(`[perf-gate] warming up ${WARMUP_MS}ms (world load + physics settle) ...`)
  await new Promise(r => setTimeout(r, WARMUP_MS))

  const idle = await measureUncontested('[perf-gate] idle tick window', async (mark) => {
    await new Promise(r => setTimeout(r, IDLE_SETTLE_MS))
    cpuReset()
    const before = tickSystem.currentTick
    await new Promise(r => setTimeout(r, MEASURE_MS / 2))
    if (mark) mark()
    await new Promise(r => setTimeout(r, MEASURE_MS / 2))
    const after = tickSystem.currentTick
    const win = cpuReset()
    return { before, after, ticks: after - before, cpuMs: win.cpuMs, cpuTicks: win.ticks, samples: tickSystem._tickBudgetMs.slice() }
  }, { retries: CONTEST_RETRIES })
  const dilationFactor = tickSystem.dilationFactor
  console.log(`[perf-gate] idle window done (ticks ${idle.before} -> ${idle.after}, ${idle.ticks} ticks ran, ${idle.samples.length} wall samples captured, ${idle.cpuTicks} of them timed on CPU, ${idle.attempts} attempt(s))`)

  let withClients = null
  let withClientsContention = null
  try {
    const watch = contentionWatch()
    withClients = await measureWithClients(server, parseInt(process.env.PORT, 10), () => contentionMark(watch))
    withClientsContention = contentionVerdict(watch)
  } catch (e) { console.warn(`[perf-gate] with-clients phase failed (idle result unaffected): ${e.message}`) }

  console.log('[perf-gate] shutting server down ...')
  server.stop()
  await new Promise(r => setTimeout(r, 500))

  const samples = idle.samples
  if (samples.length === 0) throw new Error('no tick samples captured -- the tick loop did not run during the measurement window')

  const sorted = samples.slice().sort((a, b) => a - b)
  const sum = samples.reduce((a, b) => a + b, 0)
  const avgMs = sum / samples.length
  const p50Ms = percentile(sorted, 0.5)
  const p95Ms = percentile(sorted, 0.95)
  const maxMs = sorted[sorted.length - 1]
  const tickBudgetMs = 1000 / tickSystem.tickRate

  return {
    avgMs, p50Ms, p95Ms, maxMs, sampleCount: samples.length, tickRate: tickSystem.tickRate, tickBudgetMs, dilationFactor, withClients,
    cpuMsPerTick: idle.cpuTicks > 0 ? idle.cpuMs / idle.cpuTicks : NaN,
    cpuWindowMs: idle.cpuMs, cpuTickCount: idle.cpuTicks,
    withClientsContention,
    ...fingerprintFields(idle),
  }
}

async function main() {
  let metrics
  try {
    metrics = await measureRealTickBudget()
  } catch (e) {
    console.error('[perf-gate] real-server measurement FAILED:\n', e.stack || e.message)
    process.exit(1)
  }

  console.log(`[perf-gate] avg=${metrics.avgMs.toFixed(3)}ms p50=${metrics.p50Ms.toFixed(3)}ms p95=${metrics.p95Ms.toFixed(3)}ms max=${metrics.maxMs.toFixed(3)}ms budget=${metrics.tickBudgetMs.toFixed(3)}ms (${metrics.tickRate}Hz) dilation=${metrics.dilationFactor} samples=${metrics.sampleCount}`)
  console.log(`[perf-gate] cpu=${metrics.cpuMsPerTick.toFixed(3)}ms/tick over ${metrics.cpuTickCount} tick(s) (${metrics.cpuWindowMs.toFixed(0)}ms of CPU inside the tick calls) ceiling=${(metrics.tickBudgetMs * CPU_BUDGET_FRACTION).toFixed(3)}ms (${CPU_BUDGET_FRACTION} of the tick budget)`)
  console.log(`[perf-gate] ${formatRowContention(metrics)}`)
  const wc = metrics.withClients
  if (wc) {
    console.log(`[perf-gate] with-clients(N=${wc.clients}, informational): tick avg=${wc.avgMs.toFixed(3)}ms p50=${wc.p50Ms.toFixed(3)}ms p95=${wc.p95Ms.toFixed(3)}ms max=${wc.maxMs.toFixed(3)}ms cpu=${Number.isFinite(wc.cpuMsPerTick) ? wc.cpuMsPerTick.toFixed(3) + 'ms/tick' : 'n/a'} | onTick.getMetrics avgSnapMs=${wc.snapAvgMs.toFixed(3)}ms avgTotalMs=${wc.totalAvgMs.toFixed(3)}ms over ${wc.ticks} ticks | ${wc.packs} packs, ${wc.bytesPerPack.toFixed(1)} bytes/pack, ${wc.snapshotsReceived} snapshots received by clients`)
    if (metrics.withClientsContention) console.log(`[perf-gate] with-clients ${formatContention(metrics.withClientsContention)}`)
  }

  if (metrics.contested) {
    console.error(`[perf-gate] INCONCLUSIVE: ${describeContested([metrics], CONTEST_RETRIES)}`)
    process.exit(1)
  }
  if (metrics.dilationFactor < 1.0) {
    console.error(`[perf-gate] FAIL: tick loop is self-dilating (dilationFactor=${metrics.dilationFactor} < 1.0) -- server is overloaded at real tick rate`)
    process.exit(1)
  }
  if (metrics.p95Ms > metrics.tickBudgetMs) {
    console.error(`[perf-gate] FAIL: p95 tick time ${metrics.p95Ms.toFixed(3)}ms exceeds the ${metrics.tickBudgetMs.toFixed(3)}ms tick budget (${metrics.tickRate}Hz) -- CPU time per tick was ${metrics.cpuMsPerTick.toFixed(3)}ms, so a wall tick this long is blocking work, not work the tick asked for`)
    process.exit(1)
  }
  if (!(metrics.cpuMsPerTick > 0)) {
    console.error(`[perf-gate] FAIL: the window captured no CPU time inside the tick calls (${metrics.cpuTickCount} tick(s) instrumented), so the CPU gate has nothing to compare`)
    process.exit(1)
  }
  const cpuCeilingMs = metrics.tickBudgetMs * CPU_BUDGET_FRACTION
  if (metrics.cpuMsPerTick > cpuCeilingMs) {
    console.error(`[perf-gate] FAIL: ${metrics.cpuMsPerTick.toFixed(3)}ms of CPU per tick exceeds ${cpuCeilingMs.toFixed(3)}ms (${CPU_BUDGET_FRACTION} of the ${metrics.tickBudgetMs.toFixed(3)}ms tick budget at ${metrics.tickRate}Hz), measured inside the tick calls over ${metrics.cpuTickCount} tick(s)`)
    process.exit(1)
  }

  if (UPDATE) {
    const base = { avgMs: metrics.avgMs, p50Ms: metrics.p50Ms, p95Ms: metrics.p95Ms, tickRate: metrics.tickRate, cpuMsPerTick: metrics.cpuMsPerTick }
    if (wc) base.withClients = { clients: wc.clients, avgMs: wc.avgMs, p50Ms: wc.p50Ms, p95Ms: wc.p95Ms, cpuMsPerTick: wc.cpuMsPerTick, avgSnapMs: wc.snapAvgMs, bytesPerPack: wc.bytesPerPack }
    writeBaseline(base)
    console.log('[perf-gate] baseline updated. PASS')
    process.exit(0)
  }

  const baseline = readBaseline()
  if (!baseline) {
    console.error('[perf-gate] no baseline found. Run with --update-baseline to create one.')
    process.exit(1)
  }
  if (baseline.tickRate && baseline.tickRate !== metrics.tickRate) {
    console.warn(`[perf-gate] WARNING: baseline tickRate (${baseline.tickRate}Hz) differs from measured (${metrics.tickRate}Hz) -- comparison may not be meaningful, consider --update-baseline`)
  }

  const baseMs = baseline.p50Ms
  if (baseMs == null) {
    console.error('[perf-gate] baseline missing p50Ms. Run with --update-baseline to refresh.')
    process.exit(1)
  }
  if (Number.isFinite(baseline.cpuMsPerTick) && baseline.cpuMsPerTick > 0) {
    const cpuLimit = baseline.cpuMsPerTick * THRESHOLD
    console.log(`[perf-gate] baseline cpu=${baseline.cpuMsPerTick.toFixed(3)}ms/tick limit=${cpuLimit.toFixed(3)}ms (+10%) measured cpu=${metrics.cpuMsPerTick.toFixed(3)}ms/tick over ${metrics.cpuTickCount} tick(s)`)
    if (metrics.cpuMsPerTick > cpuLimit) {
      console.error(`[perf-gate] REGRESSION: ${metrics.cpuMsPerTick.toFixed(3)}ms of CPU per tick > ${cpuLimit.toFixed(3)}ms (${((metrics.cpuMsPerTick / baseline.cpuMsPerTick - 1) * 100).toFixed(1)}% over baseline), measured inside the tick calls rather than on the wall clock the box shares`)
      process.exit(1)
    }
  } else {
    console.log(`[perf-gate] baseline has no cpuMsPerTick, so the relative decision rests on wall p50 alone -- run --update-baseline to gate it on CPU instead`)
  }
  const ABS_FLOOR_MS = 0.20
  const limit = baseMs * THRESHOLD
  const overRelative = metrics.p50Ms > limit
  console.log(`[perf-gate] baseline p50=${baseMs.toFixed(3)}ms limit=${limit.toFixed(3)}ms (+10%) measured p50=${metrics.p50Ms.toFixed(3)}ms abs_floor_ms=${ABS_FLOOR_MS.toFixed(3)}ms (informational) budget=${metrics.tickBudgetMs.toFixed(3)}ms`)

  if (overRelative) {
    console.error(`[perf-gate] REGRESSION: ${metrics.p50Ms.toFixed(3)}ms > ${limit.toFixed(3)}ms (${((metrics.p50Ms / baseMs - 1) * 100).toFixed(1)}% over baseline) -- a relative regression fails the gate on its own; the ${ABS_FLOOR_MS.toFixed(3)}ms absolute floor is informational only`)
    process.exit(1)
  }

  console.log('[perf-gate] PASS')
  process.exit(0)
}

main()
