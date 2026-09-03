#!/usr/bin/env node
// Real live-session verification: boots the real spoint server (src/sdk/server.js's
// createServer, the same code path server.js/boot() uses) on a random high port with a
// minimal inline world def, connects a real raw WebSocket client (the `ws` package, same
// as a browser client's PhysicsNetworkClient), sends a PLAYER_INPUT message, and confirms
// a valid MSG.SNAPSHOT round-trips with the expected decoded shape. Prints PASS/FAIL to
// stdout and exits 0/1 accordingly. Not a test file / no assertion framework -- a one-off
// operational script exercising the real server + real wire protocol end to end.
//
// Usage: node scripts/verify-session.mjs

import WebSocket from 'ws'
import { createServer } from '../src/sdk/server.js'
import { MSG, msgName } from '../src/protocol/MessageTypes.js'
import { pack, unpack, ensurePacked } from '../src/protocol/msgpack.js'
import { SnapshotEncoder } from '../src/netcode/SnapshotEncoder.js'

const PASS = []
const FAIL = []
function check(label, cond, detail) {
  if (cond) { PASS.push(label); console.log(`  [PASS] ${label}`) }
  else { FAIL.push(label); console.log(`  [FAIL] ${label}${detail ? ' -- ' + detail : ''}`) }
}

// Must mirror ConnectionManager.js's COALESCE_SENTINEL/frameCoalesced (server) and
// BaseClient.js's splitCoalesced (real client decode) exactly: ConnectionManager.flushAll
// folds every message queued for a client in one tick (e.g. HANDSHAKE_ACK + WORLD_DEF +
// APP_MODULE + initial SNAPSHOT, all queued synchronously in onClientConnect) into a SINGLE
// socket.send() prefixed with sentinel byte 0xFF, followed by repeated [uint32 LE
// length][payload] records. A raw unpack() of that frame throws ("end of buffer not
// reached") -- every real client (PhysicsNetworkClient/BrowserServer) splits first.
const COALESCE_SENTINEL = 0xff
const LEN_PREFIX_BYTES = 4
function splitCoalesced(bytes) {
  const out = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let off = 1
  while (off < bytes.length) {
    if (off + LEN_PREFIX_BYTES > bytes.length) break
    const len = view.getUint32(off, true); off += LEN_PREFIX_BYTES
    if (off + len > bytes.length) break
    out.push(bytes.subarray(off, off + len)); off += len
  }
  return out
}
// Decodes one raw WS frame into its constituent {type,payload} messages, transparently
// handling both the coalesced-multi-message and plain single-message wire shapes.
function decodeFrame(data) {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data
  if (bytes.length > 0 && bytes[0] === COALESCE_SENTINEL) {
    return splitCoalesced(bytes).map(part => unpack(part))
  }
  return [unpack(bytes)]
}

