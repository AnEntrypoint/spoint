#!/usr/bin/env node
// perf-gate.mjs -- repo-root performance regression gate (zero deps).
//
// Boots the REAL spoint server (src/sdk/server.js boot()) against the REAL tps-game world
// (apps/world/tps-game.js -- terrain + vegetation + rocks + the tps-game app, the actual game
// entities a player loads into), lets its real 64Hz tick loop run for a short measurement
// window, and reads TickSystem's own per-tick wall-time samples (`_tickBudgetMs`, the same
// numbers TickSystem's own auto-dilation control loop uses) as the frame-budget metric.
//
// Follows the same pattern as packages/mapspinner/scripts/perf-gate.mjs (baseline JSON,
// --update-baseline, +10% regression threshold, pass/fail exit code) adapted from a
// package-isolated shader-compile stress scene to a real running game-world tick loop.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import WebSocket from 'ws'
import { MSG } from '../src/protocol/MessageTypes.js'
import { pack, unpack, ensurePacked } from '../src/protocol/msgpack.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASELINE_PATH = join(__dirname, '..', '.perf-baseline.json')
const THRESHOLD = 1.10
const UPDATE = process.argv.includes('--update-baseline')

// Real measurement window: long enough to accumulate TickSystem's own DILATION_WINDOW (60
// ticks) of samples at the world's configured 64Hz tick rate (~940ms) plus warmup headroom for
// world load (physics init, terrain heightfield load, app spawn) before the window starts.
const WARMUP_MS = 3000
const MEASURE_MS = 4000

// With-clients phase (informational, never gated): after the idle window, N real `ws` clients join
// through the real handshake (same wire path as a browser's PhysicsNetworkClient), each streaming
// PLAYER_INPUT at CLIENT_INPUT_HZ with a seeded walk, and the server's own per-tick numbers are read
// again over CLIENT_MEASURE_MS -- TickSystem._tickBudgetMs (whole tick) plus onTick.getMetrics()'s
// avgSnapMs (the snapshot-build phase alone, via the /metrics route that renders it; the returned
// server object does not expose ctx). The idle number stays the gated one so an idle-only baseline
// keeps comparing like-for-like; the with-clients numbers are printed, and written to the baseline
// file (a separate `withClients` field) only on --update-baseline.
const CLIENT_COUNT = Math.max(0, parseInt(process.env.PERF_GATE_CLIENTS || '4', 10))
const CLIENT_SETTLE_MS = 1500
const CLIENT_MEASURE_MS = 4000
const CLIENT_INPUT_HZ = 30

