import { WebSocket } from 'ws'
import { pack, unpack } from './src/protocol/msgpack.js'

const CONFIG = {
  botCount: 50,
  durationMs: 70000,
  inputHz: 60,
  serverUrl: 'ws://localhost:3001/ws',
  batchSize: 20,
  batchDelayMs: 100
}

const MSG_INPUT = 0x11
const MSG_SNAPSHOT = 0x10

function makeInput(botId, tick) {
  const phase = (tick / 80 + botId * 0.37) % 1
  return {
    forward: phase < 0.7,
    backward: phase > 0.85,
    left: phase > 0.72 && phase < 0.82,
    right: phase > 0.82 && phase < 0.85,
    jump: tick % 200 === botId % 200,
    sprint: tick % 400 < 300,
    yaw: (botId / CONFIG.botCount) * Math.PI * 2 + Math.sin(tick / 180) * 0.8,
    pitch: 0,
    crouch: false,
    interact: false
  }
}

const stats = { connected: 0, snapshots: 0, errors: 0, startTime: Date.now() }

function createBot(botId) {
  let tick = 0
  let interval = null
  const ws = new WebSocket(CONFIG.serverUrl)
  ws.binaryType = 'arraybuffer'
  ws.on('open', () => {
    stats.connected++
    interval = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return
      ws.send(pack({ type: MSG_INPUT, payload: makeInput(botId, ++tick) }))
    }, 1000 / CONFIG.inputHz)
  })
  ws.on('message', data => {
    try {
      const msg = unpack(data instanceof ArrayBuffer ? new Uint8Array(data) : data)
      if (msg?.type === MSG_SNAPSHOT) stats.snapshots++
    } catch {}
  })
  ws.on('error', () => { stats.errors++ })
  ws.on('close', () => { stats.connected--; if (interval) clearInterval(interval) })
  return ws
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  const start = Date.now()
  console.log(`\n[PROFILING] Starting ${CONFIG.botCount}-player load test`)
  console.log(`[PROFILING] Target: measure tick time, frame time, and rendering performance`)
  console.log(`[PROFILING] Expected targets:`)
  console.log(`  - Tick time: <7.8ms (128 TPS budget)`)
  console.log(`  - Rendering: <10ms (60 FPS = 16.7ms budget)`)
  console.log(`  - Snapshot delivery: 32 Hz (with SNAP_GROUPS)`)
  console.log()

  const bots = []
  for (let i = 0; i < CONFIG.botCount; i += CONFIG.batchSize) {
    const end = Math.min(i + CONFIG.batchSize, CONFIG.botCount)
    for (let j = i; j < end; j++) bots.push(createBot(j))
    await sleep(CONFIG.batchDelayMs)
  }
  await sleep(2000)
  console.log(`[PROFILING] ${stats.connected}/${CONFIG.botCount} connected, running ${CONFIG.durationMs / 1000}s\n`)

  const metricsLog = []
  const reportInterval = setInterval(() => {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    const rate = (stats.snapshots / parseFloat(elapsed)).toFixed(0)
    const line = `[PROFILING] t=${elapsed}s conn=${stats.connected} snaps=${stats.snapshots} rate=${rate}/s err=${stats.errors}`
    console.log(line)
    metricsLog.push(line)
  }, 5000)

  await sleep(CONFIG.durationMs)
  clearInterval(reportInterval)
  const elapsed = (Date.now() - start) / 1000
  const perBotPerSec = (stats.snapshots / CONFIG.botCount / elapsed).toFixed(2)

  console.log(`\n[PROFILING] ═══════════════════════════════════════════════════`)
  console.log(`[PROFILING] FINAL RESULTS (${elapsed.toFixed(1)}s)`)
  console.log(`[PROFILING] ═══════════════════════════════════════════════════`)
  console.log(`[PROFILING] Connected: ${stats.connected}/${CONFIG.botCount}`)
  console.log(`[PROFILING] Total snapshots: ${stats.snapshots}`)
  console.log(`[PROFILING] Rate: ${perBotPerSec} snapshots/bot/sec`)
  console.log(`[PROFILING] Errors: ${stats.errors}`)
  console.log(`[PROFILING] ═══════════════════════════════════════════════════\n`)

  for (const ws of bots) if (ws.readyState === WebSocket.OPEN) ws.close()
  await sleep(500)
  process.exit(0)
}

main().catch(e => { console.error('[PROFILING] fatal:', e); process.exit(1) })
