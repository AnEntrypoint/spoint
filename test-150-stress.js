#!/usr/bin/env node
import { WebSocket } from 'ws'
import { pack, unpack } from './src/protocol/msgpack.js'

const CONFIG = {
  botCount: parseInt(process.env.BOT_COUNT || '150'),
  durationMs: parseInt(process.env.BOT_DURATION || '120000'),
  inputHz: parseInt(process.env.BOT_HZ || '60'),
  serverUrl: process.env.BOT_URL || 'ws://localhost:3001/ws',
  batchSize: parseInt(process.env.BOT_BATCH || '30'),
  batchDelayMs: parseInt(process.env.BOT_DELAY || '50')
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

const stats = { connected: 0, snapshots: 0, errors: 0 }

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
  console.log(`[BotHarness-150] Connecting ${CONFIG.botCount} bots → ${CONFIG.serverUrl}`)
  const bots = []
  for (let i = 0; i < CONFIG.botCount; i += CONFIG.batchSize) {
    const end = Math.min(i + CONFIG.batchSize, CONFIG.botCount)
    for (let j = i; j < end; j++) bots.push(createBot(j))
    await sleep(CONFIG.batchDelayMs)
  }
  await sleep(2000)
  console.log(`[BotHarness-150] ${stats.connected}/${CONFIG.botCount} connected, running ${CONFIG.durationMs / 1000}s`)

  const reportInterval = setInterval(() => {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    const rate = (stats.snapshots / parseFloat(elapsed)).toFixed(0)
    console.log(`[BotHarness-150] t=${elapsed}s conn=${stats.connected} snaps=${stats.snapshots} (${rate}/s) err=${stats.errors}`)
  }, 5000)

  await sleep(CONFIG.durationMs)
  clearInterval(reportInterval)
  const elapsed = (Date.now() - start) / 1000
  const perBotPerSec = (stats.snapshots / CONFIG.botCount / elapsed).toFixed(2)

  console.log(`\n[BotHarness-150] ── FINAL ──`)
  console.log(`[BotHarness-150] Duration: ${elapsed.toFixed(1)}s | Connected: ${stats.connected}/${CONFIG.botCount}`)
  console.log(`[BotHarness-150] Snapshots: ${stats.snapshots} total | ${perBotPerSec}/bot/sec | Errors: ${stats.errors}`)
  console.log(`[BotHarness-150] Snapshot rate: ${(stats.snapshots / elapsed).toFixed(0)} snaps/sec`)

  for (const ws of bots) if (ws.readyState === WebSocket.OPEN) ws.close()
  await sleep(500)
  process.exit(0)
}

main().catch(e => { console.error('[BotHarness-150] fatal:', e); process.exit(1) })
