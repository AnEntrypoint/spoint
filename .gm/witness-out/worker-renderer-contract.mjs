// CONTRACTTEST witness: drive the real client/core/WorkerRenderer.js against a producer that
// mirrors client/workers/OffscreenRenderWorker.js message-for-message, and assert the consumer's
// public state matches the producer's real state.
import { createWorkerRenderer } from '../../client/core/WorkerRenderer.js'

function dimsAreValid(width, height) {
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
}

// Mirror of the producer: post() stamps seq+run on every outbound message (:16), and the only
// outbound types are ready/frame/stopped/error (:94,:56,:118,:20).
class ProducerWorker {
  constructor() {
    this.seq = 0
    this.run = 0
    this.running = false
    this.renderer = null
    this.onmessage = null
    this.onerror = null
    this.terminated = false
    this.inbox = []
  }
  post(message) { this.onmessage({ data: { seq: ++this.seq, run: this.run, ...message } }) }
  postError(code, message) { this.post({ type: 'error', code, message }) }
  postMessage(m) {
    this.inbox.push(m)
    switch (m.type) {
      case 'init':
        if (this.running) { this.postError('init-while-running', 'init refused: already running'); break }
        if (!m.canvas) { this.postError('init-no-canvas', 'init refused: msg.canvas is missing'); break }
        if (!dimsAreValid(m.width, m.height)) { this.postError('bad-init-payload', 'init refused: bad dims'); break }
        this.renderer = {}
        this.running = true
        this.run++
        this.post({ type: 'ready' })
        break
      case 'resize':
        if (!dimsAreValid(m.width, m.height)) { this.postError('bad-resize-payload', 'resize refused: bad dims'); break }
        if (!this.renderer) { this.postError('resize-no-render-target', 'resize ignored: no renderer'); break }
        break
      case 'stop':
        this.running = false
        this.renderer = null
        this.post({ type: 'stopped' })
        break
      default:
        this.postError('unknown-message-type', 'unknown message type: ' + String(m.type))
    }
  }
  terminate() { this.terminated = true }
}
globalThis.Worker = ProducerWorker

function makeCanvas(transfers, offscreen) {
  let n = 0
  return {
    width: 320,
    height: 180,
    getBoundingClientRect() { return { width: 320, height: 180 } },
    transferControlToOffscreen() {
      n += 1
      if (n > transfers) throw new Error('InvalidStateError: canvas control already transferred')
      return offscreen === undefined ? { tag: 'offscreen-' + n } : offscreen
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
function check(name, cond, detail) {
  if (cond) console.log('PASS ' + name)
  else { failures += 1; console.log('FAIL ' + name + ' :: ' + detail) }
}

async function main() {
  // C1: the producer stamps seq+run on every message, so no unstamped message is ever delivered.
  const a = createWorkerRenderer(makeCanvas(1), { readyTimeoutMs: 200, onStats: () => {} })
  await a.start()
  check('C1 a stamped producer never yields an unstamped acceptance', a.getOrder().unstampedAccepted === 0, JSON.stringify(a.getOrder()))

  // C2-C4: the producer refuses a bad resize (:101) and keeps rendering; the consumer must agree.
  a.resize(0, 0)
  const st = a.getState()
  check('C2 a refused resize leaves the run live', st.state !== 'error' && a.isRunning() === true, JSON.stringify(st))
  check('C3 a refused resize is not the run last error', a.getLastError() === null, JSON.stringify(a.getLastError()))
  check('C4 a refused resize does not mark the run stale', a.getStats().stale === false, JSON.stringify(a.getStats()))

  // C5: an error before ready is terminal -- regression guard on the branch C2-C4 reclassify.
  const b = createWorkerRenderer(makeCanvas(1, null), { readyTimeoutMs: 200 })
  const settled = await b.start().then(() => 'resolved', (e) => 'rejected:' + e.message)
  check('C5 an init refusal still fails start()', String(settled).indexOf('worker init error') >= 0, settled)
  check('C5b an init refusal is the run last error', b.getLastError() !== null && b.getLastError().code === 'init-no-canvas', JSON.stringify(b.getLastError()))

  // C6: the producer's stopped still transitions the consumer.
  const c = createWorkerRenderer(makeCanvas(1), { readyTimeoutMs: 200 })
  await c.start()
  const stopRes = await c.stop()
  check('C6 the producer stopped message still settles stop()', stopRes.ok === true && c.getState().state === 'stopped', JSON.stringify(stopRes) + ' ' + JSON.stringify(c.getState()))

  await sleep(50)
  console.log(failures === 0 ? 'RESULT: PASS' : 'RESULT: FAIL (' + failures + ')')
  process.exitCode = failures === 0 ? 0 : 1
}

main()
