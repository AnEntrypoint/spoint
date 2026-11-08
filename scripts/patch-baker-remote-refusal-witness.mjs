import { pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MODULE_URL = pathToFileURL(resolve(ROOT, 'packages/mapspinner/src/patch-baker-remote.js')).href
const READY_TIMEOUT_MS = 60000

const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const liveReadyTimers = new Set()
let fastReadyTimeout = false

globalThis.setTimeout = (fn, ms, ...args) => {
  if (ms !== READY_TIMEOUT_MS) return realSetTimeout(fn, ms, ...args)
  if (fastReadyTimeout) return realSetTimeout(fn, 0, ...args)
  const handle = realSetTimeout(() => { liveReadyTimers.delete(handle); fn(...args) }, ms)
  liveReadyTimers.add(handle)
  return handle
}
globalThis.clearTimeout = (handle) => {
  liveReadyTimers.delete(handle)
  realClearTimeout(handle)
}

function workerReplying(reply) {
  return class FakeWorker {
    constructor() { this.onmessage = null; this.onerror = null; this.terminated = false }
    postMessage(msg) { if (msg.type === 'init') realSetTimeout(() => reply(this), 0) }
    terminate() { this.terminated = true }
  }
}

const silentWorker = class SilentWorker { constructor() { this.onmessage = null; this.onerror = null } postMessage() {} terminate() {} }

function clearLiveReadyTimers() {
  const leftover = liveReadyTimers.size
  for (const handle of liveReadyTimers) realClearTimeout(handle)
  liveReadyTimers.clear()
  return leftover
}

async function outcome(run) {
  let result
  try {
    const value = await run()
    result = { resolved: value }
  } catch (err) {
    result = { code: err && err.code, message: err && err.message }
  }
  result.leftoverReadyTimers = clearLiveReadyTimers()
  return result
}

async function remoteBaker() {
  const mod = await import(MODULE_URL)
  return mod.createRemotePatchBaker({ radius: 1000, reliefScale: 0.001, seed: 1 })
}

const EXPECTED = {
  noWorker: 'no-worker',
  constructFailed: 'worker-construct-failed',
  initFailed: 'worker-init-failed',
  initErrored: 'worker-init-failed',
  timedOut: 'worker-init-timeout',
}

const results = {}

globalThis.Worker = undefined
delete globalThis.Worker
results.noWorker = await outcome(remoteBaker)

globalThis.Worker = class ThrowingWorker { constructor() { throw new Error('worker construction refused') } }
results.constructFailed = await outcome(remoteBaker)

globalThis.Worker = workerReplying((w) => w.onmessage({ data: { type: 'ready', ok: false, res: 0 } }))
results.initFailed = await outcome(remoteBaker)

globalThis.Worker = workerReplying((w) => w.onerror({ message: 'module script failed' }))
results.initErrored = await outcome(remoteBaker)

globalThis.Worker = silentWorker
fastReadyTimeout = true
results.timedOut = await outcome(remoteBaker)
fastReadyTimeout = false

globalThis.Worker = workerReplying((w) => w.onmessage({ data: { type: 'ready', ok: true, res: 4 } }))
const success = await outcome(remoteBaker)
const pendingAfterSuccess = success.leftoverReadyTimers
const successBaker = success.resolved
const successIsRemote = !!successBaker && successBaker.remote === true

delete globalThis.Worker

let pass = true
const codes = []
for (const [name, expected] of Object.entries(EXPECTED)) {
  const got = results[name]
  const ok = got.code === expected
  codes.push(got.code)
  pass &&= ok
  console.log(`scenario ${name}: code=${got.code} expected=${expected} resolved=${'resolved' in got} -> ${ok ? 'ok' : 'FAIL'}`)
}

const distinct = new Set(codes).size === 4
pass &&= distinct
console.log(`distinct failure codes across the four failure paths (no-worker, construct, init, timeout): ${distinct}`)
console.log(`successful init: remote=${successIsRemote} pendingReadyTimersAfterSuccess=${pendingAfterSuccess}`)
pass &&= successIsRemote && pendingAfterSuccess === 0

console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(pass ? 0 : 1)