async function main() {
  await ensurePacked
  // Random high port avoids colliding with any real dev server already bound to 3000/8090
  // (see AGENTS.md one-server-two-client-modes-same-origin -- never hardcode a shared port
  // for a throwaway verification instance).
  const port = 20000 + Math.floor(Math.random() * 20000)

  // Minimal self-contained world: no terrain/entities/apps required, keeps boot fast and
  // makes this script runnable with zero external fixtures.
  const worldDef = {
    name: 'verify-session-world',
    tickRate: 30,
    spawnPoint: [0, 5, 0],
    entities: []
  }

  console.log(`[verify-session] booting real server on port ${port}...`)
  const server = await createServer({ port, tickRate: worldDef.tickRate, appsDirs: [], staticDirs: [] })
  await server.loadWorld(worldDef)
  const info = await server.start()
  console.log(`[verify-session] server up: port=${info.port} tickRate=${info.tickRate}`)

  let ws
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    ws.binaryType = 'arraybuffer'

    const received = []
    let handshake = null
    let firstSnapshot = null
    let inputAckedSnapshot = null

    const gotHandshake = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for HANDSHAKE_ACK')), 5000)
      ws.on('message', data => {
        let msgs
        try { msgs = decodeFrame(data) } catch (e) { return }
        for (const msg of msgs) {
          received.push(msg)
          if (msg.type === MSG.HANDSHAKE_ACK && !handshake) {
            handshake = msg.payload
            clearTimeout(timer)
            resolve(msg.payload)
          }
        }
      })
      ws.on('error', err => { clearTimeout(timer); reject(err) })
    })

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for WS open')), 5000)
      ws.on('open', () => { clearTimeout(timer); resolve() })
      ws.on('error', err => { clearTimeout(timer); reject(err) })
    })
    console.log('[verify-session] WebSocket open')

    const hs = await gotHandshake
    check('HANDSHAKE_ACK received with playerId', typeof hs?.playerId === 'string' || typeof hs?.playerId === 'number', `playerId=${JSON.stringify(hs?.playerId)}`)
    check('HANDSHAKE_ACK carries sessionToken', !!hs?.sessionToken)
    check('HANDSHAKE_ACK carries tickRate', typeof hs?.tickRate === 'number')
    const playerId = hs.playerId

    // Wait for the initial full SNAPSHOT (sent synchronously right after HANDSHAKE_ACK in
    // ServerHandlers.onClientConnect) to confirm the join produced real server-side state.
    firstSnapshot = received.find(m => m.type === MSG.SNAPSHOT)
    if (!firstSnapshot) {
      firstSnapshot = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for initial SNAPSHOT')), 5000)
        const onMsg = data => {
          let msgs
          try { msgs = decodeFrame(data) } catch (e) { return }
          for (const msg of msgs) {
            if (msg.type === MSG.SNAPSHOT) { clearTimeout(timer); ws.off('message', onMsg); resolve(msg); return }
          }
        }
        ws.on('message', onMsg)
      })
    }
    console.log(`[verify-session] initial SNAPSHOT: ${msgName(firstSnapshot.type)} seq=${firstSnapshot.payload?.seq}`)

    const decodedInitial = SnapshotEncoder.decode(firstSnapshot.payload)
    check('initial SNAPSHOT decodes with players array', Array.isArray(decodedInitial.players))
    check('initial SNAPSHOT includes the joined player', decodedInitial.players.some(p => p.id === playerId), `players=${JSON.stringify(decodedInitial.players.map(p => p.id))}`)
    const joinedPlayer = decodedInitial.players.find(p => p.id === playerId)
    check('joined player has a finite position', Array.isArray(joinedPlayer?.position) && joinedPlayer.position.every(Number.isFinite), JSON.stringify(joinedPlayer?.position))

    // Send a real move input (same envelope shape as PhysicsNetworkClient.sendInput).
    const inputSequence = 1
    const moveInput = { forward: 1, right: 0, jump: false, yaw: 0, pitch: 0 }
    ws.send(pack({ type: MSG.PLAYER_INPUT, payload: { input: moveInput, sequence: inputSequence } }))
    console.log('[verify-session] sent PLAYER_INPUT (forward move)')

    // Confirm at least one more SNAPSHOT arrives after the input (proves the tick loop is
    // alive and broadcasting, i.e. this is a live session, not a one-shot connect response).
    inputAckedSnapshot = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for post-input SNAPSHOT')), 5000)
      const onMsg = data => {
        let msgs
        try { msgs = decodeFrame(data) } catch (e) { return }
        for (const msg of msgs) {
          if (msg.type === MSG.SNAPSHOT && msg.payload?.seq !== firstSnapshot.payload?.seq) {
            clearTimeout(timer); ws.off('message', onMsg); resolve(msg); return
          }
        }
      }
      ws.on('message', onMsg)
    })
    console.log(`[verify-session] post-input SNAPSHOT: seq=${inputAckedSnapshot.payload?.seq} tick=${inputAckedSnapshot.payload?.tick}`)

    check('post-input SNAPSHOT has a newer seq than initial', inputAckedSnapshot.payload.seq > firstSnapshot.payload.seq, `${inputAckedSnapshot.payload.seq} > ${firstSnapshot.payload.seq}`)
    check('post-input SNAPSHOT has a tick number', typeof inputAckedSnapshot.payload.tick === 'number')
    const decodedFollowup = SnapshotEncoder.decode(inputAckedSnapshot.payload)
    check('post-input SNAPSHOT decodes with players array', Array.isArray(decodedFollowup.players))
    check('post-input SNAPSHOT still includes the joined player', decodedFollowup.players.some(p => p.id === playerId))

    ws.close()
  } finally {
    server.stop()
  }

  console.log(`\n[verify-session] ${PASS.length} passed, ${FAIL.length} failed`)
  if (FAIL.length) {
    console.log('[verify-session] RESULT: FAIL')
    process.exitCode = 1
  } else {
    console.log('[verify-session] RESULT: PASS')
    process.exitCode = 0
  }
}

main().catch(err => {
  console.error('[verify-session] RESULT: FAIL (uncaught error)')
  console.error(err?.stack || err)
  process.exitCode = 1
})
