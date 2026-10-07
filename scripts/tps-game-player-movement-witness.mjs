import WebSocket from 'ws'
import { MSG } from '../src/protocol/MessageTypes.js'
import { pack, unpack, ensurePacked } from '../src/protocol/msgpack.js'
import { encodeInputPacket, DEFAULT_INPUT_SCHEMA } from '../src/protocol/InputCodec.js'

const COALESCE_SENTINEL = 0xff

function decodeFrame(data) {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, bytes.byteOffset, bytes.byteLength)
  if (!(bytes.length > 0 && bytes[0] === COALESCE_SENTINEL)) return [unpack(bytes)]
  const out = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let off = 1
  while (off + 4 <= bytes.length) {
    const len = view.getUint32(off, true)
    off += 4
    if (off + len > bytes.length) break
    out.push(unpack(bytes.subarray(off, off + len)))
    off += len
  }
  return out
}

const numberArg = (name, fallback) => {
  const raw = process.argv.find(a => a.startsWith(`--${name}=`))
  const value = Number(raw ? raw.slice(name.length + 3) : NaN)
  return Number.isFinite(value) ? value : fallback
}

const WORLD = process.env.WORLD || 'tps-game'
const HOLD_MS = numberArg('hold-ms', 8000)
const MIN_PATH_M = numberArg('min-path', 15)
const MIN_TICKS = numberArg('min-ticks', 300)
const PORT = 38000 + Math.floor(Math.random() * 1500)

process.env.WORLD = WORLD
process.env.PORT = String(PORT)
process.env.SPOINT_SKIP_PREWARM = '1'
process.env.SPOINT_NO_WATCH = '1'
process.env.EDITOR_TOKEN = process.env.EDITOR_TOKEN || 'witness-token'

await ensurePacked
const { boot } = await import('../src/sdk/server.js')
const server = await boot()
const playerManager = server.playerManager
const physicsWorld = server.physicsIntegration.physicsWorld
const sleep = ms => new Promise(r => setTimeout(r, ms))

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.binaryType = 'arraybuffer'
let playerId = null
let chartEpoch = 0
let sending = false
let inputSeq = 0
let held = {}

ws.on('message', d => {
  let msgs
  try { msgs = decodeFrame(d) } catch { return }
  for (const m of msgs) {
    if (m.type === MSG.HANDSHAKE_ACK && playerId == null) {
      playerId = m.payload.playerId
      chartEpoch = m.payload.chartEpoch || 0
      sending = true
    }
  }
})
await new Promise(r => ws.on('open', r))

const sendTimer = setInterval(() => {
  if (!sending) return
  inputSeq++
  ws.send(pack({
    type: MSG.PLAYER_INPUT,
    payload: encodeInputPacket(DEFAULT_INPUT_SCHEMA, [{ sequence: inputSeq, data: { ...held, yaw: 0, pitch: 0, expr: 0 } }], chartEpoch)
  }))
}, 1000 / 60)

await sleep(1500)
const player = playerManager.getPlayer(playerId)
if (!player) {
  console.error(`RESULT world=${WORLD} FAIL: no player after handshake`)
  clearInterval(sendTimer)
  try { ws.close() } catch {}
  try { server.stop() } catch {}
  process.exit(1)
}

const startPosition = [...player.state.position]
const startTick = server.tickSystem?.currentTick ?? 0
console.log(`spawn=${startPosition.map(n => n.toFixed(3)).join(',')} onGround=${player.state.onGround}`)

held = { forward: true }
let path = 0
let prev = startPosition
const deadline = Date.now() + HOLD_MS
while (Date.now() < deadline) {
  await sleep(250)
  const cur = [...playerManager.getPlayer(playerId).state.position]
  path += Math.hypot(cur[0] - prev[0], cur[1] - prev[1], cur[2] - prev[2])
  prev = cur
}
held = {}
await sleep(250)

const endPosition = [...playerManager.getPlayer(playerId).state.position]
const endTick = server.tickSystem?.currentTick ?? 0
const ticks = endTick - startTick
const stats = typeof physicsWorld.physicsStats === 'function' ? physicsWorld.physicsStats() : null
const charId = server.physicsIntegration.playerBodies.get(playerId)?.charId ?? null

console.log(`RESULT world=${WORLD} inputSteps=${inputSeq} ticks=${ticks} path=${path.toFixed(3)}m start=${startPosition.map(n => n.toFixed(3)).join(',')} end=${endPosition.map(n => n.toFixed(3)).join(',')}`)
console.log(`RESULT charId=${charId} physics=${JSON.stringify(stats)}`)

const failures = []
if (!(path >= MIN_PATH_M)) failures.push(`path ${path.toFixed(3)}m < ${MIN_PATH_M}m`)
if (!(ticks >= MIN_TICKS)) failures.push(`ticks ${ticks} < ${MIN_TICKS}`)
if (!(charId != null)) failures.push('player has no character in the physics world')

clearInterval(sendTimer)
try { ws.close() } catch {}
try { server.stop() } catch {}
await sleep(200)

if (failures.length > 0) {
  console.error(`RESULT world=${WORLD} FAIL: ${failures.join('; ')}`)
  process.exit(1)
}
console.log(`RESULT world=${WORLD} PASS: walked ${path.toFixed(3)}m over ${inputSeq} input step(s) and ${ticks} tick(s)`)
process.exit(0)
