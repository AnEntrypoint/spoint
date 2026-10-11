import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mutantName = (process.argv.find(arg => arg.startsWith('--mutant=')) || '').slice('--mutant='.length)
const HANDLERS_REL = path.join('src', 'sdk', 'ServerHandlers.js')
const MUTANTS = {
  'reject-open': {
    anchor: 'if (transport && transport.isOpen !== false) { try { transport.close() } catch {} }',
    replacement: 'if (transport && transport.isOpen !== false) { }',
  },
  'missing-module': { remove: true },
}
const PROBE_IDLE_MS = 10000
const GRACE_WAIT_MS = 400
const UNDECODABLE_FIRST_FRAME = new Uint8Array([0x91])

const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = function setTimeoutUnref(callback, ms, ...args) {
  const timer = realSetTimeout(callback, ms, ...args)
  if (timer && typeof timer.unref === 'function') timer.unref()
  return timer
}
const pause = ms => new Promise(resolve => realSetTimeout(resolve, ms))

const failures = []
let checks = 0
let codec = null

function check(label, condition) {
  checks += 1
  if (condition) {
    console.log(`ok ${label}`)
    return
  }
  failures.push(label)
  console.log(`FAIL ${label}`)
}

function decodeFrames(data) {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (bytes[0] !== 0xff) return [codec.unpack(bytes)]
  const messages = []
  let offset = 1
  while (offset < bytes.length) {
    const length = bytes.readUInt32LE(offset)
    offset += 4
    messages.push(codec.unpack(bytes.subarray(offset, offset + length)))
    offset += length
  }
  return messages
}

class FakeSocket extends EventEmitter {
  constructor(name) {
    super()
    this.name = name
    this.type = 'websocket'
    this.isOpen = true
    this.probeOnly = false
    this.log = []
  }
  send(data) {
    if (!this.isOpen) return false
    for (const message of decodeFrames(data)) this.log.push({ kind: 'frame', type: message.type, payload: message.payload })
    return true
  }
  sendUnreliable(data) {
    return this.send(data)
  }
  close() {
    if (!this.isOpen) return
    this.isOpen = false
    this.log.push({ kind: 'close' })
    this.emit('close')
  }
  deliver(type, payload) {
    this.emit('message', codec.pack({ type, payload }))
  }
  frames(type) {
    return this.log.filter(entry => entry.kind === 'frame' && (type === undefined || entry.type === type))
  }
  firstFrame(type) {
    return this.frames(type)[0]
  }
  clearFrames() {
    this.log = this.log.filter(entry => entry.kind !== 'frame')
  }
  closeIndex() {
    return this.log.findIndex(entry => entry.kind === 'close')
  }
  frameIndex(type) {
    return this.log.findIndex(entry => entry.kind === 'frame' && entry.type === type)
  }
}

function buildEnv(T, identity = {}) {
  const sessions = new T.SessionStore({ ttl: 600000 })
  const playerManager = new T.PlayerManager()
  const connections = new T.ConnectionManager({ heartbeatInterval: 600000, heartbeatTimeout: 1200000 })
  const appRuntime = {
    entities: new Map(),
    _appDefs: new Map(),
    _pendingTrimeshEntities: new Map(),
    _pendingTrimeshBuilds: new Map(),
    _physics: null,
    _physicsBodyToEntityId: new Map(),
    contexts: new Map(),
    broadcastMessage() {},
    getSnapshot: () => ({ entities: [] }),
    getSnapshotForPlayer: () => ({ entities: [] }),
    getSceneGraph: () => [],
    nearbyPlayerIds: () => [],
    fireInteract() {},
    fireEvent() {},
    resolveAssetPath: p => p,
  }
  const ctx = {
    tickSystem: { currentTick: 42, dilationFactor: 1 },
    playerManager,
    connections,
    sessions,
    appRuntime,
    emitter: new EventEmitter(),
    networkState: {
      addPlayer() {},
      removePlayer() {},
      getSnapshot: () => ({ tick: 42, timestamp: 0, players: [] }),
    },
    physicsIntegration: {
      addPlayerCollider() {},
      removePlayerCollider() {},
      setPlayerPosition() {},
      standingCentreY: y => y + 0.9,
      playerBodies: new Map(),
      physicsWorld: null,
      config: { capsuleRadius: 0.4 },
    },
    lagCompensator: { recordPlayerPosition() {}, clearPlayerHistory() {} },
    appLoader: { getClientModules: () => ({}), getClientModule: () => '' },
    inspector: { handleMessage: () => false, removeClient() {} },
    physics: {},
    tickRate: 30,
    snapshotSeq: 0,
    currentWorldDef: { name: 'witness-world', relevanceRadius: 0, player: {}, netcode: {}, identity, entities: [], trustedApps: [] },
    worldSpawnPoint: [0, 5, 0],
    worldSpawnPoints: [[0, 5, 0]],
    chartEpochLedger: null,
    serverTimeOfDay: null,
    serverWeather: null,
    placedModelStorage: null,
  }
  const { onClientConnect } = T.createConnectionHandlers(ctx)
  return { onClientConnect, sessions, playerManager, connections }
}

