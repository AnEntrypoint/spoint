import { createServer as createNetServer, connect as netConnect } from 'node:net'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createServer as createSpointServer } from '../src/sdk/server.js'
import { loadWorldModule } from '../src/sdk/WorldLocator.js'

const SDK_ROOT = resolve(process.argv[2] || process.cwd())
const WORK_DIR = resolve(SDK_ROOT, 'data', 'boot-failure-leak-witness')
const CORRUPT_HEIGHTFIELD = 'boot-failure-corrupt.hf'
const ABSENT_HEIGHTFIELD = 'boot-failure-absent.hf'
const CORRUPT_HF_BYTES = 512
const CORRUPT_HF_MAGIC_HEX = 'a5a5a5a5'
const POST_BOOT_OBSERVE_MS = 1500
const POST_BOOT_LOG_LIMIT = 2
const WINDOW_SLACK_MS = 100
const CONTROL_LOG_WINDOW_MS = 400
const CONTROL_LOG_PING_EVERY_MS = 50
const CONTROL_LOG_MIN_LINES = 3
const OWNED_HANDLE_LIMIT = 2
const DRAIN_TIMEOUT_MS = 5000
const CONNECT_PROBE_TIMEOUT_MS = 1000
const EXIT_WATCHDOG_MS = 2000
const PORT_DRAW_ATTEMPTS = 32

await mkdir(WORK_DIR, { recursive: true })
await writeFile(resolve(WORK_DIR, CORRUPT_HEIGHTFIELD), Buffer.alloc(CORRUPT_HF_BYTES, 0xa5))
process.chdir(WORK_DIR)

const sleep = ms => new Promise(r => setTimeout(r, ms))

const handleList = () => (process._getActiveHandles?.() ?? []).filter(Boolean)

const resourceKindCounts = () => {
  const counts = {}
  let total = 0
  for (const kind of process.getActiveResourcesInfo?.() ?? []) {
    if (!kind) continue
    counts[kind] = (counts[kind] || 0) + 1
    total++
  }
  return { counts, total }
}

const isStdioHandle = h => h === process.stdout || h === process.stderr || h === process.stdin || h?.fd === 0 || h?.fd === 1 || h?.fd === 2

const SERVER_OR_WATCHER_RESOURCE = /tcpserver|tcpwrap|fs(event|watch)|statwatcher|pipeserverwrap/i
const PIPE_RESOURCE = /^pipewrap$/i

const isServerOrWatcherResource = kind => SERVER_OR_WATCHER_RESOURCE.test(kind)
const isPipeResource = kind => PIPE_RESOURCE.test(kind)

const pipeResourceCount = resources =>
  Object.keys(resources).filter(isPipeResource).reduce((n, kind) => n + resources[kind], 0)

const stdioPipeCount = () =>
  [process.stdin, process.stdout, process.stderr].filter(s => s?._handle?.constructor?.name === 'Pipe').length

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
  const resourceInfo = resourceKindCounts()
  return { total: handles.length, stdio, owned, servers, sockets, watchers, other, resources: resourceInfo.counts, resourceTotal: resourceInfo.total }
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

// "Two distinct attempts" is an assertion about THIS witness, not about the OS: an ephemeral draw
// from port 0 hands the same number back twice often enough on Linux CI that the arms used to be
// compared on a value nobody chose. Draw until the allocator gives a port no earlier arm used.
const drawnPorts = new Set()
const drawUnusedPort = async () => {
  for (let attempt = 0; attempt < PORT_DRAW_ATTEMPTS; attempt++) {
    const port = await freePort()
    if (!drawnPorts.has(port)) { drawnPorts.add(port); return port }
  }
  throw new Error(`boot-failure-leak: no unused port in ${PORT_DRAW_ATTEMPTS} draw(s)`)
}

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
  const startedAt = Date.now()
  await sleep(ms)
  const windowMs = Date.now() - startedAt
  for (const [k, sink] of originals) console[k] = sink
  return { lines, windowMs }
}

async function logInstrumentControl() {
  let emitted = 0
  const timer = setInterval(() => {
    emitted++
    console.log(`boot-failure-leak log-instrument control ping ${emitted}`)
  }, CONTROL_LOG_PING_EVERY_MS)
  const window = await countLogLines(CONTROL_LOG_WINDOW_MS)
  clearInterval(timer)
  return { ...window, emitted }
}

