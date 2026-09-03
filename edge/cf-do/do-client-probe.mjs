// Real end-to-end witness for edge-cf-durable-object-transport-adapter-real-websocketpair: a real
// Node `ws` client connecting to the real Durable Object (running under `wrangler dev` local-edge-
// runtime emulation), speaking the real msgpackr wire protocol, proving (1) a real client connects,
// (2) receives a real SNAPSHOT, (3) sends real PLAYER_INPUT that (4) moves a real Jolt-simulated
// player position -- round-tripped through the actual DO, not a mock.
import WebSocket from 'ws'
import { unpack, pack, ensurePacked } from '../../src/protocol/msgpack.js'
import { MSG } from '../../src/protocol/MessageTypes.js'
import { unpackBinRecord } from '../../src/netcode/SnapshotEncoder.js'

const PORT = process.argv[2] || '18802'
const url = `ws://127.0.0.1:${PORT}/`

function unpackFrame(data) {
  const buf = data instanceof Buffer ? new Uint8Array(data) : data
  // ConnectionManager's coalescing-frame format: sentinel 0xFF + repeated [u32 LE len][payload].
  if (buf[0] === 0xff) {
    const out = []
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    let off = 1
    while (off < buf.length) {
      const len = view.getUint32(off, true); off += 4
      out.push(unpack(buf.subarray(off, off + len))); off += len
    }
    return out
  }
  return [unpack(buf)]
}

async function main() {
  await ensurePacked
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'

  let playerId = null
  let firstSnapshotPos = null
  let lastSnapshotPos = null
  let snapshotCount = 0
  const log = []

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('connect timeout')), 10000)
    ws.on('open', () => { clearTimeout(timeout); log.push('WebSocket OPEN'); resolve() })
    ws.on('error', (e) => { clearTimeout(timeout); reject(e) })
  })

  ws.on('message', (data) => {
    let msgs
    try { msgs = unpackFrame(new Uint8Array(data)) } catch (e) { log.push('DECODE ERROR: ' + e.message); return }
    for (const msg of msgs) {
      if (msg.type === MSG.HANDSHAKE_ACK) {
        playerId = msg.payload?.playerId
        log.push('HANDSHAKE_ACK playerId=' + playerId)
      } else if (msg.type === MSG.SNAPSHOT) {
        snapshotCount++
        // Real wire shape (SnapshotEncoder.js's encodePlayer): a compact array record, not a plain
        // object -- [id, 23-byte packed bin record (position/velocity/rotation/scale/flags),
        // onGround, health, inputSequence, crouch, pitchYaw, expr, weapon]. Decode via the SAME
        // unpackBinRecord the real client uses (client/core/SnapshotProcessor.js's own decode path).
        const players = msg.payload?.players || []
        const rec = players.find(p => Array.isArray(p) && p[0] === playerId) || players[0]
        if (Array.isArray(rec) && rec[1]) {
          const bin = rec[1] instanceof Uint8Array ? rec[1] : new Uint8Array(rec[1])
          const out = {}
          unpackBinRecord(bin, out)
          const pos = [out.px, out.py, out.pz]
          if (!firstSnapshotPos) firstSnapshotPos = pos
          lastSnapshotPos = pos
        }
        if (snapshotCount <= 3 || snapshotCount % 20 === 0) log.push(`SNAPSHOT #${snapshotCount} players=${players.length} rec=${JSON.stringify(rec ? [rec[0], '<bin>', ...rec.slice(2)] : null)}`)
      }
    }
  })

  // No explicit HANDSHAKE needed -- ServerHandlers.js's onClientConnect auto-joins after a short grace
  // window if the client sends nothing first (real client behavior: wait for HANDSHAKE_ACK).
  await new Promise(r => setTimeout(r, 500))
  log.push('post-connect grace window elapsed, playerId=' + playerId)

  // Wait for a first real snapshot with a real position before sending input.
  const waitStart = Date.now()
  while (!firstSnapshotPos && Date.now() - waitStart < 5000) await new Promise(r => setTimeout(r, 100))
  if (!firstSnapshotPos) throw new Error('never received a snapshot with a player position')
  log.push('first real snapshot position: ' + JSON.stringify(firstSnapshotPos))

  // Real PLAYER_INPUT: forward movement, sustained for real wall-clock time so the real Jolt-simulated
  // character actually accumulates real displacement (not a single-tick nudge).
  let seq = 1, sendErrors = 0
  const inputInterval = setInterval(() => {
    try {
      const buf = pack({ type: MSG.PLAYER_INPUT, payload: { input: { forward: true, yaw: 0, pitch: 0 }, sequence: seq++ } })
      ws.send(buf)
    } catch (e) { sendErrors++; if (sendErrors <= 3) log.push('SEND ERROR: ' + e.message) }
  }, 1000 / 60)

  await new Promise(r => setTimeout(r, 2000))
  clearInterval(inputInterval)

  // Let a few more snapshots land reflecting the final position.
  await new Promise(r => setTimeout(r, 300))

  ws.close()
  await new Promise(r => setTimeout(r, 200))

  const dz = lastSnapshotPos ? (lastSnapshotPos[2] - firstSnapshotPos[2]) : null
  const dx = lastSnapshotPos ? (lastSnapshotPos[0] - firstSnapshotPos[0]) : null
  const moved = Math.hypot(dx || 0, dz || 0)

  const result = {
    ok: !!(playerId != null && snapshotCount > 0 && firstSnapshotPos && lastSnapshotPos && moved > 0.05),
    playerId, snapshotCount, firstSnapshotPos, lastSnapshotPos, moved, log
  }
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}

main().catch(e => { console.error(JSON.stringify({ ok: false, error: e.message, stack: String(e.stack) }, null, 2)); process.exit(1) })
