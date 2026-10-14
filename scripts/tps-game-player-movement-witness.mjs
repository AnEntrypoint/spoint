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
const HOLD_CEILING_MS = numberArg('hold-ceiling-ms', 60000)
const MIN_PATH_M = numberArg('min-path', 15)
const MIN_TICKS = numberArg('min-ticks', 300)
// A joining socket becomes a player on the server's own schedule, and on a loaded host that is
// seconds, not the 1500 ms this witness used to assume: the wait has to be for the join, with a
// ceiling, so a slow box cannot be reported as a player that never arrived.
const JOIN_WAIT_MS = numberArg('join-wait-ms', 30000)
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
const wsOpenedAt = Date.now()

const sendTimer = setInterval(() => {
  if (!sending) return
  inputSeq++
  ws.send(pack({
    type: MSG.PLAYER_INPUT,
    payload: encodeInputPacket(DEFAULT_INPUT_SCHEMA, [{ sequence: inputSeq, data: { ...held, yaw: 0, pitch: 0, expr: 0 } }], chartEpoch)
  }))
}, 1000 / 60)

const joinDeadline = Date.now() + JOIN_WAIT_MS
let player = null
while (Date.now() < joinDeadline) {
  if (playerId != null) player = playerManager.getPlayer(playerId)
  if (player) break
  await sleep(100)
}
if (!player) {
  console.error(`RESULT: FAIL: world=${WORLD} no player within ${JOIN_WAIT_MS} ms of the handshake`)
  clearInterval(sendTimer)
  try { ws.close() } catch {}
  try { server.stop() } catch {}
  process.exit(1)
}
console.log(`joined ${Date.now() - wsOpenedAt} ms after the socket opened`)

const startPosition = [...player.state.position]
const startTick = server.tickSystem?.currentTick ?? 0
console.log(`spawn=${startPosition.map(n => n.toFixed(3)).join(',')} onGround=${player.state.onGround}`)

held = { forward: true }
let path = 0
let prev = startPosition
// The hold runs until the SERVER has ticked MIN_TICKS time(s), with a wall-clock ceiling. A
// wall-clock hold measures the host's tick throughput instead of the walk: on a starved box the
// server ran 40 tick(s) in 8 s, the player walked 1.094 m and the witness reported a movement
// defect that was not there. The floors are unchanged -- MIN_PATH_M of ground in MIN_TICKS of
// server time -- so a player that does not translate still fails here, and a server that does not
// tick at all hits the ceiling and fails on the tick count.
const ceiling = Date.now() + HOLD_CEILING_MS
while (Date.now() < ceiling) {
  await sleep(250)
  const cur = [...playerManager.getPlayer(playerId).state.position]
  path += Math.hypot(cur[0] - prev[0], cur[1] - prev[1], cur[2] - prev[2])
  prev = cur
  if ((server.tickSystem?.currentTick ?? 0) - startTick >= MIN_TICKS) break
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
  console.error(`RESULT: FAIL: world=${WORLD} ${failures.join('; ')}`)
  process.exit(1)
}
console.log(`RESULT: PASS: walked ${path.toFixed(3)}m over ${inputSeq} input step(s) and ${ticks} tick(s) in world=${WORLD}`)
process.exit(0)
