#!/usr/bin/env node
import WebSocket from 'ws'
import { createServer } from '../src/sdk/server.js'
import { MSG } from '../src/protocol/MessageTypes.js'
import { pack, unpack, ensurePacked } from '../src/protocol/msgpack.js'
import { SnapshotEncoder } from '../src/netcode/SnapshotEncoder.js'

const COALESCE_SENTINEL = 0xff
const LEN_PREFIX_BYTES = 4
const HEARTBEAT_MS = 400

const PASS = []
const FAIL = []
function check(label, cond, detail) {
  if (cond) { PASS.push(label); console.log(`  [PASS] ${label}`) }
  else { FAIL.push(label); console.log(`  [FAIL] ${label}${detail ? ' -- ' + detail : ''}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

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
  if (bytes.length > 0 && bytes[0] === COALESCE_SENTINEL) return splitCoalesced(bytes).map(part => unpack(part))
  return [unpack(bytes)]
}

async function makeClient(url, label) {
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  const client = { label, ws, msgs: [], joins: [], leaves: [], closedByServer: false, handshake: null }
  ws.on('message', data => {
    let msgs
    try { msgs = decodeFrame(data) } catch (e) { return }
    for (const m of msgs) {
      client.msgs.push(m)
      if (m.type === MSG.HANDSHAKE_ACK && !client.handshake) client.handshake = m.payload
      if (m.type === MSG.RECONNECT_ACK) client.handshake = client.handshake || m.payload
      if (m.type === MSG.PLAYER_JOIN) client.joins.push(m.payload?.playerId)
      if (m.type === MSG.PLAYER_LEAVE) client.leaves.push(m.payload?.playerId)
    }
  })
  ws.on('close', () => { client.closedByServer = true })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: timeout waiting for ws open`)), 5000)
    ws.once('open', () => { clearTimeout(timer); resolve() })
    ws.once('error', e => { clearTimeout(timer); reject(e) })
  })
  client.hb = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(pack({ type: MSG.HEARTBEAT, payload: { timestamp: Date.now() } }))
  }, HEARTBEAT_MS)
  return client
}

async function waitFor(client, predicate, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const hit = client.msgs.find(predicate)
    if (hit) return hit
    await sleep(50)
  }
  return null
}

function closeClient(c) {
  clearInterval(c.hb)
  try { c.ws.close() } catch (e) {}
}

async function serverState(port) {
  const res = await fetch(`http://127.0.0.1:${port}/debug/server`)
  return res.json()
}

function snapshotIds(client) {
  const snap = [...client.msgs].reverse().find(m => m.type === MSG.SNAPSHOT)
  if (!snap) return null
  try {
    const d = SnapshotEncoder.decode(snap.payload)
    return Array.isArray(d.players) ? d.players.map(p => p.id) : null
  } catch (e) { return null }
}