function joinByHeartbeat(env, socket) {
  env.onClientConnect(socket)
  socket.deliver(codec.MSG.HEARTBEAT, { timestamp: Date.now() })
  env.connections.flushAll()
  const handshake = socket.firstFrame(codec.MSG.HANDSHAKE_ACK)
  return handshake ? { playerId: handshake.payload.playerId, token: handshake.payload.sessionToken } : null
}

function sameJSON(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function randomToken() {
  return randomBytes(16).toString('hex')
}

async function heartbeatClaims() {
  const env = buildEnv(codec)
  const socket = new FakeSocket('heartbeat')
  const joined = joinByHeartbeat(env, socket)
  check('heartbeat.join-hands-out-session-token', joined !== null && joined.token.length >= 8)
  socket.clearFrames()
  const sentAt = Date.now() - 25
  socket.deliver(codec.MSG.HEARTBEAT, { timestamp: sentAt })
  const ack = socket.firstFrame(codec.MSG.HEARTBEAT_ACK)
  check('heartbeat.ack-echoes-timestamp', ack !== undefined && ack.payload.timestamp === sentAt)
  check('heartbeat.ack-carries-server-time', ack !== undefined && typeof ack.payload.serverTime === 'number')
  const client = env.connections.getClient(joined.playerId)
  check('heartbeat.round-trip-recorded-in-range', client !== undefined && client.rtt >= 0 && client.rtt <= 10000)
  socket.close()
}

async function unresolvableReconnectClaims() {
  const variants = [
    ['unknown-token', randomToken()],
    ['short-token', 'short'],
    ['missing-token', undefined],
  ]
  for (const [name, token] of variants) {
    const env = buildEnv(codec)
    const socket = new FakeSocket(name)
    env.onClientConnect(socket)
    socket.emit('message', codec.pack({ type: codec.MSG.RECONNECT, payload: token === undefined ? {} : { sessionToken: token } }))
    const reasons = socket.frames(codec.MSG.DISCONNECT_REASON)
    check(`reconnect-rejected.${name}.invalid-session-reason-sent`, reasons.length === 1 && reasons[0].payload.code === codec.DISCONNECT_REASONS.INVALID_SESSION)
    check(`reconnect-rejected.${name}.reason-flushed-before-close`, socket.frameIndex(codec.MSG.DISCONNECT_REASON) >= 0 && socket.closeIndex() > socket.frameIndex(codec.MSG.DISCONNECT_REASON))
    check(`reconnect-rejected.${name}.socket-closed`, socket.isOpen === false)
    check(`reconnect-rejected.${name}.no-reconnect-ack`, socket.frames(codec.MSG.RECONNECT_ACK).length === 0)
    check(`reconnect-rejected.${name}.no-player-left-behind`, env.playerManager.getPlayerCount() === 0)
  }
}

async function resumeChainClaims() {
  const env = buildEnv(codec)
  const first = new FakeSocket('first')
  const joinedFirst = joinByHeartbeat(env, first)
  const token = joinedFirst.token
  const originalPlayer = env.playerManager.getPlayer(joinedFirst.playerId)
  originalPlayer.state.position = [3.5, 7.25, -2]
  originalPlayer.state.health = 40
  first.close()
  check('resume-chain.drop-leaves-no-player', env.playerManager.getPlayerCount() === 0)
  check('resume-chain.session-survives-drop', env.sessions.get(token) !== null)

  const second = new FakeSocket('second')
  env.onClientConnect(second)
  second.emit('message', codec.pack({ type: codec.MSG.RECONNECT, payload: { sessionToken: token } }))
  env.connections.flushAll()
  const ackSecond = second.firstFrame(codec.MSG.RECONNECT_ACK)
  check('resume-chain.first-resume-acked', ackSecond !== undefined)
  check('resume-chain.ack-echoes-presented-token', ackSecond !== undefined && ackSecond.payload.sessionToken === token)
  check('resume-chain.ack-mints-fresh-player-id', ackSecond !== undefined && ackSecond.payload.playerId !== joinedFirst.playerId)
  check('resume-chain.ack-player-attached-to-resumed-socket', ackSecond !== undefined && env.connections.getClient(ackSecond.payload.playerId)?.transport === second)
  check('resume-chain.ack-position-restored', ackSecond !== undefined && sameJSON(ackSecond.payload.position, [3.5, 7.25, -2]))
  check('resume-chain.ack-health-restored', ackSecond !== undefined && ackSecond.payload.health === 40)
  check('resume-chain.original-player-removed', env.playerManager.getPlayer(joinedFirst.playerId) === undefined)
  check('resume-chain.one-live-player-after-first-resume', env.playerManager.getPlayerCount() === 1)
  check('resume-chain.state-recovery-sent', second.frames(codec.MSG.STATE_RECOVERY).length === 1)
  second.close()
  check('resume-chain.session-survives-second-drop', env.sessions.get(token) !== null)

  const third = new FakeSocket('third')
  env.onClientConnect(third)
  third.emit('message', codec.pack({ type: codec.MSG.RECONNECT, payload: { sessionToken: token } }))
  env.connections.flushAll()
  const ackThird = third.firstFrame(codec.MSG.RECONNECT_ACK)
  check('resume-chain.second-resume-acked', ackThird !== undefined && ackThird.payload.sessionToken === token)
  check('resume-chain.second-resume-position-restored', ackThird !== undefined && sameJSON(ackThird.payload.position, [3.5, 7.25, -2]))
  check('resume-chain.one-live-player-after-second-resume', env.playerManager.getPlayerCount() === 1)
  third.close()
}

async function supersedeAttachedClaims() {
  const env = buildEnv(codec)
  const original = new FakeSocket('original')
  const joinedOriginal = joinByHeartbeat(env, original)
  const token = joinedOriginal.token
  const takeover = new FakeSocket('takeover')
  env.onClientConnect(takeover)
  takeover.emit('message', codec.pack({ type: codec.MSG.RECONNECT, payload: { sessionToken: token } }))
  env.connections.flushAll()
  const ack = takeover.firstFrame(codec.MSG.RECONNECT_ACK)
  check('supersede.takeover-acked', ack !== undefined && ack.payload.sessionToken === token)
  check('supersede.original-player-removed', env.playerManager.getPlayer(joinedOriginal.playerId) === undefined)
  check('supersede.one-live-player', env.playerManager.getPlayerCount() === 1)
  check('supersede.takeover-owns-live-player', ack !== undefined && env.connections.getClient(ack.payload.playerId)?.transport === takeover)
  check('supersede.original-client-loses-session', env.connections.getClient(joinedOriginal.playerId)?.sessionToken === null)
  original.close()
  check('supersede.original-close-keeps-session-pinned', env.sessions.get(token)?.pinned === true)
  check('supersede.original-close-keeps-takeover-player', env.playerManager.getPlayerCount() === 1 && ack !== undefined && env.connections.getClient(ack.payload.playerId)?.transport === takeover)
  takeover.close()
}

async function secondResumeClaims() {
  const env = buildEnv(codec)
  const original = new FakeSocket('original')
  const joinedOriginal = joinByHeartbeat(env, original)
  const token = joinedOriginal.token
  original.close()
  const first = new FakeSocket('first-resume')
  env.onClientConnect(first)
  first.emit('message', codec.pack({ type: codec.MSG.RECONNECT, payload: { sessionToken: token } }))
  env.connections.flushAll()
  const firstAck = first.firstFrame(codec.MSG.RECONNECT_ACK)
  const firstPlayerId = firstAck !== undefined ? firstAck.payload.playerId : null
  check('second-resume.session-bound-to-attached-player', env.sessions.get(token)?.playerId === firstPlayerId)
  const second = new FakeSocket('second-resume')
  env.onClientConnect(second)
  second.emit('message', codec.pack({ type: codec.MSG.RECONNECT, payload: { sessionToken: token } }))
  env.connections.flushAll()
  check('second-resume.second-acked', second.firstFrame(codec.MSG.RECONNECT_ACK) !== undefined)
  check('second-resume.superseded-player-removed', env.playerManager.getPlayer(firstPlayerId) === undefined)
  check('second-resume.one-live-player-for-session', env.playerManager.getPlayerCount() === 1)
  console.log(`info second-resume session-playerId=${env.sessions.get(token)?.playerId} first-resume-playerId=${firstPlayerId} live-players=${env.playerManager.getPlayerCount()}`)
  first.close()
  check('second-resume.superseded-socket-close-keeps-session-pinned', env.sessions.get(token)?.pinned === true)
  second.close()
}

async function migrateAfterResumeClaims() {
  const env = buildEnv(codec)
  const original = new FakeSocket('migrate-after-resume-original')
  const joinedOriginal = joinByHeartbeat(env, original)
  const token = joinedOriginal.token
  original.close()
  const resumed = new FakeSocket('migrate-after-resume-resumed')
  env.onClientConnect(resumed)
  resumed.emit('message', codec.pack({ type: codec.MSG.RECONNECT, payload: { sessionToken: token } }))
  env.connections.flushAll()
  const resumeAck = resumed.firstFrame(codec.MSG.RECONNECT_ACK)
  const resumedPlayerId = resumeAck !== undefined ? resumeAck.payload.playerId : null
  const candidate = new FakeSocket('migrate-after-resume-candidate')
  env.onClientConnect(candidate)
  candidate.emit('message', codec.pack({ type: codec.MSG.MIGRATE, payload: { sessionToken: token } }))
  env.connections.flushAll()
  const migrateAck = candidate.firstFrame(codec.MSG.MIGRATE_ACK)
  check('migrate-after-resume.acked-ok', migrateAck !== undefined && migrateAck.payload.ok === true)
  check('migrate-after-resume.keeps-resumed-player-id', migrateAck !== undefined && migrateAck.payload.playerId === resumedPlayerId)
  check('migrate-after-resume.candidate-owns-resumed-client', env.connections.getClient(resumedPlayerId)?.transport === candidate)
  candidate.close()
  resumed.close()
}

async function migrateRefusalClaims() {
  const env = buildEnv(codec)
  const unknown = new FakeSocket('migrate-unknown')
  env.onClientConnect(unknown)
  unknown.emit('message', codec.pack({ type: codec.MSG.MIGRATE, payload: { sessionToken: randomToken() } }))
  const refusal = unknown.firstFrame(codec.MSG.MIGRATE_ACK)
  check('migrate-refused.unknown-token-acked-not-ok', refusal !== undefined && refusal.payload.ok === false)
  check('migrate-refused.unknown-token-socket-closed', unknown.isOpen === false)
  const short = new FakeSocket('migrate-short')
  env.onClientConnect(short)
  short.emit('message', codec.pack({ type: codec.MSG.MIGRATE, payload: { sessionToken: 'short' } }))
  check('migrate-refused.short-token-closed-silently', short.isOpen === false && short.frames(codec.MSG.MIGRATE_ACK).length === 0)
  check('migrate-refused.no-player-joined', env.playerManager.getPlayerCount() === 0)
}

async function migrateHandBackClaims() {
  const env = buildEnv(codec)
  const original = new FakeSocket('migrate-original')
  const joinedOriginal = joinByHeartbeat(env, original)
  const candidate = new FakeSocket('migrate-candidate')
  env.onClientConnect(candidate)
  candidate.emit('message', codec.pack({ type: codec.MSG.MIGRATE, payload: { sessionToken: joinedOriginal.token } }))
  env.connections.flushAll()
  const migrateAck = candidate.firstFrame(codec.MSG.MIGRATE_ACK)
  check('migrate.acked-ok', migrateAck !== undefined && migrateAck.payload.ok === true)
  check('migrate.keeps-player-id', migrateAck !== undefined && migrateAck.payload.playerId === joinedOriginal.playerId)
  check('migrate.old-socket-left-open', original.isOpen === true)
  check('migrate.candidate-owns-client', env.connections.getClient(joinedOriginal.playerId)?.transport === candidate)
  check('migrate.single-player-kept', env.playerManager.getPlayerCount() === 1 && env.playerManager.getPlayer(joinedOriginal.playerId) !== undefined)
  candidate.close()
  check('migrate.candidate-death-hands-back-to-old-socket', env.connections.getClient(joinedOriginal.playerId)?.transport === original)
  check('migrate.player-survives-hand-back', env.playerManager.getPlayerCount() === 1)
  original.close()
  check('migrate.original-close-removes-player', env.playerManager.getPlayerCount() === 0)
}

async function probeSocketClaims() {
  const env = buildEnv(codec)
  const probe = new FakeSocket('probe')
  probe.probeOnly = true
  env.onClientConnect(probe)
  probe.deliver(codec.MSG.HEARTBEAT, { timestamp: Date.now() })
  env.connections.flushAll()
  await pause(150)
  check('probe.never-joins-as-player', env.playerManager.getPlayerCount() === 0)
  check('probe.sends-nothing', probe.frames().length === 0)
  check('probe.open-before-idle-timeout', probe.isOpen === true)
  await pause(PROBE_IDLE_MS + 500)
  check('probe.closed-after-idle-timeout', probe.isOpen === false)
}

async function silentSocketClaims() {
  const env = buildEnv(codec)
  const silent = new FakeSocket('silent')
  env.onClientConnect(silent)
  check('silent.not-joined-before-grace', env.playerManager.getPlayerCount() === 0)
  await pause(GRACE_WAIT_MS)
  env.connections.flushAll()
  check('silent.joins-after-grace', env.playerManager.getPlayerCount() === 1)
  check('silent.handshake-delivered', silent.frames(codec.MSG.HANDSHAKE_ACK).length === 1)
  silent.close()
  check('silent.close-removes-player', env.playerManager.getPlayerCount() === 0)
}

async function undecodableAdmissionClaims() {
  const env = buildEnv(codec)
  const socket = new FakeSocket('undecodable')
  env.onClientConnect(socket)
  socket.emit('message', UNDECODABLE_FIRST_FRAME)
  env.connections.flushAll()
  check('undecodable.no-player-admitted', env.playerManager.getPlayerCount() === 0)
  check('undecodable.no-handshake-sent', socket.frames(codec.MSG.HANDSHAKE_ACK).length === 0)
  check('undecodable.socket-closed', socket.isOpen === false)
  await pause(GRACE_WAIT_MS)
  env.connections.flushAll()
  console.log(`info undecodable live-players-after-grace=${env.playerManager.getPlayerCount()}`)
  check('undecodable.grace-does-not-admit-either', env.playerManager.getPlayerCount() === 0)
}

async function authRequiredRefusalClaims() {
  const env = buildEnv(codec, { nostrAuth: { enabled: true, timeoutMs: 600000 } })
  const socket = new FakeSocket('auth-required')
  env.onClientConnect(socket)
  socket.deliver(codec.MSG.HEARTBEAT, { timestamp: Date.now() })
  env.connections.flushAll()
  const refusal = socket.frames(codec.MSG.NOSTR_AUTH_CHALLENGE).pop()
  check('auth-required.refusal-names-auth-required', refusal !== undefined && refusal.payload.error === 'auth required')
  check('auth-required.socket-closed', socket.isOpen === false)
  check('auth-required.no-player-admitted', env.playerManager.getPlayerCount() === 0)
}

async function editorGateClaims() {
  const saved = process.env.EDITOR_TOKEN
  try {
    delete process.env.EDITOR_TOKEN
    {
      const env = buildEnv(codec)
      const socket = new FakeSocket('editor-unset')
      joinByHeartbeat(env, socket)
      socket.clearFrames()
      socket.deliver(codec.MSG.SCENE_GRAPH, {})
      env.connections.flushAll()
      check('editor.unset-token-serves-editor-messages', socket.frames(codec.MSG.SCENE_GRAPH).length === 1)
      socket.close()
    }
    const token = randomToken()
    process.env.EDITOR_TOKEN = token
    const env = buildEnv(codec)
    const socket = new FakeSocket('editor-gated')
    joinByHeartbeat(env, socket)
    socket.clearFrames()
    socket.deliver(codec.MSG.SCENE_GRAPH, {})
    env.connections.flushAll()
    check('editor.unauthenticated-editor-message-dropped', socket.frames(codec.MSG.SCENE_GRAPH).length === 0)
    socket.deliver(codec.MSG.AUTH_EDITOR, { token: randomToken() })
    env.connections.flushAll()
    const refused = socket.frames(codec.MSG.AUTH_EDITOR_ACK).pop()
    check('editor.wrong-token-refused', refused !== undefined && refused.payload.ok === false)
    socket.clearFrames()
    socket.deliver(codec.MSG.SCENE_GRAPH, {})
    env.connections.flushAll()
    check('editor.refused-client-still-dropped', socket.frames(codec.MSG.SCENE_GRAPH).length === 0)
    socket.deliver(codec.MSG.AUTH_EDITOR, { token })
    env.connections.flushAll()
    const accepted = socket.frames(codec.MSG.AUTH_EDITOR_ACK).pop()
    check('editor.right-token-accepted', accepted !== undefined && accepted.payload.ok === true)
    socket.clearFrames()
    socket.deliver(codec.MSG.SCENE_GRAPH, {})
    env.connections.flushAll()
    check('editor.authenticated-editor-message-served', socket.frames(codec.MSG.SCENE_GRAPH).length === 1)
    socket.close()
  } finally {
    if (saved === undefined) delete process.env.EDITOR_TOKEN
    else process.env.EDITOR_TOKEN = saved
  }
}

async function loadTree(root) {
  const load = relative => import(pathToFileURL(path.join(root, relative)).href)
  const handlers = await load(HANDLERS_REL)
  const messageTypes = await load(path.join('src', 'protocol', 'MessageTypes.js'))
  const msgpack = await load(path.join('src', 'protocol', 'msgpack.js'))
  const connection = await load(path.join('src', 'connection', 'ConnectionManager.js'))
  const sessions = await load(path.join('src', 'connection', 'SessionStore.js'))
  const players = await load(path.join('src', 'netcode', 'PlayerManager.js'))
  return {
    MSG: messageTypes.MSG,
    DISCONNECT_REASONS: messageTypes.DISCONNECT_REASONS,
    pack: msgpack.pack,
    unpack: msgpack.unpack,
    createConnectionHandlers: handlers.createConnectionHandlers,
    ConnectionManager: connection.ConnectionManager,
    SessionStore: sessions.SessionStore,
    PlayerManager: players.PlayerManager,
  }
}

function copyBakeInputs(scratchRoot) {
  const bakeSource = fs.readFileSync(path.join(projectRoot, 'src', 'static', 'BakeCodeVersion.js'), 'utf8')
  const inputs = new Set([...bakeSource.matchAll(/'(\.\.\/\.\.\/(?:packages|scripts)\/[^']+)'/g)].map(match => match[1]))
  for (const relative of inputs) {
    const source = path.resolve(projectRoot, 'src', 'static', relative)
    const destination = path.resolve(scratchRoot, 'src', 'static', relative)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(source, destination)
  }
}

function scrubScratch(text, scratchRoot) {
  if (!scratchRoot) return String(text)
  return String(text).split(scratchRoot).join('<scratch>').split(scratchRoot.split(path.sep).join('/')).join('<scratch>')
}

function applyMutant(scratchRoot) {
  const spec = MUTANTS[mutantName]
  const target = path.join(scratchRoot, HANDLERS_REL)
  if (spec.remove) {
    fs.rmSync(target, { force: true })
    return
  }
  const source = fs.readFileSync(target, 'utf8')
  const occurrences = source.split(spec.anchor).length - 1
  if (occurrences !== 1) throw new Error(`mutant ${mutantName} anchor occurs ${occurrences} times`)
  fs.writeFileSync(target, source.replace(spec.anchor, spec.replacement))
}

const scenarios = [
  ['heartbeat', heartbeatClaims],
  ['unresolvable-reconnect', unresolvableReconnectClaims],
  ['resume-chain', resumeChainClaims],
  ['supersede-attached', supersedeAttachedClaims],
  ['second-resume', secondResumeClaims],
  ['migrate-after-resume', migrateAfterResumeClaims],
  ['migrate-refusal', migrateRefusalClaims],
  ['migrate-hand-back', migrateHandBackClaims],
  ['probe-socket', probeSocketClaims],
  ['silent-socket', silentSocketClaims],
  ['undecodable-admission', undecodableAdmissionClaims],
  ['auth-required-refusal', authRequiredRefusalClaims],
  ['editor-gate', editorGateClaims],
]

async function main() {
  if (mutantName && !MUTANTS[mutantName]) {
    console.log(`FAIL unknown-mutant ${mutantName}`)
    console.log('RESULT: FAIL')
    process.exitCode = 1
    return
  }
  console.log(`mode=${mutantName ? `mutant:${mutantName}` : 'honest'}`)
  let scratchRoot = null
  try {
    let treeRoot = projectRoot
    if (mutantName) {
      scratchRoot = path.join(projectRoot, '.gm', 'witness-out', `server-handlers-scratch-${process.pid}-${Date.now()}`)
      fs.cpSync(path.join(projectRoot, 'src'), path.join(scratchRoot, 'src'), { recursive: true })
      fs.copyFileSync(path.join(projectRoot, 'package.json'), path.join(scratchRoot, 'package.json'))
      copyBakeInputs(scratchRoot)
      applyMutant(scratchRoot)
      treeRoot = scratchRoot
    }
    let loaded = null
    try {
      loaded = await loadTree(treeRoot)
    } catch (error) {
      check('module-load', false)
      console.log(`module-load-error code=${error.code || error.name} detail=${scrubScratch(error.message, scratchRoot).slice(0, 240)}`)
    }
    if (loaded) {
      codec = loaded
      for (const [name, body] of scenarios) {
        try {
          await body()
        } catch (error) {
          check(`${name}.no-exception`, false)
          console.log(`exception-in ${name}: ${error && error.name}: ${error && error.message}`)
        }
      }
    }
  } finally {
    if (scratchRoot) fs.rmSync(scratchRoot, { recursive: true, force: true })
  }
  const pass = checks > 0 && failures.length === 0
  console.log(`checks=${checks} failures=${failures.length}`)
  if (failures.length) console.log(`failed=${failures.join(',')}`)
  console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL')
  process.exitCode = pass ? 0 : 1
}

await main()
