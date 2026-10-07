import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createNetServer } from 'node:net'

process.env.SPOINT_NO_WATCH = '1'
process.env.SPOINT_SKIP_PREWARM = '1'
if (!process.env.GM_PROFILE) process.env.GM_PROFILE = '1'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLAYERS = 3
const WORLD = 'tps-game'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const failures = []
function expect(cond, label) {
  if (cond) return true
  failures.push(label)
  return false
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createNetServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
  })
}

function captureConsoleError() {
  const original = console.error
  const lines = []
  console.error = (...parts) => { lines.push(parts.map(p => (p && p.stack) || String(p)).join(' ')) }
  return { lines, stop() { console.error = original; return lines.slice() } }
}

async function main() {
  const { createServer } = await import('../src/sdk/server.js')
  const { PhysicsNetworkClient } = await import('../src/client/PhysicsNetworkClient.js')
  const { loadWorldModule } = await import('../src/sdk/WorldLocator.js')
  const { pack, ensurePacked } = await import('../src/protocol/msgpack.js')
  await ensurePacked

  const port = await freePort()
  const worldDef = await loadWorldModule(resolve(SDK_ROOT, 'apps', 'world', WORLD + '.js'))
  worldDef.entities = (worldDef.entities || []).filter(e => e && e.app === 'terrain')
  worldDef.terrain = { ...(worldDef.terrain || {}), vegetation: null }
  worldDef.spawnPoint = [0, 5, 0]

  const server = await createServer({
    port,
    tickRate: worldDef.tickRate || 60,
    appsDirs: [resolve(SDK_ROOT, 'apps'), resolve(SDK_ROOT, 'src', 'stdlib-apps')],
    sdkRoot: SDK_ROOT,
    gravity: worldDef.gravity,
    staticDirs: [],
    storageDir: resolve(SDK_ROOT, 'data', 'player-manager-send-failure-witness')
  })
  await server.loadWorld(worldDef)
  await server.start()

  const pm = server.playerManager
  const url = `ws://127.0.0.1:${port}/ws`
  const clients = []
  for (let i = 0; i < PLAYERS; i++) {
    clients.push(new PhysicsNetworkClient({ url, predictionEnabled: false, smoothInterpolation: false, collisionMirror: false, webTransport: { enabled: false } }))
  }
  const connectFailures = []
  await Promise.all(clients.map(c => c.connect().catch(e => connectFailures.push(e))))
  if (connectFailures.length) {
    console.error(`[witness] ${connectFailures.length} of ${clients.length} client(s) failed to connect: ${connectFailures[0].name}: ${connectFailures[0].message}`)
    process.exit(1)
  }
  const deadline = Date.now() + 60000
  while (pm.getConnectedPlayers().length < PLAYERS && Date.now() < deadline) await sleep(50)
  const players = pm.getConnectedPlayers().slice().sort((a, b) => a.id - b.id)
  if (players.length < PLAYERS) { console.error(`[witness] only ${players.length} of ${PLAYERS} player(s) joined`); process.exit(1) }
  await sleep(300)

  const out = { players: players.map(p => p.id), arms: {} }

  const healthy = players[0]
  const victim = players[1]

  let frames = 0
  for (const c of clients) {
    const sock = c.ws
    if (!sock) continue
    const previous = sock.onmessage
    sock.onmessage = event => { frames++; if (typeof previous === 'function') previous.call(sock, event) }
  }
  out.clientMessageHooks = clients.filter(c => c.ws).length

  const baselineFrames = frames
  let cap = captureConsoleError()
  const controlSend = pm.sendToPlayer(healthy.id, { type: 'witness-control', v: 1 })
  const controlBroadcast = pm.broadcast({ type: 'witness-control-broadcast', v: 1 })
  const controlLogs = cap.stop()
  await sleep(150)
  out.arms.control = {
    sendToPlayerReturn: controlSend === undefined ? 'undefined' : controlSend,
    broadcastReturn: controlBroadcast === undefined ? 'undefined' : (controlBroadcast && typeof controlBroadcast === 'object' ? controlBroadcast : String(controlBroadcast)),
    consoleErrorLines: controlLogs.length,
    clientFramesReceived: frames - baselineFrames
  }
  expect((frames - baselineFrames) >= 2, `a healthy player receives the control sends: ${frames - baselineFrames} frames arrived`)

  const unencodable = { type: 'witness-encode', flag: Symbol('witness-unencodable') }
  let packThrew = null
  try { pack(unencodable) } catch (e) { packThrew = e.message }
  out.arms.encodeFailure = { packThrew }
  expect(packThrew !== null, `msgpack refuses the unencodable payload, so the runtime has a real encode failure to report: got ${packThrew}`)

  cap = captureConsoleError()
  const encodeBefore = pm.sendFailures
  let encodeThrew = null
  let encodeReturn = 'undefined'
  try { const r = pm.sendToPlayer(victim.id, unencodable); encodeReturn = r === undefined ? 'undefined' : String(r) } catch (e) { encodeThrew = `${e.name}: ${e.message}` }
  const encodeLogs = cap.stop()
  out.arms.encodeFailure.sendToPlayerThrew = encodeThrew
  out.arms.encodeFailure.sendToPlayerReturn = encodeReturn
  out.arms.encodeFailure.consoleErrorLines = encodeLogs.length
  out.arms.encodeFailure.sendFailuresDelta = (pm.sendFailures || 0) - (encodeBefore || 0)
  expect(
    encodeThrew !== null || (encodeLogs.length > 0 && /player-manager/.test(encodeLogs.join('\n'))),
    `an unencodable payload sent to one player is reported, not swallowed: threw=${encodeThrew} return=${encodeReturn} logs=${encodeLogs.length}`
  )
  if (encodeThrew) expect(/encode-failed/.test(encodeThrew), `the encode failure names itself: ${encodeThrew}`)

  const binary = pack({ type: 'witness-binary', v: 1 })
  const closeTransport = player => {
    const raw = player.socket && player.socket.socket
    if (!raw) return null
    raw.close()
    return { isOpen: player.socket.isOpen, readyState: raw.readyState, directSend: player.socket.send(pack({ type: 'witness-refused' })) }
  }

  const victimA = players[1]
  const victimB = players[2]
  const victimAStillPresent = !!pm.getPlayer(victimA.id)
  const victimAStillConnected = pm.getPlayer(victimA.id) ? pm.getPlayer(victimA.id).connected : null

  const closedA = closeTransport(victimA)
  expect(closedA && closedA.isOpen === false && closedA.directSend === false, `the half-closed transport of player ${victimA.id} reports not open and refuses the send: ${JSON.stringify(closedA)}`)

  cap = captureConsoleError()
  const refusedBefore = pm.sendFailures
  const siteReturns = {}
  try { siteReturns.broadcast = pm.broadcast({ type: 'witness-refused-broadcast' }) } catch (e) { siteReturns.broadcast = `threw ${e.message}` }
  const closedB = closeTransport(victimB)
  try { siteReturns.broadcastBinary = pm.broadcastBinary(binary) } catch (e) { siteReturns.broadcastBinary = `threw ${e.message}` }
  try { const r = pm.sendToPlayer(victimA.id, { type: 'witness-refused' }); siteReturns.sendToPlayer = r === undefined ? 'undefined' : String(r) } catch (e) { siteReturns.sendToPlayer = `threw ${e.message}` }
  try { const r = pm.sendBinaryToPlayer(victimB.id, binary); siteReturns.sendBinaryToPlayer = r === undefined ? 'undefined' : String(r) } catch (e) { siteReturns.sendBinaryToPlayer = `threw ${e.message}` }
  const refusedLogs = cap.stop()
  const logged = refusedLogs.join('\n')
  expect(closedB && closedB.isOpen === false && closedB.directSend === false, `the half-closed transport of player ${victimB.id} reports not open and refuses the send: ${JSON.stringify(closedB)}`)
  out.arms.transportRefused = {
    victimA: { playerId: victimA.id, transportType: victimA.socket.type, ...closedA },
    victimB: { playerId: victimB.id, transportType: victimB.socket.type, ...closedB },
    playerStillPresent: victimAStillPresent,
    playerStillConnected: victimAStillConnected,
    siteReturns,
    consoleErrorLines: refusedLogs.length,
    sendFailuresDelta: (pm.sendFailures || 0) - (refusedBefore || 0),
    logSample: refusedLogs.slice(0, 4)
  }
  expect(victimAStillPresent === true, `the player is still in the manager while its transport is closing: present=${victimAStillPresent}`)
  expect(victimAStillConnected === true, `the player is still marked connected at the moment its transport refuses: connected=${victimAStillConnected}`)
  expect(String(siteReturns.sendToPlayer) === 'false', `sendToPlayer reports the refused send as not delivered: returned ${siteReturns.sendToPlayer}`)
  expect(String(siteReturns.sendBinaryToPlayer) === 'false', `sendBinaryToPlayer reports the refused send as not delivered: returned ${siteReturns.sendBinaryToPlayer}`)
  expect((siteReturns.broadcast.failed || []).some(f => f.playerId === victimA.id && /not-open|refused/.test(f.reason)), `broadcast names player ${victimA.id} and a reason: ${JSON.stringify(siteReturns.broadcast)}`)
  expect((siteReturns.broadcastBinary.failed || []).some(f => f.playerId === victimB.id && /not-open|refused/.test(f.reason)), `broadcastBinary names player ${victimB.id} and a reason: ${JSON.stringify(siteReturns.broadcastBinary)}`)
  expect(refusedLogs.length >= 1, `the refused sends are logged: ${refusedLogs.length} console.error line(s)`)
  expect(/player-manager/.test(logged), `the refusal log names player-manager: ${logged.slice(0, 200)}`)
  expect(/peer-not-open/.test(logged), `the refusal log names the reason: ${logged.slice(0, 200)}`)
  expect((pm.sendFailures || 0) - (refusedBefore || 0) === 4, `every one of the four refused sends is counted: delta ${(pm.sendFailures || 0) - (refusedBefore || 0)}`)
  expect(refusedLogs.length <= 2, `the refusal is logged once per player, not once per send: ${refusedLogs.length} line(s) for 4 failures`)

  const simOnlyId = pm.addPlayer(null, { position: [0, 5, 0] })
  cap = captureConsoleError()
  const simBefore = pm.sendFailures
  const simBroadcast = pm.broadcast({ type: 'witness-sim-only' })
  const simSend = pm.sendToPlayer(simOnlyId, { type: 'witness-sim-only' })
  const simLogs = cap.stop()
  out.arms.noTransport = {
    playerId: simOnlyId,
    broadcastReturn: simBroadcast,
    sendToPlayerReturn: simSend === undefined ? 'undefined' : String(simSend),
    stillConnected: pm.getPlayer(simOnlyId).connected,
    consoleErrorLines: simLogs.length,
    sendFailuresDelta: (pm.sendFailures || 0) - (simBefore || 0)
  }
  expect((simBroadcast.skipped || 0) === 1, `a socketless player is counted as skipped, not as a delivery failure: ${JSON.stringify(simBroadcast)}`)
  expect(simLogs.length === 0, `a socketless player produces no failure log: ${simLogs.length} line(s)`)
  expect((pm.sendFailures || 0) - (simBefore || 0) === 0, `a socketless player is not counted as a send failure: delta ${(pm.sendFailures || 0) - (simBefore || 0)}`)
  expect(pm.getPlayer(simOnlyId).connected === true, `a socketless player is not dropped from the connected set: connected=${pm.getPlayer(simOnlyId).connected}`)

  cap = captureConsoleError()
  let unknownThrew = null
  let unknownSend = 'undefined'
  let unknownBinary = 'undefined'
  try { unknownSend = String(pm.sendToPlayer(987654, { type: 'witness-unknown' })) } catch (e) { unknownThrew = e.message }
  try { unknownBinary = String(pm.sendBinaryToPlayer(987654, binary)) } catch (e) { unknownThrew = e.message }
  const unknownLogs = cap.stop()
  out.arms.unknownPlayer = { sendToPlayerReturn: unknownSend, sendBinaryToPlayerReturn: unknownBinary, threw: unknownThrew, consoleErrorLines: unknownLogs.length }
  expect(unknownThrew === null, `sending to an unknown player id does not throw: ${unknownThrew}`)
  expect(unknownSend === 'false' && unknownBinary === 'false', `sending to an unknown player id reports not delivered: ${unknownSend} / ${unknownBinary}`)

  const loggedBeforePrune = pm._loggedSendFailures.size
  pm.removePlayer(victimA.id)
  pm.removePlayer(victimB.id)
  pm.removePlayer(simOnlyId)
  out.arms.logPruning = { before: loggedBeforePrune, after: pm._loggedSendFailures.size }
  expect(pm._loggedSendFailures.size === 0, `removing a player releases its failure-log record, so the record cannot grow without bound: ${loggedBeforePrune} -> ${pm._loggedSendFailures.size}`)

  const siteCalls = { broadcast: 0, broadcastBinary: 0, sendToPlayer: 0, sendBinaryToPlayer: 0 }
  const originals = {}
  for (const site of Object.keys(siteCalls)) {
    originals[site] = pm[site].bind(pm)
    pm[site] = (...args) => { siteCalls[site]++; return originals[site](...args) }
  }
  const disconnectBefore = pm.sendFailures
  clients[0].disconnect()
  await sleep(1200)
  for (const site of Object.keys(siteCalls)) pm[site] = originals[site]
  out.arms.normalDisconnect = {
    siteCalls: { ...siteCalls },
    sendFailuresDelta: (pm.sendFailures || 0) - (disconnectBefore || 0),
    playersLeft: pm.getPlayerCount()
  }
  expect(siteCalls.broadcastBinary === 0 && siteCalls.sendBinaryToPlayer === 0, `the binary send sites stay unused on a real server: broadcastBinary=${siteCalls.broadcastBinary} sendBinaryToPlayer=${siteCalls.sendBinaryToPlayer}`)

  for (const c of clients) { try { c.disconnect?.() } catch {} }
  try { await server.stop?.() } catch {}
  return out
}

const out = await main()
console.log(JSON.stringify(out, null, 2))
if (failures.length) {
  for (const f of failures) console.log('FAIL: ' + f)
  console.log('RESULT: FAIL')
  process.exit(1)
}
console.log('RESULT: PASS')
process.exit(0)
