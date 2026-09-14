#!/usr/bin/env node
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
function decodeFrame(data) {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data
  if (bytes.length > 0 && bytes[0] === COALESCE_SENTINEL) {
    return splitCoalesced(bytes).map(part => unpack(part))
  }
  return [unpack(bytes)]
}

async function main() {
  await ensurePacked
  const port = 20000 + Math.floor(Math.random() * 20000)

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

    const inputSequence = 1
    const moveInput = { forward: 1, right: 0, jump: false, yaw: 0, pitch: 0 }
    ws.send(pack({ type: MSG.PLAYER_INPUT, payload: { input: moveInput, sequence: inputSequence } }))
    console.log('[verify-session] sent PLAYER_INPUT (forward move)')

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
