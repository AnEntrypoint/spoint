import { register } from 'node:module'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODULE_PATH = process.argv[2] ? resolve(process.argv[2]) : join(REPO_ROOT, 'src/sharding/RegionWorkerEntry.js')
const SETTLE_BUDGET_MS = 15000
const WATCHDOG_MS = 90000
const POLL_MS = 10

const STUB_SERVER_SOURCE = `
const calls = globalThis.__regionWorkerEntryStub = {
  createServerDeps: [], loadAll: 0, watchAll: 0, onTick: 0, start: 0, stageLoads: [],
  addPlayer: [], onClientConnect: [], transports: [], transportFrames: [],
  reset() {
    this.createServerDeps = []; this.loadAll = 0; this.watchAll = 0; this.onTick = 0; this.start = 0; this.stageLoads = []
    this.addPlayer = []; this.onClientConnect = []; this.transports = []; this.transportFrames = []
  }
}
export async function createServerDeps(config, tickRate) {
  calls.createServerDeps.push({ port: config.port, tickRate })
  const tickSystem = { currentTick: 0, onTick() { calls.onTick++ }, start() { calls.start++ } }
  const appLoader = { loadAll: async () => { calls.loadAll++ }, watchAll() { calls.watchAll++ }, getClientModules: () => ({}) }
  const stageLoader = {
    loadFromDefinition(name, def) {
      const entities = def.entities || []
      if (entities.some(e => e.model !== undefined && typeof e.model !== 'string')) {
        const err = new TypeError('stub stage loader: entity model must be a string')
        err.code = 'ERR_STUB_STAGE'
        throw err
      }
      calls.stageLoads.push({ name, ids: entities.map(e => e.id ?? null) })
    }
  }
  return {
    tickSystem, appLoader, stageLoader,
    appRuntime: { entities: new Map() },
    playerManager: {
      players: new Map(),
      getPlayerCount: () => 0, getConnectedPlayers: () => [], getPlayer: () => null,
      addPlayer(transport, options) {
        calls.addPlayer.push({ routerPlayerId: transport?.routerPlayerId ?? null, options })
        return calls.addPlayer.length
      }
    },
    connections: { flushAll() {}, send() {}, broadcast() {}, addClient() {}, getClient: () => null },
    networkState: { addPlayer() {}, removePlayer() {}, getSnapshot: () => ({ tick: 0, timestamp: 0, players: [] }) },
    physicsIntegration: { addPlayerCollider() {}, removePlayerCollider() {}, setPlayerPosition() {} },
    lagCompensator: { clearPlayerHistory() {} },
    sessions: { create: () => 'stub-session' }
  }
}
export function wireServerHandlers(ctx) {
  ctx.onClientConnect = (transport) => {
    calls.onClientConnect.push(transport?.routerPlayerId ?? null)
    calls.transports.push(transport)
    transport.on('message', buf => calls.transportFrames.push(buf.toString()))
    setTimeout(() => { ctx.playerManager.addPlayer(transport, { position: [0, 5, 0] }) }, 0)
  }
}
export function buildStaticDirs() { return [] }
export async function createServer() { throw new Error('stub createServer is not used by this witness') }
`

const STUB_SERVER_URL = 'data:text/javascript,' + encodeURIComponent(STUB_SERVER_SOURCE)
const HOOK_SOURCE = `
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context)
  if (resolved.url.endsWith('/src/sdk/server.js')) return { url: ${JSON.stringify(STUB_SERVER_URL)}, shortCircuit: true, format: 'module' }
  return resolved
}
`
register('data:text/javascript,' + encodeURIComponent(HOOK_SOURCE), import.meta.url)

const sent = []
const flushCallbacks = []
process.send = (message, ...rest) => {
  sent.push(message)
  flushCallbacks.push(typeof rest[0] === 'function' ? rest[0] : null)
  return true
}

const log = console.log
const realConsoleError = console.error
const consoleErrors = []
const checks = []
let finished = false

