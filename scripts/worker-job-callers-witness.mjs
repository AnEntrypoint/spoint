import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve, basename } from 'node:path'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SRC = resolve(ROOT, 'packages/mapspinner/src')
const ATMOSPHERE_WORKER = 'atmosphere-lut-worker.js'
const HPF_WORKER = 'hpf-bake-worker.js'
const SURFACE_WORKER = 'surface-texture-worker.js'
const BOOT_TIMEOUT_MS = 180000
const TEXTURE_BASE = 'file:///stub/textures/'

const failures = []
function check(label, ok, detail) {
  console.log(`[worker-job-callers] ${label}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
  if (!ok) failures.push(label)
}

const replies = new Map()
const spawned = []
class StubWorker {
  constructor(url) {
    this.name = basename(new URL(String(url)).pathname)
    this.terminated = false
    spawned.push(this.name)
  }
  postMessage() {
    const reply = replies.get(this.name) ?? { ok: false, error: `no stub reply for ${this.name}` }
    setTimeout(() => { if (this.onmessage) this.onmessage({ data: reply }) }, 0)
  }
  terminate() { this.terminated = true }
}
globalThis.Worker = StubWorker

const realWarn = console.warn
let warnings = []
function captureWarnings() {
  warnings = []
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
}
function restoreWarnings() { console.warn = realWarn }

await installSpecifierHooks()

const unhandled = []
process.on('unhandledRejection', (e) => { unhandled.push(String(e?.code ?? e?.name ?? e?.message ?? e)) })

const FAILURE_ATMOSPHERE = 'transmittance bake ran out of memory'
const FAILURE_HPF = 'hpf bake ran out of memory'
const FAILURE_SURFACE = 'surface decode failed'

const atmosphere = await import(pathToFileURL(resolve(SRC, 'atmosphere-lut-job.js')).href)

replies.set(ATMOSPHERE_WORKER, { ok: false, error: FAILURE_ATMOSPHERE })
captureWarnings()
let lutFallback
try {
  lutFallback = await atmosphere.bakeAtmosphereLUTs()
} catch (e) {
  lutFallback = { thrown: e }
} finally {
  restoreWarnings()
}
check('atmosphere-lut: ok:false resolves through the in-page bake', Boolean(lutFallback && lutFallback.trans && lutFallback.scat && !lutFallback.thrown), lutFallback && lutFallback.thrown ? String(lutFallback.thrown.message) : '')
check('atmosphere-lut: ok:false is reported with its code and message', warnings.some((w) => w.includes('WORKER_JOB_FAILED') && w.includes(FAILURE_ATMOSPHERE)), `warnings=${warnings.length}`)

replies.set(ATMOSPHERE_WORKER, { ok: true, trans: 'T', scat: 'S' })
captureWarnings()
let lutWorker
try {
  lutWorker = await atmosphere.bakeAtmosphereLUTs()
} catch (e) {
  lutWorker = { thrown: e }
} finally {
  restoreWarnings()
}
check('atmosphere-lut: ok:true still resolves through the worker', lutWorker.trans === 'T' && lutWorker.scat === 'S', JSON.stringify(lutWorker.thrown ? String(lutWorker.thrown.message) : lutWorker))
check('atmosphere-lut: ok:true raises no fallback warning', warnings.length === 0, `warnings=${warnings.length}`)

const planet = await import(pathToFileURL(resolve(SRC, 'tsl/planet-tsl.js')).href)
const renderer = { isWebGPURenderer: true, domElement: { width: 1, height: 1 } }

const savedGlobals = {
  fetch: globalThis.fetch,
  createImageBitmap: globalThis.createImageBitmap,
  OffscreenCanvas: globalThis.OffscreenCanvas,
}
let fetched = []
function stubDecodeGlobals() {
  fetched = []
  globalThis.fetch = async (url) => { fetched.push(String(url)); return new Response('', { status: 404 }) }
  globalThis.createImageBitmap = async () => { throw new Error('stub createImageBitmap') }
  globalThis.OffscreenCanvas = class {}
}
function restoreGlobals() {
  globalThis.fetch = savedGlobals.fetch
  globalThis.createImageBitmap = savedGlobals.createImageBitmap
  globalThis.OffscreenCanvas = savedGlobals.OffscreenCanvas
}

async function bootPlanet() {
  const scene = { add() {}, remove() {}, backgroundNode: null }
  let timer
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('boot timed out')), BOOT_TIMEOUT_MS) })
  try {
    await Promise.race([planet.initMapspinnerPlanetTSL(renderer, scene, { water: false, sky: false, surfaceTexturesBaseUrl: TEXTURE_BASE }), timeout])
    return { resolved: true }
  } catch (e) {
    return { resolved: false, code: e?.code ?? null, message: String(e?.message ?? e) }
  } finally {
    clearTimeout(timer)
  }
}

const settle = () => new Promise((r) => setTimeout(r, 250))

replies.set(HPF_WORKER, { ok: false, error: FAILURE_HPF })
replies.set(ATMOSPHERE_WORKER, { ok: false, error: FAILURE_ATMOSPHERE })
replies.set(SURFACE_WORKER, { ok: false, error: FAILURE_SURFACE })
stubDecodeGlobals()
captureWarnings()
const failedBoot = await bootPlanet()
await settle()
restoreWarnings()
restoreGlobals()
check('planet-tsl: ok:false HPF worker boots through the in-page HPF bake', failedBoot.resolved === true, JSON.stringify(failedBoot))
check('planet-tsl: ok:false HPF worker is reported with its code and message', warnings.some((w) => w.includes('WORKER_JOB_FAILED') && w.includes(FAILURE_HPF)), `warnings=${warnings.length}`)
check('planet-tsl: ok:false surface decode falls back to decodeSurfaceTextureSet', fetched.some((u) => u.startsWith(TEXTURE_BASE)), `fetched=${fetched.length}`)
check('planet-tsl: ok:false surface decode is reported with its code and message', warnings.some((w) => w.includes('WORKER_JOB_FAILED') && w.includes(FAILURE_SURFACE)), `warnings=${warnings.length}`)

replies.set(HPF_WORKER, { ok: true, data: new Float32Array(4) })
replies.set(ATMOSPHERE_WORKER, { ok: false, error: FAILURE_ATMOSPHERE })
replies.set(SURFACE_WORKER, { ok: true, albAll: new Uint8Array(4), nrmAll: new Uint8Array(4) })
stubDecodeGlobals()
captureWarnings()
const okBoot = await bootPlanet()
await settle()
restoreWarnings()
restoreGlobals()
check('planet-tsl: ok:true workers boot without a failure', okBoot.resolved === true, JSON.stringify(okBoot))
check('planet-tsl: ok:true HPF and surface workers raise no fallback warning', warnings.every((w) => w.includes('atmosphere LUT worker')), `warnings=${warnings.length}`)
check('planet-tsl: ok:true surface reply skips the in-page decode', fetched.length === 0, `fetched=${fetched.length}`)
check('planet-tsl: the HPF and surface workers were started', spawned.includes(HPF_WORKER) && spawned.includes(SURFACE_WORKER), `spawned=${spawned.join(',')}`)

check('no promise rejection is left unhandled', unhandled.length === 0, unhandled.length ? `unhandled=${unhandled.join(',')}` : '')

if (failures.length) {
  console.log(`RESULT: FAIL ${failures.length} check(s): ${failures.join('; ')}`)
  process.exit(1)
}
console.log('RESULT: PASS every worker-job caller takes its in-page fallback on ok:false, reports the WorkerJobError code and message, and still resolves through the worker on ok:true')
process.exit(0)
