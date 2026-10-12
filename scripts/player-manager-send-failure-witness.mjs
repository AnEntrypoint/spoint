import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createNetServer } from 'node:net'

if (typeof globalThis.WebSocket !== 'function') {
  const { WebSocket } = await import('ws')
  globalThis.WebSocket = WebSocket
}

process.env.SPOINT_NO_WATCH = '1'
process.env.SPOINT_SKIP_PREWARM = '1'
if (!process.env.GM_PROFILE) process.env.GM_PROFILE = '1'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLAYERS = 3
const WORLD = 'tps-game'
const PULSE_COUNT = 8
const PULSE_INTERVAL_MS = 40
const DISCONNECT_OBSERVE_MS = 1200
const sleep = ms => new Promise(r => setTimeout(r, ms))

const failures = []
function check(name, got, predicate) {
  const ok = predicate(got)
  console.log(`RESULT ${name}=${JSON.stringify(got)} ${ok ? 'ok' : 'FAIL'}`)
  if (!ok) failures.push(name)
  return ok
}

const isPositive = got => typeof got === 'number' && Number.isFinite(got) && got > 0

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
  check('controlMessageHooks', out.clientMessageHooks, got => got === PLAYERS)

  const baselineFrames = frames
  let cap = captureConsoleError()
  const controlSend = pm.sendToPlayer(healthy.id, { type: 'witness-control', v: 1 })
  const controlBroadcast = pm.broadcast({ type: 'witness-control-broadcast', v: 1 })
  const controlLogs = cap.stop()
  await sleep(150)
  const controlFrames = frames - baselineFrames
  out.arms.control = {
    sendToPlayerReturn: controlSend === undefined ? 'undefined' : controlSend,
    broadcastReturn: controlBroadcast === undefined ? 'undefined' : (controlBroadcast && typeof controlBroadcast === 'object' ? controlBroadcast : String(controlBroadcast)),
    consoleErrorLines: controlLogs.length,
    clientFramesReceived: controlFrames
  }
  check('controlClientFramesNonZero', controlFrames, isPositive)
  check('controlClientFramesDelivered', controlFrames, got => got >= 2)
  check('controlSendToPlayerReturn', out.arms.control.sendToPlayerReturn, got => got === true)
  check('controlBroadcastDelivered', controlBroadcast && controlBroadcast.delivered, got => got === PLAYERS)
  check('controlConsoleErrorLines', controlLogs.length, got => got === 0)

  const unencodable = { type: 'witness-encode', flag: Symbol('witness-unencodable') }
  let packThrew = null
  try { pack(unencodable) } catch (e) { packThrew = e.message }
  out.arms.encodeFailure = { packThrew }
  check('encodePackThrew', packThrew, got => got !== null)

  cap = captureConsoleError()
  const encodeBefore = pm.sendFailures
  let encodeThrew = null
  let encodeReturn = 'undefined'
  try { const r = pm.sendToPlayer(victim.id, unencodable); encodeReturn = r === undefined ? 'undefined' : String(r) } catch (e) { encodeThrew = `${e.name}: ${e.message}` }
  const encodeLogs = cap.stop()
  const encodeNamedLogs = encodeLogs.filter(line => /player-manager/.test(line)).length
  const encodeSignalCount = (encodeThrew !== null ? 1 : 0) + encodeNamedLogs
  out.arms.encodeFailure.sendToPlayerThrew = encodeThrew
  out.arms.encodeFailure.sendToPlayerReturn = encodeReturn
  out.arms.encodeFailure.consoleErrorLines = encodeLogs.length
  out.arms.encodeFailure.namedLogLines = encodeNamedLogs
  out.arms.encodeFailure.signalCount = encodeSignalCount
  out.arms.encodeFailure.sendFailuresDelta = (pm.sendFailures || 0) - (encodeBefore || 0)
  check('encodeFailureSignalCount', encodeSignalCount, isPositive)
  check('encodeFailureReported', [encodeThrew, encodeNamedLogs], ([threw, named]) => threw !== null || named > 0)
  if (encodeThrew) check('encodeFailureNamesItself', encodeThrew, got => /encode-failed/.test(got))

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
  check('refusedVictimATransport', closedA, got => !!got && got.isOpen === false && got.directSend === false)

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
  check('refusedVictimBTransport', closedB, got => !!got && got.isOpen === false && got.directSend === false)
  const refusedVictimIds = [...new Set(
    [...(siteReturns.broadcast.failed || []), ...(siteReturns.broadcastBinary.failed || [])].map(f => f.playerId)
  )].sort((a, b) => a - b)
  const refusedDelta = (pm.sendFailures || 0) - (refusedBefore || 0)
  out.arms.transportRefused = {
    victimA: { playerId: victimA.id, transportType: victimA.socket.type, ...closedA },
    victimB: { playerId: victimB.id, transportType: victimB.socket.type, ...closedB },
    victimIdsNamed: refusedVictimIds,
    playerStillPresent: victimAStillPresent,
    playerStillConnected: victimAStillConnected,
    siteReturns,
    consoleErrorLines: refusedLogs.length,
    sendFailuresDelta: refusedDelta,
    logSample: refusedLogs.slice(0, 4)
  }
  check('refusedPlayerStillPresent', victimAStillPresent, got => got === true)
  check('refusedPlayerStillConnected', victimAStillConnected, got => got === true)
  check('refusedSendToPlayerReturn', String(siteReturns.sendToPlayer), got => got === 'false')
  check('refusedSendBinaryToPlayerReturn', String(siteReturns.sendBinaryToPlayer), got => got === 'false')
  check('refusedBroadcastNamesVictimA', siteReturns.broadcast, got => (got.failed || []).some(f => f.playerId === victimA.id && /not-open|refused/.test(f.reason)))
  check('refusedBroadcastBinaryNamesVictimB', siteReturns.broadcastBinary, got => (got.failed || []).some(f => f.playerId === victimB.id && /not-open|refused/.test(f.reason)))
  check('refusedVictimsNamed', refusedVictimIds, got => got.includes(victimA.id) && got.includes(victimB.id))
  check('refusedLogLines', refusedLogs.length, got => got >= 1)
  check('refusedLogNamesComponent', logged.slice(0, 200), got => /player-manager/.test(got))
  check('refusedLogNamesReason', logged.slice(0, 200), got => /peer-not-open/.test(got))
  check('refusedSendFailuresDelta', refusedDelta, got => got === 4)
  check('refusedSendFailuresMoved', refusedDelta, isPositive)
  check('refusedLogDeduplicated', refusedLogs.length, got => got <= 2)

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
    skipped: simBroadcast.skipped || 0,
    sendFailuresDelta: (pm.sendFailures || 0) - (simBefore || 0)
  }
  check('noTransportSkippedNonZero', out.arms.noTransport.skipped, isPositive)
  check('noTransportSkipped', out.arms.noTransport.skipped, got => got === 1)
  check('noTransportNoFailureLog', simLogs.length, got => got === 0)
  check('noTransportNotCountedAsFailure', out.arms.noTransport.sendFailuresDelta, got => got === 0)
  check('noTransportStillConnected', pm.getPlayer(simOnlyId).connected, got => got === true)

  cap = captureConsoleError()
  let unknownThrew = null
  let unknownSend = 'undefined'
  let unknownBinary = 'undefined'
  try { unknownSend = String(pm.sendToPlayer(987654, { type: 'witness-unknown' })) } catch (e) { unknownThrew = e.message }
  try { unknownBinary = String(pm.sendBinaryToPlayer(987654, binary)) } catch (e) { unknownThrew = e.message }
  const unknownLogs = cap.stop()
  out.arms.unknownPlayer = { sendToPlayerReturn: unknownSend, sendBinaryToPlayerReturn: unknownBinary, threw: unknownThrew, consoleErrorLines: unknownLogs.length }
  check('unknownPlayerDoesNotThrow', unknownThrew, got => got === null)
  check('unknownPlayerReportsNotDelivered', [unknownSend, unknownBinary], ([a, b]) => a === 'false' && b === 'false')

  const loggedBeforePrune = pm._loggedSendFailures.size
  pm.removePlayer(victimA.id)
  pm.removePlayer(victimB.id)
  pm.removePlayer(simOnlyId)
  const loggedAfterPrune = pm._loggedSendFailures.size
  out.arms.logPruning = { before: loggedBeforePrune, after: loggedAfterPrune }
  check('logPruningBeforeNonZero', loggedBeforePrune, isPositive)
  check('logPruningReleasesRecord', loggedAfterPrune, got => got === 0)

  const siteCalls = { broadcast: 0, broadcastBinary: 0, sendToPlayer: 0, sendBinaryToPlayer: 0 }
  const originals = {}
  for (const site of Object.keys(siteCalls)) {
    originals[site] = pm[site].bind(pm)
    pm[site] = (...args) => { siteCalls[site]++; return originals[site](...args) }
  }
  const disconnectBefore = pm.sendFailures
  const pulseTargets = () => pm.getConnectedPlayers().filter(p => p.socket && p.socket.isOpen !== false).map(p => p.id)
  let pulseSends = 0
  for (let i = 0; i < PULSE_COUNT; i++) {
    pm.broadcast({ type: 'witness-pulse', i })
    for (const id of pulseTargets()) { pm.sendToPlayer(id, { type: 'witness-pulse-direct', i }); pulseSends++ }
    await sleep(PULSE_INTERVAL_MS)
  }
  const preDisconnectFailures = (pm.sendFailures || 0) - (disconnectBefore || 0)
  clients[0].disconnect()
  await sleep(DISCONNECT_OBSERVE_MS)
  for (const site of Object.keys(siteCalls)) pm[site] = originals[site]
  const siteCallTotal = siteCalls.broadcast + siteCalls.broadcastBinary + siteCalls.sendToPlayer + siteCalls.sendBinaryToPlayer
  out.arms.normalDisconnect = {
    siteCalls: { ...siteCalls },
    siteCallTotal,
    pulseSends,
    preDisconnectFailures,
    sendFailuresDelta: (pm.sendFailures || 0) - (disconnectBefore || 0),
    playersLeft: pm.getPlayerCount()
  }
  check('disconnectSiteCallDenominator', siteCallTotal, isPositive)
  check('disconnectBroadcastCalls', siteCalls.broadcast, isPositive)
  check('disconnectSendToPlayerCalls', siteCalls.sendToPlayer, isPositive)
  check('disconnectPulsedSitesClean', preDisconnectFailures, got => got === 0)
  check('disconnectBinarySitesUnused', [siteCalls.broadcastBinary, siteCalls.sendBinaryToPlayer], ([a, b]) => a === 0 && b === 0)

  const measured = {
    players: players.length,
    refusedSites: 4,
    refusedCounted: refusedDelta,
    refusedLogLines: refusedLogs.length,
    skipped: out.arms.noTransport.skipped,
    pruneBefore: loggedBeforePrune,
    pruneAfter: loggedAfterPrune,
    siteCallTotal,
    encodeSignalCount,
    controlFrames
  }
  out.measured = measured
  for (const [key, value] of Object.entries(measured)) {
    if (key === 'pruneAfter') continue
    check(`measured${key[0].toUpperCase()}${key.slice(1)}NonZero`, value, isPositive)
  }
  check('measuredPruneAfterZero', measured.pruneAfter, got => got === 0)

  for (const c of clients) { try { c.disconnect?.() } catch {} }
  try { await server.stop?.() } catch {}
  return out
}

const out = await main()
console.log(JSON.stringify(out, null, 2))
console.log(`MEASURED player-manager-send-failure: ${out.measured.players} player(s), ${out.measured.refusedCounted} refused send(s) of ${out.measured.refusedSites} site(s), sendFailures +${out.measured.refusedCounted}, log line(s) ${out.measured.refusedLogLines}, skipped ${out.measured.skipped}, pruned ${out.measured.pruneBefore}->${out.measured.pruneAfter}, disconnect site call(s) ${out.measured.siteCallTotal}, encode signal(s) ${out.measured.encodeSignalCount}, control frame(s) ${out.measured.controlFrames}`)
if (failures.length) {
  for (const f of failures) console.log('FAIL: ' + f)
  console.log('RESULT: FAIL')
  process.exit(1)
}
console.log('RESULT: PASS')
process.exit(0)