async function main() {
  await ensurePacked
  const port = 20000 + Math.floor(Math.random() * 20000)
  const worldDef = { name: 'transport-churn-world', tickRate: 30, spawnPoint: [0, 5, 0], entities: [] }
  console.log(`[transport-churn] booting real server on port ${port} ...`)
  const server = await createServer({ port, tickRate: worldDef.tickRate, appsDirs: [], staticDirs: [] })
  await server.loadWorld(worldDef)
  await server.start()
  const url = `ws://127.0.0.1:${port}/ws`
  const open = []

  try {
    console.log('[transport-churn] arm A: migrate to a new socket, then close the old one')
    const a = await makeClient(url, 'a'); open.push(a)
    const hsA = await waitFor(a, m => m.type === MSG.HANDSHAKE_ACK, 5000)
    const idA = hsA?.payload?.playerId
    const tokenA = hsA?.payload?.sessionToken
    check('arm A: first socket handshakes with a player id', idA != null, JSON.stringify(hsA?.payload?.playerId))
    check('arm A: first socket handshakes with a session token', typeof tokenA === 'string' && tokenA.length >= 8)

    const observer = await makeClient(url, 'observer'); open.push(observer)
    await waitFor(observer, m => m.type === MSG.HANDSHAKE_ACK, 5000)
    await sleep(500)
    const beforeMigrate = await serverState(port)

    const b = await makeClient(url, 'b'); open.push(b)
    b.ws.send(pack({ type: MSG.MIGRATE, payload: { sessionToken: tokenA } }))
    const ack = await waitFor(b, m => m.type === MSG.MIGRATE_ACK, 5000)
    check('arm A: MIGRATE is accepted', !!ack?.payload?.ok, JSON.stringify(ack?.payload))

    closeClient(a)
    await sleep(2000)
    const afterMigrate = await serverState(port)

    console.log(`[transport-churn] arm A counts: players before=${beforeMigrate.players} after=${afterMigrate.players} connections=${JSON.stringify(afterMigrate.connections.clients.map(c => c.id))} joins=${JSON.stringify(observer.joins)} leaves=${JSON.stringify(observer.leaves)}`)
    check('arm A: room keeps every player across a migration', afterMigrate.players === beforeMigrate.players, `before=${beforeMigrate.players} after=${afterMigrate.players} connections=${JSON.stringify(afterMigrate.connections.clients.map(c => c.id))}`)
    check('arm A: no player leave is announced for the migrated player', !observer.leaves.includes(idA), `leaves=${JSON.stringify(observer.leaves)}`)
    const extraJoins = observer.joins.filter(id => id !== idA)
    check('arm A: migration spawns no extra player on the new socket', extraJoins.length === 0, `joins=${JSON.stringify(observer.joins)}`)
    const idsAfterMigrate = snapshotIds(observer)
    check('arm A: migrated player survives in the snapshot after the old socket closes', Array.isArray(idsAfterMigrate) && idsAfterMigrate.includes(idA), `ids=${JSON.stringify(idsAfterMigrate)}`)

    console.log('[transport-churn] arm B: reconnect with a valid session token')
    const c = await makeClient(url, 'c'); open.push(c)
    const hsC = await waitFor(c, m => m.type === MSG.HANDSHAKE_ACK, 5000)
    const idC = hsC?.payload?.playerId
    const tokenC = hsC?.payload?.sessionToken
    closeClient(c)
    await sleep(500)
    const d = await makeClient(url, 'd'); open.push(d)
    d.ws.send(pack({ type: MSG.RECONNECT, payload: { sessionToken: tokenC } }))
    const rack = await waitFor(d, m => m.type === MSG.RECONNECT_ACK, 5000)
    check('arm B: RECONNECT with a live token is acked', !!rack, `leaves=${JSON.stringify(observer.leaves)}`)
    const reconnectedId = rack?.payload?.playerId
    await sleep(500)
    const idsAfterReconnect = snapshotIds(observer)
    check('arm B: reconnected client is in the snapshot under the acked id', reconnectedId != null && Array.isArray(idsAfterReconnect) && idsAfterReconnect.includes(reconnectedId), `acked=${JSON.stringify(reconnectedId)} ids=${JSON.stringify(idsAfterReconnect)}`)
    check('arm B: the pre-reconnect player id is gone', Array.isArray(idsAfterReconnect) && !idsAfterReconnect.includes(idC), `old=${JSON.stringify(idC)} ids=${JSON.stringify(idsAfterReconnect)}`)

    console.log('[transport-churn] arm C: reconnect with a token the server does not know')
    const beforeBogus = await serverState(port)
    const e = await makeClient(url, 'e'); open.push(e)
    e.ws.send(pack({ type: MSG.RECONNECT, payload: { sessionToken: 'deadbeefdeadbeefcafe' } }))
    const reason = await waitFor(e, m => m.type === MSG.DISCONNECT_REASON, 3000)
    check('arm C: unknown token is refused with DISCONNECT_REASON', !!reason?.payload, `msgs=${JSON.stringify(e.msgs.map(m => m.type))}`)
    await sleep(1200)
    const afterBogus = await serverState(port)
    check('arm C: server closes a socket whose session it refused', e.closedByServer === true, `closed=${e.closedByServer} connections=${JSON.stringify(afterBogus.connections.clients.map(c => c.id))}`)
    check('arm C: a refused reconnect leaves no orphan player', afterBogus.players === beforeBogus.players, `before=${beforeBogus.players} after=${afterBogus.players}`)
    check('arm C: a refused reconnect leaves no orphan connection', !afterBogus.connections.clients.some(c => c.id === e.handshake?.playerId), `refused=${JSON.stringify(e.handshake?.playerId)} ids=${JSON.stringify(afterBogus.connections.clients.map(c => c.id))}`)
    check('arm C: refusal is announced to the room as a leave', observer.leaves.includes(e.handshake?.playerId), `leaves=${JSON.stringify(observer.leaves)}`)

    console.log('[transport-churn] arm E: migrate with a token the server does not know')
    const beforeBadMigrate = await serverState(port)
    const g = await makeClient(url, 'g'); open.push(g)
    const hsG = await waitFor(g, m => m.type === MSG.HANDSHAKE_ACK, 5000)
    const idG = hsG?.payload?.playerId
    await sleep(500)
    const h = await makeClient(url, 'h'); open.push(h)
    h.ws.send(pack({ type: MSG.MIGRATE, payload: { sessionToken: 'deadbeefdeadbeefcafe' } }))
    const badAck = await waitFor(h, m => m.type === MSG.MIGRATE_ACK, 3000)
    check('arm E: MIGRATE with an unknown token is refused', !badAck || badAck.payload?.ok === false, JSON.stringify(badAck?.payload))
    await sleep(1200)
    const afterBadMigrate = await serverState(port)
    check('arm E: a refused migration creates no player', afterBadMigrate.players === beforeBadMigrate.players + 1, `before=${beforeBadMigrate.players} after=${afterBadMigrate.players}`)
    check('arm E: a refused migration closes the candidate socket', h.closedByServer === true, `closed=${h.closedByServer}`)
    check('arm E: the original client keeps its player and connection', afterBadMigrate.connections.clients.some(c => c.id === idG), `id=${JSON.stringify(idG)} ids=${JSON.stringify(afterBadMigrate.connections.clients.map(c => c.id))}`)

    console.log('[transport-churn] arm D: a client refused for a dead token can still join fresh')
    const f = await makeClient(url, 'f'); open.push(f)
    const hsF = await waitFor(f, m => m.type === MSG.HANDSHAKE_ACK, 5000)
    check('arm D: a silent socket still gets a player', hsF?.payload?.playerId != null, JSON.stringify(hsF?.payload?.playerId))
    await sleep(500)
    const idsAfterFresh = snapshotIds(observer)
    check('arm D: the fresh player is in the snapshot', Array.isArray(idsAfterFresh) && idsAfterFresh.includes(hsF?.payload?.playerId), `ids=${JSON.stringify(idsAfterFresh)}`)
  } finally {
    for (const c of open) closeClient(c)
    await server.stop()
  }

  console.log(`\n[transport-churn] ${PASS.length} passed, ${FAIL.length} failed`)
  if (FAIL.length) { console.log('[transport-churn] RESULT: FAIL'); process.exitCode = 1 }
  else { console.log('[transport-churn] RESULT: PASS'); process.exitCode = 0 }
}

main().catch(err => {
  console.error('[transport-churn] RESULT: FAIL (uncaught error)')
  console.error(err?.stack || err)
  process.exitCode = 1
})
