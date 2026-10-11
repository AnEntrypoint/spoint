// CHARTEST witness (client/core): characterize the SHIPPED producer by executing its real source.
//
// The CONTRACTTEST witness drives the consumer against a hand-written mirror of the worker. This one
// runs client/workers/OffscreenRenderWorker.js itself under a self/THREE stub, so every message the
// consumer receives was emitted by the shipped code. Facts that only the real source can show -- the
// frame clock gate, the messages a successful resize does NOT emit, run resetting per worker while the
// renderer's run id does not -- are pinned here. A change on either side moves a check.
import { readFileSync } from 'node:fs'
import { createWorkerRenderer } from '../../client/core/WorkerRenderer.js'

const WORKER_URL = new URL('../../client/workers/OffscreenRenderWorker.js', import.meta.url)
const CONSUMER_URL = new URL('../../client/core/WorkerRenderer.js', import.meta.url)
const workerSrc = readFileSync(WORKER_URL, 'utf8')
const consumerSrc = readFileSync(CONSUMER_URL, 'utf8')

let failures = 0
function check(name, cond, detail) {
  if (cond) console.log('PASS ' + name)
  else { failures += 1; console.log('FAIL ' + name + ' :: ' + detail) }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---------------------------------------------------------------- source facts
const OUTBOUND_TYPES = [...workerSrc.matchAll(/type: '([a-z-]+)'/g)].map((m) => m[1]).sort()
const REFUSAL_CODES = [...workerSrc.matchAll(/postError\('([a-z-]+)'/g)].map((m) => m[1]).sort()
const CLOCK_MS = Number((workerSrc.match(/STATS_POST_INTERVAL_MS = (\d+)/) || [])[1])
const BARE_POSTS = [...workerSrc.matchAll(/self\.postMessage\(/g)].length
const CONSUMER_BRANCHES = [...consumerSrc.matchAll(/msg\.type === '([a-z-]+)'/g)].map((m) => m[1]).sort()

check('A1 the shipped producer emits exactly ready/frame/stopped/error',
  eq(OUTBOUND_TYPES, ['error', 'frame', 'ready', 'stopped']), JSON.stringify(OUTBOUND_TYPES))
check('A2 the shipped producer refuses with exactly seven named codes',
  eq(REFUSAL_CODES, ['bad-init-payload', 'bad-resize-payload', 'handler-threw', 'init-no-canvas',
    'init-while-running', 'resize-no-render-target', 'unknown-message-type']), JSON.stringify(REFUSAL_CODES))
check('A3 the frame clock is a 250ms gate', CLOCK_MS === 250, String(CLOCK_MS))
check('A4 every outbound message carries the stamp: one post site, no bare postMessage',
  BARE_POSTS === 1, String(BARE_POSTS))
check('A5 the consumer branches on exactly the types the producer emits',
  eq(CONSUMER_BRANCHES, OUTBOUND_TYPES), JSON.stringify(CONSUMER_BRANCHES) + ' vs ' + JSON.stringify(OUTBOUND_TYPES))

// ------------------------------------------------------- run the shipped producer
function makeSelf() {
  const s = {
    outbox: [],
    queue: [],
    rafId: 0,
    postMessage(m) { s.outbox.push(m) },
    requestAnimationFrame(cb) { s.queue.push({ id: ++s.rafId, cb }); return s.rafId },
    cancelAnimationFrame(id) { s.queue = s.queue.filter((e) => e.id !== id) }
  }
  return s
}

const THREE = {
  Scene: class { constructor() { this.background = null } add() {} },
  Color: class { constructor(c) { this.c = c } },
  PerspectiveCamera: class {
    constructor(fov, aspect) { this.aspect = aspect; this.position = { set() {} } }
    lookAt() {}
    updateProjectionMatrix() {}
  },
  AmbientLight: class {},
  DirectionalLight: class { constructor() { this.position = { set() {} } } },
  TorusKnotGeometry: class {},
  MeshStandardMaterial: class {},
  Mesh: class { constructor() { this.rotation = { x: 0, y: 0 } } },
  WebGLRenderer: class {
    constructor() { this.info = { render: { calls: 0, triangles: 0 } }; this.disposed = false }
    setPixelRatio() {}
    setSize() {}
    render() { this.info.render.calls += 1; this.info.render.triangles += 2 }
    dispose() { this.disposed = true }
  }
}

const install = new Function('self', 'THREE', workerSrc.replace(/^import[^\n]*\n/, ''))

let live = null
class ShippedWorker {
  constructor() {
    const s = makeSelf()
    this.self = s
    this.terminated = false
    install(s, THREE)
    s.postMessage = (m) => { s.outbox.push(m); if (this.onmessage) this.onmessage({ data: m }) }
    live = this
  }
  postMessage(m) { this.self.onmessage({ data: m }) }
  terminate() { this.terminated = true }
  pump(nowMs) { for (const e of this.self.queue.splice(0, this.self.queue.length)) e.cb(nowMs) }
  types() { return this.self.outbox.map((m) => m.type) }
  last() { return this.self.outbox[this.self.outbox.length - 1] }
}
globalThis.Worker = ShippedWorker

function makeCanvas(transfers) {
  let n = 0
  return {
    width: 320,
    height: 180,
    getBoundingClientRect() { return { width: 320, height: 180 } },
    transferControlToOffscreen() {
      n += 1
      if (n > transfers) throw new Error('InvalidStateError: canvas control already transferred')
      return { tag: 'offscreen-' + n }
    }
  }
}

// ------------------------------------------------------------------ 1. bare producer
const raw = new ShippedWorker()
raw.postMessage({ type: 'stop' })
check('B1 stop with no init still answers stopped (worker:114)',
  eq(raw.types(), ['stopped']) && raw.last().run === 0, JSON.stringify(raw.self.outbox))

const rawInit = new ShippedWorker()
rawInit.postMessage({ type: 'init', canvas: {}, width: 320, height: 180, dpr: 1 })
check('B2 init stamps ready with seq 1 run 1 (worker:16, :91, :94)',
  eq(rawInit.types(), ['ready']) && rawInit.last().seq === 1 && rawInit.last().run === 1,
  JSON.stringify(rawInit.self.outbox))
rawInit.postMessage({ type: 'init', canvas: {}, width: 320, height: 180, dpr: 1 })
check('B3 a second init is refused init-while-running', rawInit.last().code === 'init-while-running', JSON.stringify(rawInit.last()))
rawInit.postMessage({ type: 'resize', width: 640, height: 360 })
check('B4 a successful resize emits nothing at all (worker:98-113)',
  eq(rawInit.types(), ['ready', 'error']), JSON.stringify(rawInit.types()))
rawInit.postMessage({ type: 'resize', width: 0, height: 0 })
check('B5 a zero-dim resize is refused bad-resize-payload', rawInit.last().code === 'bad-resize-payload', JSON.stringify(rawInit.last()))
rawInit.postMessage({ type: 'nope' })
check('B6 an unhandled type is refused unknown-message-type', rawInit.last().code === 'unknown-message-type', JSON.stringify(rawInit.last()))

// ------------------------------------------------- 2. the frame clock, as the worker runs it
const clocked = new ShippedWorker()
clocked.postMessage({ type: 'init', canvas: {}, width: 320, height: 180, dpr: 1 })
clocked.pump(16)
check('B7 the first rendered frame is UNREPORTED while the page clock is under 250ms',
  !clocked.types().includes('frame'), JSON.stringify(clocked.types()))
clocked.pump(300)
const f1 = clocked.last()
check('B8 the first reported frame is render #2 at ms 300 (worker:53, :57)',
  f1.type === 'frame' && f1.frame === 2 && f1.ms === 300 && f1.seq === 2 && f1.run === 1, JSON.stringify(f1))
check('B9 a frame message carries frame/ms/drawCalls/triangles and nothing else but the stamp',
  eq(Object.keys(f1).sort(), ['drawCalls', 'frame', 'ms', 'run', 'seq', 'triangles', 'type']), JSON.stringify(Object.keys(f1)))
clocked.pump(500)
check('B10 a frame inside the gate is silent', clocked.self.outbox.filter((m) => m.type === 'frame').length === 1, JSON.stringify(clocked.types()))
clocked.pump(600)
check('B11 reported frame numbers skip: #4 follows #2', clocked.last().frame === 4, JSON.stringify(clocked.last()))

// --------------------------------------- 3. shipped producer driving the real consumer
const a = createWorkerRenderer(makeCanvas(2), { readyTimeoutMs: 200, onStats: () => {} })
await a.start()
check('C1 the shipped producer never yields an unstamped acceptance',
  a.getOrder().unstampedAccepted === 0, JSON.stringify(a.getOrder()))
live.pump(16)
check('C2 the consumer reports no stats while the producer clock gate is shut',
  a.getStats().frame === null, JSON.stringify(a.getStats()))
live.pump(300)
const stats = a.getStats()
check('C3 the consumer stats object IS the producer frame message plus ageMs/state/order',
  stats.frame === 2 && stats.ms === 300 && stats.run === 1 && stats.type === 'frame' && stats.seq === 2 &&
  stats.order.run === 1 && stats.state === 'live', JSON.stringify(stats))
check('C4 the producer stamps are accepted in order: nothing is rejected',
  a.getOrder().outOfOrderRejected === 0 && a.getOrder().staleRunRejected === 0 &&
  a.getOrder().staleGenerationRejected === 0, JSON.stringify(a.getOrder()))

const before = a.getStats().frame
a.resize(640, 360)
check('C5 a successful resize moves no consumer state: the producer emitted nothing',
  a.getStats().frame === before && a.getLastError() === null, JSON.stringify(a.getStats()))
a.resize(0, 0)
check('C6 a refused resize is a lastRefusal that keeps the run live, not a lastError',
  a.getLastError() === null && a.isRunning() === true && a.getStats().stale === false,
  JSON.stringify(a.getState()) + ' ' + JSON.stringify(a.getLastError()))
live.pump(900)
check('C7 the render loop survives a refused resize: render #3 reports at ms 900',
  a.getStats().frame === 3, JSON.stringify(a.getStats()))

const stopRes = await a.stop()
check('C8 the producer stopped message settles the consumer stop()',
  stopRes.ok === true && a.getState().state === 'stopped', JSON.stringify(stopRes) + ' ' + JSON.stringify(a.getState()))
live.postMessage({ type: 'resize', width: 10, height: 10 })
check('C9 resize after stop is refused resize-no-render-target',
  live.last().code === 'resize-no-render-target', JSON.stringify(live.last()))

// --------------------------------- 4. two counters one property apart, as shipped
// A re-start makes a NEW worker, so the worker's init counter goes back to 1 while the renderer's
// run id keeps climbing: getStats().run and getStats().order.run are then different numbers.
await a.start()
live.pump(1200)
check('D1 the renderer run id keeps counting while the worker run counter resets to 1',
  a.getOrder().run === 2 && a.getStats().run === 1 && a.getStats().order.run === 2, JSON.stringify(a.getStats()))
await a.stop()

console.log(failures === 0 ? 'RESULT: PASS' : 'RESULT: FAIL (' + failures + ')')
process.exitCode = failures === 0 ? 0 : 1
