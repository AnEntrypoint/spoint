import http from 'node:http'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

await installSpecifierHooks()
const { RoomDirectory } = await import('../src/sdk/RoomDirectory.js')

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORLD = 'empty'
const failures = []
const log = []

function record(name, ok, detail) {
  log.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

async function expectRejectCode(name, promiseFactory, code) {
  try {
    await promiseFactory()
    record(name, false, `accepted, expected refusal ${code}`)
  } catch (e) {
    record(name, e?.reasonCode === code, `reasonCode=${e?.reasonCode ?? 'none'} message=${e?.message ?? ''}`)
  }
}

function expectSyncCode(name, factory, code) {
  try {
    factory()
    record(name, false, `accepted, expected refusal ${code}`)
  } catch (e) {
    record(name, e?.reasonCode === code, `reasonCode=${e?.reasonCode ?? 'none'} message=${e?.message ?? ''}`)
  }
}

const listened = []
const originalListen = http.Server.prototype.listen
http.Server.prototype.listen = function recordingListen(...args) {
  listened.push({ server: this, host: args[1] })
  return originalListen.apply(this, args)
}

function connectsTo(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(true) })
    socket.on('error', () => resolve(false))
  })
}

const sdkRoot = REPO_ROOT

record('default portRange is [19000,19999]', (() => {
  const d = new RoomDirectory({ sdkRoot })
  return JSON.stringify(d.portRange) === '[19000,19999]'
})(), 'RoomDirectory default')

for (const bad of [[5, 3], [1.5, 3], ['1', 3], [-1, 3], [0, 3], [1, 70000], [19000], 'nope', [19000, 19999, 1]]) {
  expectSyncCode(`portRange ${JSON.stringify(bad)} refused`, () => new RoomDirectory({ sdkRoot, portRange: bad }), 'room-port-range-invalid')
}

for (const bad of ['abc', -1, 70000, 1.5, '19000', NaN]) {
  await expectRejectCode(`port ${JSON.stringify(String(bad))} refused`, () => new RoomDirectory({ sdkRoot }).createRoom('bad-port', WORLD, { port: bad }), 'room-port-invalid')
}

{
  const d = new RoomDirectory({ sdkRoot })
  d.rooms.set('held', { roomId: 'held', port: 19050, server: null })
  await expectRejectCode('port hosted by another room refused', () => d.createRoom('dup-port', WORLD, { port: 19050 }), 'room-port-in-use')
  d.rooms.delete('held')
}

expectSyncCode('host "" refused', () => new RoomDirectory({ sdkRoot, host: '' }), 'room-host-invalid')
expectSyncCode('host 5 refused', () => new RoomDirectory({ sdkRoot, host: 5 }), 'room-host-invalid')
record('default host is 0.0.0.0', new RoomDirectory({ sdkRoot }).host === '0.0.0.0', `host=${new RoomDirectory({ sdkRoot }).host}`)

const bootSource = readFileSync(join(REPO_ROOT, 'bin', 'room-worker-boot.js'), 'utf8')
record('room-worker-boot passes ROOM_HOST only when set', /process\.env\.ROOM_HOST[\s\S]{0,120}host/.test(bootSource), 'static source check of bin/room-worker-boot.js; the boot process is not imported')

const zero = new RoomDirectory({ sdkRoot, portRange: [19300, 19399] })
try {
  const handle = await zero.createRoom('zero-room', WORLD, { port: 0 })
  const bound = listened.at(-1)?.server.address()
  record('port 0 reports a real OS port', Number.isInteger(handle.port) && handle.port > 0 && handle.port !== 3000 && bound?.port === handle.port, `handle.port=${handle.port} listening=${bound?.port}`)
  record('port 0 room accepts a TCP connection on its bound port', await connectsTo(handle.port), `port=${handle.port}`)
  record('default host binds 0.0.0.0', bound?.address === '0.0.0.0', `address=${bound?.address}`)
  await zero.stopAll()
} catch (e) {
  record('port 0 room created on default host', false, e?.message || String(e))
  await zero.stopAll().catch(() => {})
}

const loopback = new RoomDirectory({ sdkRoot, portRange: [19400, 19499], host: '127.0.0.1' })
try {
  const handle = await loopback.createRoom('loop-room', WORLD, { port: 0 })
  const bound = listened.at(-1)?.server.address()
  record('explicit host 127.0.0.1 honoured', bound?.address === '127.0.0.1' && handle.port > 0, `address=${bound?.address} port=${handle.port}`)
  await loopback.stopAll()
} catch (e) {
  record('explicit host 127.0.0.1 honoured', false, e?.message || String(e))
  await loopback.stopAll().catch(() => {})
}

http.Server.prototype.listen = originalListen

for (const line of log) console.log(line)
if (failures.length === 0) {
  console.log('RESULT: PASS')
} else {
  console.log(`RESULT: FAIL ${failures.length} check(s): ${failures.join('; ')}`)
}
await exitAfterQuiesce(failures.length === 0 ? 0 : 1)
