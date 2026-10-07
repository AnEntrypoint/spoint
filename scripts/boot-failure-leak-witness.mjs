import { createServer as createNetServer, connect as netConnect } from 'node:net'
import { resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer as createSpointServer } from '../src/sdk/server.js'
import { loadWorldModule } from '../src/sdk/WorldLocator.js'

const SDK_ROOT = resolve(process.argv[2] || process.cwd())
const WORK_DIR = resolve(SDK_ROOT, 'data', 'boot-failure-leak-witness')
const CORRUPT_HEIGHTFIELD = 'boot-failure-corrupt.hf'
const ABSENT_HEIGHTFIELD = 'boot-failure-absent.hf'
const POST_BOOT_OBSERVE_MS = 1500
const POST_BOOT_LOG_LIMIT = 2
const OWNED_HANDLE_LIMIT = 2
const DRAIN_TIMEOUT_MS = 5000
const CONNECT_PROBE_TIMEOUT_MS = 1000
const EXIT_WATCHDOG_MS = 2000

await mkdir(WORK_DIR, { recursive: true })
await writeFile(resolve(WORK_DIR, CORRUPT_HEIGHTFIELD), Buffer.alloc(512, 0xa5))
process.chdir(WORK_DIR)

const sleep = ms => new Promise(r => setTimeout(r, ms))

const handleList = () => (process._getActiveHandles?.() ?? []).filter(Boolean)

const isStdioHandle = h => h === process.stdout || h === process.stderr || h === process.stdin || h?.fd === 0 || h?.fd === 1 || h?.fd === 2

function handleCensus() {
  const handles = handleList()
  let stdio = 0, owned = 0, servers = 0, sockets = 0, watchers = 0, other = 0
  for (const h of handles) {
    if (isStdioHandle(h)) { stdio++; continue }
    owned++
    const name = h?.constructor?.name || ''
    if (name === 'Server') servers++
    else if (name === 'Socket' || name === 'TLSSocket' || name === 'Pipe') sockets++
    else if (name === 'FSEvent' || name === 'StatWatcher') watchers++
    else other++
  }
  return { total: handles.length, stdio, owned, servers, sockets, watchers, other }
}

const failures = []
function expect(name, got, predicate) {
  const ok = predicate(got)
  console.log(`RESULT ${name}=${JSON.stringify(got)} ${ok ? 'ok' : 'FAIL'}`)
  if (!ok) failures.push(name)
  return ok
}

const freePort = () => new Promise((res, rej) => {
  const s = createNetServer()
  s.once('error', rej)
  s.listen(0, '127.0.0.1', () => {
    const port = s.address().port
    s.close(() => res(port))
  })
})

const connectsToPort = port => new Promise(res => {
  const socket = netConnect({ host: '127.0.0.1', port })
  let timer = null
  const finish = reached => { if (timer) clearTimeout(timer); socket.destroy(); res(reached) }
  timer = setTimeout(() => finish(false), CONNECT_PROBE_TIMEOUT_MS)
  socket.once('connect', () => finish(true))
  socket.once('error', () => finish(false))
})

async function countLogLines(ms) {
  const sinks = ['log', 'info', 'warn', 'error']
  const originals = sinks.map(k => [k, console[k].bind(console)])
  let lines = 0
  for (const [k, sink] of originals) console[k] = (...args) => { lines++; sink('POST-BOOT', ...args) }
  await sleep(ms)
  for (const [k, sink] of originals) console[k] = sink
  return lines
}

const loaded = await loadWorldModule(resolve(SDK_ROOT, 'apps/world/tps-game.js'))
const baseWorldDef = { ...loaded, entities: loaded.entities.filter(e => e.id !== 'env-sillos') }
const tickRate = baseWorldDef.tickRate || 64

async function bootArm({ bakedHeightfield, start }) {
  const port = await freePort()
  const server = await createSpointServer({
    port, tickRate,
    appsDirs: [resolve(SDK_ROOT, 'apps'), resolve(SDK_ROOT, 'src/stdlib-apps')],
    sdkRoot: SDK_ROOT, gravity: baseWorldDef.gravity, staticDirs: [],
    storageDir: resolve(WORK_DIR, 'data'),
  })
  const terrain = { ...baseWorldDef.terrain, gpuPatchCollider: false, bakedHeightfield }
  let bootError = null
  try { await server.loadWorld({ ...baseWorldDef, terrain, tickRate }) } catch (e) { bootError = e }
  let listening = false
  if (!bootError && start) { await server.start(); listening = await connectsToPort(port) }
  const postBootLogLines = await countLogLines(POST_BOOT_OBSERVE_MS)
  const listenerLeaked = bootError ? await connectsToPort(port) : false
  let stopError = null
  try { server.stop() } catch (e) { stopError = e }
  await sleep(200)
  return {
    port, listening, listenerLeaked, postBootLogLines,
    bootError: bootError ? String(bootError.message || bootError) : null,
    stopError: stopError ? String(stopError.message || stopError) : null,
    handles: handleCensus(),
  }
}

