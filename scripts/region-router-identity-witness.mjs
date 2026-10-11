#!/usr/bin/env node
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODULE_PATH = process.argv[2] ? resolve(process.argv[2]) : join(REPO_ROOT, 'src/sharding/RegionRouter.js')
const WATCHDOG_MS = 60000

const { RegionRouter, playerIdentity, handoffTo } = await import(pathToFileURL(MODULE_PATH).href)

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
          worker.frames.push({ playerId: msg.playerId, data: Buffer.from(msg.dataB64, 'base64').toString() })
          setImmediate(() => router._handleWorkerMessage(regionId, { type: 'WORKER_FRAME', playerId: msg.playerId, dataB64: msg.dataB64 }))
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
  expect('two clients in one region: each frame reaches the worker under its own local id', worker.frames, [{ playerId: 7, data: 'frame-a' }, { playerId: 9, data: 'frame-b' }])
  expect('two clients in one region: each frame lands on its own socket', [sockA.received, sockB.received], [['frame-a'], ['frame-b']])
  frameFrom(sockB, 'frame-b2')
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
  expect('two clients in one region: the frame from B lands on B only', [sockA.received, sockB.received], [['frame-a'], ['frame-b', 'frame-b2']])
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
  expect('unidentified players: the region is told to drop each one', worker.received.filter(m => m.type === 'CLIENT_DISCONNECT'), [{ type: 'CLIENT_DISCONNECT', playerId: 1 }, { type: 'CLIENT_DISCONNECT', playerId: 2 }])
  frameFrom(sockA, 'frame-a')
  await new Promise(r => setImmediate(r))
  expect('unidentified players: no frame is forwarded to the region', worker.frames, [])
  router._handleWorkerMessage('0,0', { type: 'WORKER_FRAME', playerId: null, dataB64: Buffer.from('stray').toString('base64') })
  router._handleWorkerMessage('0,0', { type: 'WORKER_FRAME', playerId: undefined, dataB64: Buffer.from('stray').toString('base64') })
  expect('unidentified players: a frame addressed to a null local id lands on no socket', [sockA.received, sockB.received], [[], []])
}

async function handoffChecks() {
  const router = new RegionRouter({ worldDef: { spawnPoint: [10, 5, 10] }, port: 0 })
  const origin = stubWorker(router, '0,0', [7])
  const east = stubWorker(router, '1,0', [])
  const offGrid = stubWorker(router, 'north', [])
  const sock = fakeSocket()
  await router._onSocketConnect(sock, [10, 5, 10])
  router._handleWorkerMessage('0,0', { type: 'BOUNDARY_CROSSING', playerId: 7, fromRegion: '0,0', toRegion: 'north', state: {}, sessionToken: 'tok' })
  expect('handoff: a crossing to a region that is not a region id mints nothing', [offGrid.received.length, identityOf(router, 1).handoff], [0, null])
  router._handleWorkerMessage('0,0', { type: 'BOUNDARY_CROSSING', playerId: 7, fromRegion: '0,0', toRegion: '1,0', state: { position: [600, 5, 10] }, sessionToken: 'tok' })
  expect('handoff: a crossing mints a handoff carrying all three fields', identityOf(router, 1).handoff, { toRegion: '1,0', fromRegion: '0,0', fromLocalId: 7 })
  expect('handoff: the accepting region is asked to admit the crossing player', east.received.map(m => [m.type, m.playerId, m.fromRegion]), [['ACCEPT_HANDOFF', 7, '0,0']])
  router._handleWorkerMessage('1,0', { type: 'HANDOFF_ACCEPTED', region: '1,0', fromRegion: '0,0', oldPlayerId: 7, newLocalPlayerId: null, sessionToken: 'tok2' })
  expect('handoff: an acceptance with no new local id is refused and the admitted player is dropped', east.received.map(m => m.type === 'COMPLETE_HANDOFF_OUT' ? ['COMPLETE_HANDOFF_OUT', m.playerId] : m.type), ['ACCEPT_HANDOFF', ['COMPLETE_HANDOFF_OUT', null]])
  expect('handoff: the refused acceptance leaves the identity untouched', identityOf(router, 1), { region: '0,0', localPlayerId: 7, handoff: { toRegion: '1,0', fromRegion: '0,0', fromLocalId: 7 } })
  router._handleWorkerMessage('1,0', { type: 'HANDOFF_ACCEPTED', region: '1,0', fromRegion: '0,0', oldPlayerId: 7, newLocalPlayerId: 11, sessionToken: 'tok3' })
  expect('handoff: an accepted crossing re-mints the identity and goes idle', identityOf(router, 1), { region: '1,0', localPlayerId: 11, handoff: null })
  expect('handoff: the vacated region is told to complete the handoff out', origin.received.filter(m => m.type === 'COMPLETE_HANDOFF_OUT'), [{ type: 'COMPLETE_HANDOFF_OUT', playerId: 7 }])
  frameFrom(sock, 'frame-after-handoff')
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
  expect('handoff: a frame after the crossing reaches the new region under the new local id', east.frames, [{ playerId: 11, data: 'frame-after-handoff' }])
}

await typeChecks()
await twoClientsOneRegion()
await unadmittedClients()
await handoffChecks()
finish()
