#!/usr/bin/env node
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODULE_PATH = process.argv[2] ? resolve(process.argv[2]) : join(REPO_ROOT, 'src/sharding/RegionRouter.js')
const WATCHDOG_MS = 60000

const { RegionRouter, playerIdentity, handoffTo, parseRouterPlayerId, parseLocalPlayerId, parseSessionToken,
  ROUTER_PLAYER_ID_MALFORMED, LOCAL_PLAYER_ID_MALFORMED, SESSION_TOKEN_MALFORMED } = await import(pathToFileURL(MODULE_PATH).href)

const GRID_PATH = join(REPO_ROOT, 'src/sharding/RegionGrid.js')
const { regionIdFor, REGION_COORDS_NOT_FINITE, REGION_CELL_SIZE_NOT_POSITIVE } =
  await import(pathToFileURL(GRID_PATH).href)

const TOK = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const TOK2 = '0123456789abcdef0123456789abcdef'
const TOK3 = 'fedcba9876543210fedcba9876543210'

const checks = []
let finished = false

function expect(label, got, want) {
  const ok = isDeepStrictEqual(got, want)
  checks.push({ label, ok })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}\n`)
}

function finish() {
  if (finished) return
  finished = true
  clearTimeout(watchdog)
  const failed = checks.filter(c => !c.ok)
  process.stdout.write(`RESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${checks.length - failed.length}/${checks.length})\n`, () => process.exit(failed.length === 0 ? 0 : 1))
}

const watchdog = setTimeout(() => {
  checks.push({ label: 'watchdog', ok: false })
  process.stdout.write(`FAIL watchdog: witness did not finish within ${WATCHDOG_MS} ms\n`)
  finish()
}, WATCHDOG_MS)

function fakeSocket() {
  return {
    readyState: 1, received: [], handlers: {},
    on(event, fn) { this.handlers[event] = fn },
    send(buf) { this.received.push(buf.toString()) },
    close() { this.readyState = 3 },
  }
}

function stubWorker(router, regionId, localIds) {
  const worker = {
    ready: true, region: regionId, pid: process.pid, received: [], frames: [],
    proc: {
      send(msg) {
        worker.received.push(msg)
        if (msg.type === 'CLIENT_CONNECT') {
          const localId = localIds.length ? localIds.shift() : undefined
          const reply = { type: 'CLIENT_CONNECTED', region: regionId, requestId: msg.requestId }
          if (localId !== undefined) reply.localPlayerId = localId
          setImmediate(() => router._handleWorkerMessage(regionId, reply))
          return
        }
        if (msg.type === 'CLIENT_FRAME') {
          worker.frames.push({ routerPlayerId: msg.routerPlayerId, data: Buffer.from(msg.dataB64, 'base64').toString() })
          setImmediate(() => router._handleWorkerMessage(regionId, { type: 'WORKER_FRAME', routerPlayerId: msg.routerPlayerId, dataB64: msg.dataB64 }))
        }
      },
      kill() {},
    },
  }
  router.workers.set(regionId, worker)
  return worker
}

function frameFrom(socket, payload) {
  socket.handlers.message(Buffer.from(payload))
}

function refusedLines(fn) {
  const real = console.error
  const lines = []
  console.error = (...args) => { lines.push(args.map(a => String(a)).join(' ')) }
  try { fn() } finally { console.error = real }
  return lines
}

function identityOf(router, routerId) {
  const p = router.players.get(routerId)
  return p ? { region: p.region, localPlayerId: p.localPlayerId, handoff: p.handoff } : null
}

async function typeChecks() {
  expect('type: an identity with a null local id is not a value', playerIdentity('0,0', null), null)
  expect('type: an identity with an undefined local id is not a value', playerIdentity('0,0', undefined), null)
  expect('type: an identity with a malformed region is not a value', playerIdentity('north', 7), null)
  expect('type: a non-null pair is an identity', playerIdentity('0,0', 7), { region: '0,0', localPlayerId: 7 })
  expect('type: a handoff to a malformed region is not a value', handoffTo('north', '0,0', 7), null)
  expect('type: a handoff from a malformed region is not a value', handoffTo('1,0', 'south', 7), null)
  expect('type: a handoff with no local id is not a value', handoffTo('1,0', '0,0', null), null)
  expect('type: a handoff with all three present is a value', handoffTo('1,0', '0,0', 7), { toRegion: '1,0', fromRegion: '0,0', fromLocalId: 7 })
  expect('type: a router id is a positive integer', parseRouterPlayerId(3), { ok: true, routerPlayerId: 3 })
  expect('type: a router id is not zero, negative, fractional, or a string', [parseRouterPlayerId(0).ok, parseRouterPlayerId(-1).ok, parseRouterPlayerId(1.5).ok, parseRouterPlayerId('1').ok], [false, false, false, false])
  expect('type: a malformed router id names its own refusal', parseRouterPlayerId(null).reason, ROUTER_PLAYER_ID_MALFORMED)
  expect('type: a local id is a non-negative integer and is not a router id by another name', [parseLocalPlayerId(0).ok, parseLocalPlayerId(7).ok, parseLocalPlayerId(-1).ok, parseLocalPlayerId('7').ok], [true, true, false, false])
  expect('type: a malformed local id names its own refusal', parseLocalPlayerId(undefined).reason, LOCAL_PLAYER_ID_MALFORMED)
  expect('type: an absent session token is the null token', parseSessionToken(null), { ok: true, sessionToken: null })
  expect('type: a session token is 32 lowercase hex, not a bare word or a region id', [parseSessionToken(TOK).ok, parseSessionToken('tok').ok, parseSessionToken('0,0').ok, parseSessionToken(7).ok], [true, false, false, false])
  expect('type: a malformed session token names its own refusal', parseSessionToken('tok').reason, SESSION_TOKEN_MALFORMED)
}

async function twoClientsOneRegion() {
  const router = new RegionRouter({ worldDef: { spawnPoint: [10, 5, 10] }, port: 0 })
  const worker = stubWorker(router, '0,0', [7, 9])
  const sockA = fakeSocket()
  const sockB = fakeSocket()
  const idA = await router._onSocketConnect(sockA, [10, 5, 10])
  const idB = await router._onSocketConnect(sockB, [10, 5, 10])
  expect('two clients in one region: both are admitted', [idA, idB, router.players.size], [1, 2, 2])
  expect('two clients in one region: each carries its own non-null identity', [identityOf(router, 1).localPlayerId, identityOf(router, 2).localPlayerId], [7, 9])
  frameFrom(sockA, 'frame-a')
  frameFrom(sockB, 'frame-b')
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
  expect('two clients in one region: each frame reaches the worker under its own router id', worker.frames, [{ routerPlayerId: 1, data: 'frame-a' }, { routerPlayerId: 2, data: 'frame-b' }])
  expect('two clients in one region: each frame lands on its own socket', [sockA.received, sockB.received], [['frame-a'], ['frame-b']])
  frameFrom(sockB, 'frame-b2')
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
  expect('two clients in one region: the frame from B lands on B only', [sockA.received, sockB.received], [['frame-a'], ['frame-b', 'frame-b2']])
  const before = [sockA.received.length, sockB.received.length]
  const strayLines = refusedLines(() => router._handleWorkerMessage('0,0', { type: 'WORKER_FRAME', routerPlayerId: 7, dataB64: Buffer.from('stray').toString('base64') }))
  expect('two clients in one region: a worker-local id in the router-id slot reaches no socket', [sockA.received.length, sockB.received.length], before)
  const malformedLines = refusedLines(() => router._handleWorkerMessage('0,0', { type: 'WORKER_FRAME', routerPlayerId: '7', dataB64: Buffer.from('stray').toString('base64') }))
  expect('two clients in one region: a router-id slot that is not a router id is refused, not dropped', malformedLines.some(l => l.includes(ROUTER_PLAYER_ID_MALFORMED)), true)
  expect('two clients in one region: the refused frame still reaches no socket', [sockA.received.length, sockB.received.length], before)
  expect('two clients in one region: a worker-local id is not a refusal, only a miss', strayLines, [])
}

async function unadmittedClients() {
  const router = new RegionRouter({ worldDef: { spawnPoint: [10, 5, 10] }, port: 0 })
  const worker = stubWorker(router, '0,0', [])
  const sockA = fakeSocket()
  const sockB = fakeSocket()
  const idA = await router._onSocketConnect(sockA, [10, 5, 10])
  const idB = await router._onSocketConnect(sockB, [10, 5, 10])
  expect('unidentified players: neither is admitted', [idA, idB, router.players.size], [null, null, 0])
  expect('unidentified players: both sockets are closed', [sockA.readyState, sockB.readyState], [3, 3])
  expect('unidentified players: the region is told to drop each one', worker.received.filter(m => m.type === 'CLIENT_DISCONNECT'), [{ type: 'CLIENT_DISCONNECT', routerPlayerId: 1 }, { type: 'CLIENT_DISCONNECT', routerPlayerId: 2 }])
  frameFrom(sockA, 'frame-a')
  await new Promise(r => setImmediate(r))
  expect('unidentified players: no frame is forwarded to the region', worker.frames, [])
  const strayLines = refusedLines(() => {
    router._handleWorkerMessage('0,0', { type: 'WORKER_FRAME', routerPlayerId: null, dataB64: Buffer.from('stray').toString('base64') })
    router._handleWorkerMessage('0,0', { type: 'WORKER_FRAME', routerPlayerId: undefined, dataB64: Buffer.from('stray').toString('base64') })
  })
  expect('unidentified players: a frame addressed to a null router id lands on no socket', [sockA.received, sockB.received], [[], []])
  expect('unidentified players: a null router id is refused loud, twice', strayLines.filter(l => l.includes(ROUTER_PLAYER_ID_MALFORMED)).length, 2)
}

async function handoffChecks() {
  const router = new RegionRouter({ worldDef: { spawnPoint: [10, 5, 10] }, port: 0 })
  const origin = stubWorker(router, '0,0', [7])
  const east = stubWorker(router, '1,0', [])
  const offGrid = stubWorker(router, 'north', [])
  const sock = fakeSocket()
  await router._onSocketConnect(sock, [10, 5, 10])
  const badIdLines = refusedLines(() => router._handleWorkerMessage('0,0', { type: 'BOUNDARY_CROSSING', routerPlayerId: 7, fromRegion: '0,0', toRegion: '1,0', state: {}, sessionToken: TOK }))
  expect('handoff: a crossing that names a router id in the local-id slot mints nothing', [east.received.length, identityOf(router, 1).handoff, badIdLines.some(l => l.includes(LOCAL_PLAYER_ID_MALFORMED))], [0, null, true])
  const badTokenLines = refusedLines(() => router._handleWorkerMessage('0,0', { type: 'BOUNDARY_CROSSING', localPlayerId: 7, fromRegion: '0,0', toRegion: '1,0', state: {}, sessionToken: 'tok' }))
  expect('handoff: a crossing carrying a token that is not a session token mints nothing', [east.received.length, identityOf(router, 1).handoff, badTokenLines.some(l => l.includes(SESSION_TOKEN_MALFORMED))], [0, null, true])
  router._handleWorkerMessage('0,0', { type: 'BOUNDARY_CROSSING', localPlayerId: 7, fromRegion: '0,0', toRegion: 'north', state: {}, sessionToken: TOK })
  expect('handoff: a crossing to a region that is not a region id mints nothing', [offGrid.received.length, identityOf(router, 1).handoff], [0, null])
  router._handleWorkerMessage('0,0', { type: 'BOUNDARY_CROSSING', localPlayerId: 7, fromRegion: '0,0', toRegion: '1,0', state: { position: [600, 5, 10] }, sessionToken: TOK })
  expect('handoff: a crossing mints a handoff carrying all three fields', identityOf(router, 1).handoff, { toRegion: '1,0', fromRegion: '0,0', fromLocalId: 7 })
  expect('handoff: the accepting region is asked to admit the crossing player under its local id', east.received.map(m => [m.type, m.localPlayerId, m.fromRegion]), [['ACCEPT_HANDOFF', 7, '0,0']])
  expect('handoff: the accepting region is told the router id to answer on', east.received.map(m => m.routerPlayerId), [1])
  router._handleWorkerMessage('1,0', { type: 'HANDOFF_ACCEPTED', region: '1,0', fromRegion: '0,0', oldLocalPlayerId: 7, newLocalPlayerId: null, sessionToken: TOK2 })
  expect('handoff: an acceptance with no new local id is refused and the admitted player is dropped', east.received.map(m => m.type === 'COMPLETE_HANDOFF_OUT' ? ['COMPLETE_HANDOFF_OUT', m.routerPlayerId] : m.type), ['ACCEPT_HANDOFF', ['COMPLETE_HANDOFF_OUT', 1]])
  expect('handoff: the refused acceptance leaves the identity untouched', identityOf(router, 1), { region: '0,0', localPlayerId: 7, handoff: { toRegion: '1,0', fromRegion: '0,0', fromLocalId: 7 } })
  router._handleWorkerMessage('1,0', { type: 'HANDOFF_ACCEPTED', region: '1,0', fromRegion: '0,0', oldLocalPlayerId: 7, newLocalPlayerId: 11, sessionToken: TOK3 })
  expect('handoff: an accepted crossing re-mints the identity and goes idle', identityOf(router, 1), { region: '1,0', localPlayerId: 11, handoff: null })
  expect('handoff: the vacated region is told to complete the handoff out', origin.received.filter(m => m.type === 'COMPLETE_HANDOFF_OUT'), [{ type: 'COMPLETE_HANDOFF_OUT', routerPlayerId: 1 }])
  frameFrom(sock, 'frame-after-handoff')
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
  expect('handoff: a frame after the crossing reaches the new region under its router id', east.frames, [{ routerPlayerId: 1, data: 'frame-after-handoff' }])
}

function mintedOrRefusal(x, z, cellSize) {
  try {
    return { minted: regionIdFor(x, z, cellSize) }
  } catch (error) {
    return { code: error?.code ?? null }
  }
}

async function spawnEdgeChecks() {
  expect('spawn edge: a finite spawn still mints its region', mintedOrRefusal(10, 10), { minted: '0,0' })
  expect('spawn edge: a NaN x mints nothing, it is refused by name at the producer', mintedOrRefusal(NaN, 5), { code: REGION_COORDS_NOT_FINITE })
  expect('spawn edge: a NaN z is refused the same way', mintedOrRefusal(5, NaN), { code: REGION_COORDS_NOT_FINITE })
  expect('spawn edge: an infinity is not a coordinate', mintedOrRefusal(Infinity, 5), { code: REGION_COORDS_NOT_FINITE })
  expect('spawn edge: an absent coordinate is refused, not minted as NaN', mintedOrRefusal(undefined, undefined), { code: REGION_COORDS_NOT_FINITE })
  expect('spawn edge: a cell size that is not positive is refused by its own name', mintedOrRefusal(10, 10, 0), { code: REGION_CELL_SIZE_NOT_POSITIVE })
  expect('spawn edge: no refusal is the string NaN,0', JSON.stringify([mintedOrRefusal(NaN, 5), mintedOrRefusal(5, NaN)]).includes('NaN,0'), false)

  const router = new RegionRouter({ worldDef: { spawnPoint: [10, 5, 10] }, port: 0 })
  const worker = stubWorker(router, '0,0', [7])
  const sock = fakeSocket()
  const lines = refusedLines(() => router._onSocketConnect(sock, [NaN, 5, 0]))
  await new Promise(r => setImmediate(r))
  expect('spawn edge: a socket whose spawn mints no region is closed, not admitted', sock.readyState, 3)
  expect('spawn edge: the refused spawn registers no player', router.players.size, 0)
  expect('spawn edge: no region is asked to admit it', worker.received.filter(m => m.type === 'CLIENT_CONNECT'), [])
  expect('spawn edge: the refusal names the coordinate space', lines.some(l => l.includes(REGION_COORDS_NOT_FINITE)), true)

  const defRouter = new RegionRouter({ worldDef: { spawnPoint: [NaN, 5, 10] }, port: 0 })
  const defWorker = stubWorker(defRouter, '0,0', [7])
  const defSock = fakeSocket()
  await defRouter._onSocketConnect(defSock, undefined)
  expect('spawn edge: a world spawn point that is not finite refuses the connection too', [defSock.readyState, defRouter.players.size, defWorker.received.length], [3, 0, 0])
}

await typeChecks()
await twoClientsOneRegion()
await unadmittedClients()
await handoffChecks()
await spawnEdgeChecks()
finish()