const handlesBefore = handleCensus()
console.log(`RESULT handlesBefore=${JSON.stringify(handlesBefore)}`)

const firstFailedBoot = await bootArm({ bakedHeightfield: CORRUPT_HEIGHTFIELD, start: false })
const secondFailedBoot = await bootArm({ bakedHeightfield: CORRUPT_HEIGHTFIELD, start: false })
const controlBoot = await bootArm({ bakedHeightfield: ABSENT_HEIGHTFIELD, start: true })

console.log(`RESULT firstFailedBoot=${JSON.stringify(firstFailedBoot)}`)
console.log(`RESULT secondFailedBoot=${JSON.stringify(secondFailedBoot)}`)
console.log(`RESULT controlBoot=${JSON.stringify(controlBoot)}`)
console.log(`RESULT inducedBootError=${JSON.stringify(firstFailedBoot.bootError)}`)

const terrainErrorMarkers = ['[terrain]', 'has no terrain', '[baked-heightfield]', 'not a heightfield']
expect('failedBootThrewNamedTerrainError', firstFailedBoot.bootError, message => typeof message === 'string' && terrainErrorMarkers.every(marker => message.includes(marker)))
expect('secondFailedBootThrewNamedTerrainError', secondFailedBoot.bootError, message => typeof message === 'string' && message.includes('[baked-heightfield]'))
expect('failedBootStopsLogging', firstFailedBoot.postBootLogLines, lines => lines <= POST_BOOT_LOG_LIMIT)
expect('failedBootStopsLoggingOnRepeat', secondFailedBoot.postBootLogLines, lines => lines <= POST_BOOT_LOG_LIMIT)
expect('failedBootLeavesNoListener', firstFailedBoot.listenerLeaked, leaked => leaked === false)
expect('failedBootLeavesNoWatchers', firstFailedBoot.handles.watchers, watchers => watchers === 0)
expect('failedBootLeavesNoServerHandle', firstFailedBoot.handles.servers, servers => servers === 0)
expect('failedBootOwnedHandleGrowthOverBaseline', firstFailedBoot.handles.owned - handlesBefore.owned, growth => growth <= OWNED_HANDLE_LIMIT)
expect('repeatedFailedBootDoesNotGrowHandles', secondFailedBoot.handles.owned - firstFailedBoot.handles.owned, growth => growth <= 0)
expect('failedBootLeaksNoMoreThanSuccessfulBoot', firstFailedBoot.handles.owned - controlBoot.handles.owned, excess => excess <= 0)
expect('controlBootSucceeded', controlBoot.bootError, error => error === null)
expect('controlBootListensOnPort', [controlBoot.port, controlBoot.listening], ([port, listening]) => port > 1024 && listening === true)
expect('everyStopReturnedCleanly', [firstFailedBoot.stopError, secondFailedBoot.stopError, controlBoot.stopError], errors => errors.every(error => error === null))

const drainDeadline = Date.now() + DRAIN_TIMEOUT_MS
let drained = handleCensus()
while (drained.owned > 0 && Date.now() < drainDeadline) { await sleep(25); drained = handleCensus() }
console.log(`RESULT handlesAfterDrain=${JSON.stringify(drained)}`)
console.log(`RESULT handleInventory=${JSON.stringify(handleList().map(h => `${h?.constructor?.name || typeof h}:fd=${h?.fd ?? null}`))}`)
expect('ownedHandlesDrainedBeforeExit', drained.owned, owned => owned === 0)

const verdict = failures.length ? `RESULT: FAIL ${failures.join(',')}` : 'RESULT: PASS'
const exitCode = failures.length ? 1 : 0
console.log(verdict)
const exitWatchdog = setTimeout(() => process.exit(exitCode), EXIT_WATCHDOG_MS)
exitWatchdog.unref()
process.exitCode = exitCode