// Must mirror ConnectionManager.js's COALESCE_SENTINEL/frameCoalesced (server) and BaseClient.js's
// splitCoalesced (client): flushAll folds every message queued for a client in one tick into ONE
// socket.send() prefixed with 0xFF followed by repeated [uint32 LE length][payload] records.
function decodeFrame(data) {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (!(bytes.length > 0 && bytes[0] === 0xff)) return [unpack(bytes)]
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

// Connects one real WebSocket client, resolves once its HANDSHAKE_ACK arrives, and returns a handle
// whose input loop streams a seeded walk until stop().
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

// Runs the with-clients phase against an already-booted server. Never throws into the gate: any
// failure here is reported and the idle result stands on its own.
async function measureWithClients(server, port) {
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
    console.log(`[perf-gate] measuring ${CLIENT_MEASURE_MS}ms of real ticks with ${clients.length} players (tick=${before}) ...`)
    await new Promise(r => setTimeout(r, CLIENT_MEASURE_MS))
    const samples = tickSystem._tickBudgetMs.slice()
    const m1 = await readTickMetrics(port)
    const after = tickSystem.currentTick
    const sorted = samples.slice().sort((a, b) => a - b)
    // getMetrics() averages accumulate from boot over ticks with players>0 and never reset on read, so
    // the window's own average is the delta of (avg*count) between the two reads divided by the delta count.
    const n = m1.sampleCount - m0.sampleCount
    const winSnap = n > 0 ? (m1.snapAvgMs * m1.sampleCount - m0.snapAvgMs * m0.sampleCount) / n : NaN
    const winTotal = n > 0 ? (m1.totalAvgMs * m1.sampleCount - m0.totalAvgMs * m0.sampleCount) / n : NaN
    const packs = m1.snapPacks - m0.snapPacks, bytes = m1.snapBytes - m0.snapBytes
    return {
      clients: clients.length, ticks: after - before, snapshotsReceived: clients.reduce((s, c) => s + c.snapshots, 0),
      avgMs: samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length), p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95), maxMs: sorted.length ? sorted[sorted.length - 1] : 0,
      snapAvgMs: winSnap, totalAvgMs: winTotal, packs, bytes, bytesPerPack: packs > 0 ? bytes / packs : NaN,
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

// Boots the real server against the real tps-game world, samples real per-tick CPU wall-time
// over MEASURE_MS after a WARMUP_MS settle window, then shuts the server down cleanly.
async function measureRealTickBudget() {
  console.log('[perf-gate] booting real server (WORLD=tps-game) ...')
  process.env.WORLD = process.env.WORLD || 'tps-game'
  // Fixed, unlikely-to-collide port for the gate run -- overridable, but never the game's own
  // default 3001 (a perf-gate run must not fight a real dev server already listening there).
  process.env.PORT = process.env.PORT || '3097'
  const { boot } = await import('../src/sdk/server.js')
  const server = await boot()
  const tickSystem = server.tickSystem
  if (!tickSystem) throw new Error('boot() did not return a server with a tickSystem -- perf-gate cannot measure')

  console.log(`[perf-gate] warming up ${WARMUP_MS}ms (world load + physics settle) ...`)
  await new Promise(r => setTimeout(r, WARMUP_MS))

  // Snapshot TickSystem's own rolling per-tick budget samples before and after the measurement
  // window -- the delta is exactly the ticks that ran DURING this window, real wall-clock
  // per-tick cost from the actual running game loop, not a synthetic stand-in.
  const before = tickSystem.currentTick
  console.log(`[perf-gate] measuring ${MEASURE_MS}ms of real ticks (tick=${before}, tickRate=${tickSystem.tickRate}Hz) ...`)
  await new Promise(r => setTimeout(r, MEASURE_MS))
  const after = tickSystem.currentTick
  // _tickBudgetMs is a rolling window (DILATION_WINDOW=60 samples, see TickSystem.js) of the
  // MOST RECENT ticks' wall time -- read it now, right after the window, so it reflects ticks
  // from (approximately) this measurement period rather than stale ticks from warmup.
  const samples = tickSystem._tickBudgetMs.slice()
  const dilationFactor = tickSystem.dilationFactor
  console.log(`[perf-gate] idle window done (ticks ${before} -> ${after}, ${after - before} ticks ran, ${samples.length} samples captured)`)

  // Informational with-clients phase on the SAME booted server, after the idle window has been read.
  let withClients = null
  try { withClients = await measureWithClients(server, parseInt(process.env.PORT, 10)) }
  catch (e) { console.warn(`[perf-gate] with-clients phase failed (idle result unaffected): ${e.message}`) }

  console.log('[perf-gate] shutting server down ...')
  server.stop()

  if (samples.length === 0) throw new Error('no tick samples captured -- the tick loop did not run during the measurement window')

  const sorted = samples.slice().sort((a, b) => a - b)
  const sum = samples.reduce((a, b) => a + b, 0)
  const avgMs = sum / samples.length
  const p50Ms = percentile(sorted, 0.5)
  const p95Ms = percentile(sorted, 0.95)
  const maxMs = sorted[sorted.length - 1]
  const tickBudgetMs = 1000 / tickSystem.tickRate

  return { avgMs, p50Ms, p95Ms, maxMs, sampleCount: samples.length, tickRate: tickSystem.tickRate, tickBudgetMs, dilationFactor, withClients }
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
  const wc = metrics.withClients
  if (wc) {
    console.log(`[perf-gate] with-clients(N=${wc.clients}, informational): tick avg=${wc.avgMs.toFixed(3)}ms p50=${wc.p50Ms.toFixed(3)}ms p95=${wc.p95Ms.toFixed(3)}ms max=${wc.maxMs.toFixed(3)}ms | onTick.getMetrics avgSnapMs=${wc.snapAvgMs.toFixed(3)}ms avgTotalMs=${wc.totalAvgMs.toFixed(3)}ms over ${wc.ticks} ticks | ${wc.packs} packs, ${wc.bytesPerPack.toFixed(1)} bytes/pack, ${wc.snapshotsReceived} snapshots received by clients`)
  }

  // Frame-budget headroom check, independent of the historical baseline: a tick loop already
  // dilating (dilationFactor < 1) or blowing its own tick budget on p95 is a hard fail regardless
  // of whether it regressed from a prior measurement -- this is the real-world consequence
  // (TickSystem's own overload control has kicked in) that a baseline-relative check alone would miss.
  if (metrics.dilationFactor < 1.0) {
    console.error(`[perf-gate] FAIL: tick loop is self-dilating (dilationFactor=${metrics.dilationFactor} < 1.0) -- server is overloaded at real tick rate`)
    process.exit(1)
  }
  if (metrics.p95Ms > metrics.tickBudgetMs) {
    console.error(`[perf-gate] FAIL: p95 tick time ${metrics.p95Ms.toFixed(3)}ms exceeds the ${metrics.tickBudgetMs.toFixed(3)}ms tick budget (${metrics.tickRate}Hz)`)
    process.exit(1)
  }

  if (UPDATE) {
    const base = { avgMs: metrics.avgMs, p50Ms: metrics.p50Ms, p95Ms: metrics.p95Ms, tickRate: metrics.tickRate }
    // Separate, informational field: the gate above compares only the idle p50, never this.
    if (wc) base.withClients = { clients: wc.clients, avgMs: wc.avgMs, p50Ms: wc.p50Ms, p95Ms: wc.p95Ms, avgSnapMs: wc.snapAvgMs, bytesPerPack: wc.bytesPerPack }
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
  // A purely RELATIVE threshold is unusable at this magnitude. The tick loop
  // measures ~0.07ms against a 15.625ms budget (under 0.5% utilization), so
  // +10% is ~7 MICROseconds -- comfortably inside run-to-run jitter and inside
  // the difference between this developer machine and a CI runner. Live
  // evidence: three consecutive local runs measured 0.082/0.078/0.079ms (a
  // 0.004ms spread, itself over half the entire "regression" allowance), and a
  // baseline captured locally still failed on CI hardware.
  //
  // So a move must clear BOTH bars to count: the relative one (it grew
  // meaningfully versus the recorded baseline) AND an absolute one (it is big
  // enough to matter at all against the frame budget). ABS_FLOOR_MS is
  // deliberately still ~1/78th of the 15.625ms budget -- a genuine regression
  // that eats real frame time blows through it easily, while microsecond
  // jitter on an essentially idle loop no longer reports a false alarm that
  // trains everyone to re-baseline on sight.
  const ABS_FLOOR_MS = 0.20
  const limit = baseMs * THRESHOLD
  const overRelative = metrics.p50Ms > limit
  const overAbsolute = metrics.p50Ms > ABS_FLOOR_MS
  console.log(`[perf-gate] baseline p50=${baseMs.toFixed(3)}ms limit=${limit.toFixed(3)}ms (+10%) measured p50=${metrics.p50Ms.toFixed(3)}ms abs_floor=${ABS_FLOOR_MS.toFixed(3)}ms budget=${metrics.tickBudgetMs.toFixed(3)}ms`)

  if (overRelative && overAbsolute) {
    console.error(`[perf-gate] REGRESSION: ${metrics.p50Ms.toFixed(3)}ms > ${limit.toFixed(3)}ms (${((metrics.p50Ms / baseMs - 1) * 100).toFixed(1)}% over baseline) AND over the ${ABS_FLOOR_MS}ms absolute floor`)
    process.exit(1)
  }
  if (overRelative) {
    console.log(`[perf-gate] relative threshold exceeded (${((metrics.p50Ms / baseMs - 1) * 100).toFixed(1)}% over baseline) but p50 ${metrics.p50Ms.toFixed(3)}ms is under the ${ABS_FLOOR_MS}ms absolute floor (${(100 * metrics.p50Ms / metrics.tickBudgetMs).toFixed(2)}% of budget) -- not a material regression`)
  }

  console.log('[perf-gate] PASS')
  process.exit(0)
}

main()