function expect(label, got, want) {
  const ok = isDeepStrictEqual(got, want)
  checks.push({ label, ok })
  log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`)
}

const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms))

async function settle(predicate) {
  const deadline = Date.now() + SETTLE_BUDGET_MS
  while (!predicate() && Date.now() < deadline) await sleep(POLL_MS)
  return predicate()
}

function stub() {
  return globalThis.__regionWorkerEntryStub
}

function finish() {
  if (finished) return
  finished = true
  clearTimeout(watchdog)
  const failed = checks.filter(c => !c.ok)
  const verdict = failed.length === 0 ? 'PASS' : 'FAIL'
  process.stdout.write(`RESULT: ${verdict} (${checks.length - failed.length}/${checks.length})\n`, () => process.exit(failed.length === 0 ? 0 : 1))
}

const watchdog = setTimeout(() => {
  checks.push({ label: 'watchdog', ok: false })
  log(`FAIL watchdog: witness did not finish within ${WATCHDOG_MS} ms`)
  finish()
}, WATCHDOG_MS)

function worldWithThrowingGravity(error) {
  return { get gravity() { throw error } }
}

async function refusalChecks() {
  const gravityError = Object.assign(new RangeError('stub gravity refused'), { code: 'ERR_STUB_GRAVITY' })
  const beforeGravity = sent.length
  process.emit('message', { type: 'INIT', region: 'r-bad', worldDef: worldWithThrowingGravity(gravityError) })
  await settle(() => sent.length > beforeGravity)
  expect('refusal: one reply to the refused INIT', sent.length - beforeGravity, 1)
  expect('refusal: WORKER_REFUSED carries region, error class, string code and message', sent[beforeGravity], { type: 'WORKER_REFUSED', region: 'r-bad', name: 'RangeError', code: 'ERR_STUB_GRAVITY', error: 'stub gravity refused' })
  expect('refusal: the reply is sent with a flush callback', typeof flushCallbacks[beforeGravity], 'function')
  const exitCodes = []
  const realExit = process.exit
  process.exit = code => { exitCodes.push(code) }
  try {
    flushCallbacks[beforeGravity]?.()
  } finally {
    process.exit = realExit
  }
  expect('refusal: the flush callback exits the worker with code 1', exitCodes, [1])
  expect('refusal: the worker logs a boot-refused line naming its region', consoleErrors.some(args => String(args[0]).startsWith('[region-worker r-bad] boot refused:')), true)

  const beforeNumeric = sent.length
  const numericError = Object.assign(new Error('stub numeric code'), { code: 42 })
  process.emit('message', { type: 'INIT', region: 'r-num', worldDef: worldWithThrowingGravity(numericError) })
  await settle(() => sent.length > beforeNumeric)
  expect('refusal: a non-string error code is reported as null', sent[beforeNumeric], { type: 'WORKER_REFUSED', region: 'r-num', name: 'Error', code: null, error: 'stub numeric code' })

  const beforeStage = sent.length
  process.emit('message', { type: 'INIT', region: '2,0', worldDef: { entities: [{ id: 'bad-model', position: [1100, 0, 100], model: 7 }] } })
  await settle(() => sent.length > beforeStage)
  expect('refusal: a stage-loader refusal is reported with its code and message', sent[beforeStage], { type: 'WORKER_REFUSED', region: '2,0', name: 'TypeError', code: 'ERR_STUB_STAGE', error: 'stub stage loader: entity model must be a string' })
}

async function readyChecks() {
  stub().reset()
  const beforeReady = sent.length
  const world = {
    tickRate: 30,
    entities: [
      { id: 'inside', position: [100, 0, 100] },
      { id: 'ghost-edge-max', position: [544, 0, 100] },
      { id: 'ghost-edge-min', position: [-32, 0, -32] },
      { id: 'outside-east', position: [545, 0, 100] },
      { id: 'outside-west', position: [-33, 0, 100] },
      { id: 'no-position' }
    ]
  }
  process.emit('message', { type: 'INIT', region: '0,0', worldDef: world })
  await settle(() => sent.length > beforeReady)
  expect('ready: exactly one WORKER_READY for region 0,0 carrying this pid', sent.slice(beforeReady), [{ type: 'WORKER_READY', region: '0,0', pid: process.pid }])
  expect('ready: the server is built once, with the world tick rate and port 0', stub().createServerDeps, [{ port: 0, tickRate: 30 }])
  expect('ready: stage main loads only entities inside the ghost-expanded region', stub().stageLoads, [{ name: 'main', ids: ['inside', 'ghost-edge-max', 'ghost-edge-min', 'no-position'] }])
  expect('ready: apps load, tick handler registers and starts, app watchers arm, once each', [stub().loadAll, stub().onTick, stub().start, stub().watchAll], [1, 1, 1, 1])
  const beforeStats = sent.length
  process.emit('message', { type: 'STATS_REQUEST', requestId: 42 })
  expect('ready: STATS_REQUEST replies with the region stats', sent[beforeStats], { type: 'STATS', region: '0,0', requestId: 42, players: 0, entities: 0, tick: 0 })
}

async function connectChecks() {
  stub().reset()
  const before = sent.length
  process.emit('message', { type: 'CLIENT_CONNECT', routerPlayerId: 'router-1', requestId: 5 })
  expect('connect: the region stays silent until it has minted an id', sent.length - before, 0)
  expect('connect: the joining transport reaches the server under its router id', stub().onClientConnect, ['router-1'])
  process.emit('message', { type: 'CLIENT_FRAME', routerPlayerId: 'router-1', dataB64: Buffer.from('hello').toString('base64') })
  expect('connect: a frame arriving before the id is minted still reaches the transport', stub().transportFrames, ['hello'])
  const answered = await settle(() => sent.length > before)
  expect('connect: the region answers the connect request once the id is minted', answered, true)
  expect('connect: CLIENT_CONNECTED carries the request id and the minted local id', sent[before], { type: 'CLIENT_CONNECTED', region: '0,0', requestId: 5, localPlayerId: 1 })
  expect('connect: the id is minted through the player manager, not guessed', stub().addPlayer, [{ routerPlayerId: 'router-1', options: { position: [0, 5, 0] } }])
  process.emit('message', { type: 'CLIENT_DISCONNECT', routerPlayerId: 'router-1' })
  expect('connect: a disconnect closes the transport it was handed', stub().transports[0].ready, false)
}

async function main() {
  await import(pathToFileURL(MODULE_PATH).href)
  expect('boot: WORKER_BOOTING with this pid is the only message on import', sent, [{ type: 'WORKER_BOOTING', pid: process.pid }])
  const beforePreInit = sent.length
  process.emit('message', { type: 'STATS_REQUEST', requestId: 1 })
  process.emit('message', { type: 'CLIENT_CONNECT', routerPlayerId: 'pre-init', requestId: 2 })
  expect('pre-INIT: STATS_REQUEST and CLIENT_CONNECT get no reply', sent.length - beforePreInit, 0)
  console.error = (...args) => { consoleErrors.push(args) }
  try {
    await refusalChecks()
  } finally {
    console.error = realConsoleError
  }
  await readyChecks()
  await connectChecks()
}

main().then(finish, error => {
  checks.push({ label: 'harness error', ok: false })
  log(`FAIL harness error: ${error?.stack || error}`)
  finish()
})