const loaded = await loadWorldModule(resolve(SDK_ROOT, 'apps/world/tps-game.js'))
const baseWorldDef = { ...loaded, entities: loaded.entities.filter(e => e.id !== 'env-sillos') }
const tickRate = baseWorldDef.tickRate || 64

async function bootArm({ bakedHeightfield, start }) {
  const port = await drawUnusedPort()
  const startedAt = Date.now()
  const server = await createSpointServer({
    port, tickRate,
    appsDirs: [resolve(SDK_ROOT, 'apps'), resolve(SDK_ROOT, 'src/stdlib-apps')],
    sdkRoot: SDK_ROOT, gravity: baseWorldDef.gravity, staticDirs: [],
    storageDir: resolve(WORK_DIR, 'data'),
  })
  const terrain = { ...baseWorldDef.terrain, gpuPatchCollider: false, bakedHeightfield }
  let bootError = null
  const loadStartedAt = Date.now()
  try { await server.loadWorld({ ...baseWorldDef, terrain, tickRate }) } catch (e) { bootError = e }
  const bootDurationMs = Date.now() - loadStartedAt
  let listening = false
  if (!bootError && start) { await server.start(); listening = await connectsToPort(port) }
  const handlesLive = handleCensus()
  const postBootWindow = await countLogLines(POST_BOOT_OBSERVE_MS)
  const listenerLeaked = bootError ? await connectsToPort(port) : false
  let stopError = null
  try { server.stop() } catch (e) { stopError = e }
  await sleep(200)
  const stoppedAt = Date.now()
  return {
    port, startedAt, stoppedAt, bootDurationMs, listening, listenerLeaked,
    postBootLogLines: postBootWindow.lines, postBootWindowMs: postBootWindow.windowMs,
    bootError: bootError ? String(bootError.message || bootError) : null,
    stopError: stopError ? String(stopError.message || stopError) : null,
    handlesLive, handles: handleCensus(),
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

const corruptHeightfieldBytes = await readFile(resolve(WORK_DIR, CORRUPT_HEIGHTFIELD))
const corruptHeightfieldOnDisk = {
  bytes: corruptHeightfieldBytes.length,
  magic: corruptHeightfieldBytes.subarray(0, 4).toString('hex'),
  absentHeightfieldExists: existsSync(resolve(WORK_DIR, ABSENT_HEIGHTFIELD)),
  namedByError: firstFailedBoot.bootError !== null && firstFailedBoot.bootError.includes(CORRUPT_HEIGHTFIELD),
}
console.log(`RESULT corruptHeightfieldOnDisk=${JSON.stringify(corruptHeightfieldOnDisk)}`)

const controlLogWindow = await logInstrumentControl()
console.log(`RESULT controlLogWindow=${JSON.stringify(controlLogWindow)}`)

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

// --- non-zero denominators: every claim above is measured, not defaulted to a zero ---
expect('logInstrumentCountsEmittedLines', controlLogWindow, window => window.lines >= CONTROL_LOG_MIN_LINES && window.lines >= 1 && window.emitted >= CONTROL_LOG_MIN_LINES && window.windowMs >= CONTROL_LOG_WINDOW_MS - WINDOW_SLACK_MS)
expect('postBootWindowsWereLive', [firstFailedBoot.postBootWindowMs, secondFailedBoot.postBootWindowMs, controlBoot.postBootWindowMs], windows => windows.every(ms => ms >= POST_BOOT_OBSERVE_MS - WINDOW_SLACK_MS))
expect('bootArmsActuallyRan', [firstFailedBoot.bootDurationMs, secondFailedBoot.bootDurationMs, controlBoot.bootDurationMs], durations => durations.every(ms => ms > 0))
expect('handleCensusIsNonDegenerate', { baseline: handlesBefore, failedLive: firstFailedBoot.handlesLive, controlLive: controlBoot.handlesLive }, census => census.controlLive.total >= 1 && census.controlLive.total >= census.controlLive.stdio && census.controlLive.servers >= 1 && census.controlLive.owned >= 1)
expect('censusResourceInfoCorroboratesServerHandle', { servers: controlBoot.handlesLive.servers, resourceTotal: controlBoot.handlesLive.resourceTotal, resources: controlBoot.handlesLive.resources }, live => live.servers >= 1 && live.resourceTotal >= 1 && Object.keys(live.resources).some(isServerOrWatcherResource))
expect('failedBootLiveOwnedNoMoreThanControl', [firstFailedBoot.handlesLive.owned, controlBoot.handlesLive.owned], ([failed, control]) => control >= 1 && failed <= control)
expect('corruptHeightfieldWasTheFileOnDisk', corruptHeightfieldOnDisk, disk => disk.bytes === CORRUPT_HF_BYTES && disk.magic === CORRUPT_HF_MAGIC_HEX && disk.namedByError === true && disk.absentHeightfieldExists === false)
expect('corruptHeightfieldIsProximateCause', { corruptArmError: firstFailedBoot.bootError, absentArmError: controlBoot.bootError }, arms => arms.corruptArmError !== null && arms.absentArmError === null && arms.corruptArmError.includes(CORRUPT_HEIGHTFIELD) && !arms.corruptArmError.includes(ABSENT_HEIGHTFIELD))
expect('failedBootsAreDistinctAttempts', {
  firstPort: firstFailedBoot.port, secondPort: secondFailedBoot.port,
  firstStoppedAt: firstFailedBoot.stoppedAt, secondStartedAt: secondFailedBoot.startedAt,
}, arms => arms.firstPort > 1024 && arms.secondPort > 1024 && arms.firstPort !== arms.secondPort && arms.secondStartedAt > arms.firstStoppedAt)
expect('repeatedFailedBootReproducesSameError', [firstFailedBoot.bootError, secondFailedBoot.bootError], ([first, second]) => first !== null && first === second)

const arms = [firstFailedBoot, secondFailedBoot, controlBoot]
const peakLiveCensus = arms.map(arm => arm.handlesLive).reduce((a, b) => (b.total > a.total ? b : a))

const drainDeadline = Date.now() + DRAIN_TIMEOUT_MS
let drained = handleCensus()
while (drained.owned > 0 && Date.now() < drainDeadline) { await sleep(25); drained = handleCensus() }
console.log(`RESULT handlesAfterDrain=${JSON.stringify(drained)}`)
console.log(`RESULT handleInventory=${JSON.stringify(handleList().map(h => `${h?.constructor?.name || typeof h}:fd=${h?.fd ?? null}`))}`)
expect('ownedHandlesDrainedBeforeExit', drained.owned, owned => owned === 0)
expect('drainedCensusCorroboratedByLiveInstrument', { seenLiveTotal: peakLiveCensus.total, drainedTotal: drained.total, drainedServers: drained.servers, drainedWatchers: drained.watchers, drainedResources: drained.resources, drainedPipes: pipeResourceCount(drained.resources), stdioPipes: stdioPipeCount() }, v => v.seenLiveTotal >= 1 && v.drainedServers === 0 && v.drainedWatchers === 0 && !Object.keys(v.drainedResources).some(isServerOrWatcherResource) && v.drainedPipes <= v.stdioPipes)

const inducedFailures = [firstFailedBoot, secondFailedBoot].filter(arm => arm.bootError !== null).length
const controlSuccesses = controlBoot.bootError === null ? 1 : 0
const listenerLeaked = firstFailedBoot.listenerLeaked === true || secondFailedBoot.listenerLeaked === true
const ownedGrowth = firstFailedBoot.handles.owned - handlesBefore.owned
console.log(`MEASURED boot-failure-leak: ${inducedFailures} induced failed boot(s) + ${controlSuccesses} control boot, handle census ${peakLiveCensus.total} handle(s) of which ${peakLiveCensus.owned} owned, post-boot log line(s) ${firstFailedBoot.postBootLogLines}/${secondFailedBoot.postBootLogLines}, control log window ${controlLogWindow.lines} line(s) of ${controlLogWindow.emitted} emitted, listener leak ${listenerLeaked}, watchers ${firstFailedBoot.handles.watchers}, servers ${controlBoot.handlesLive.servers}, owned growth ${ownedGrowth}`)

const verdict = failures.length ? `RESULT: FAIL ${failures.join(',')}` : 'RESULT: PASS'
const exitCode = failures.length ? 1 : 0
console.log(verdict)
const exitWatchdog = setTimeout(() => process.exit(exitCode), EXIT_WATCHDOG_MS)
exitWatchdog.unref()
process.exitCode = exitCode
