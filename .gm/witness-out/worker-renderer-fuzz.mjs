import { createWorkerRenderer } from '../../client/core/WorkerRenderer.js'

const workers = []
class FakeWorker {
  constructor(url, opts) {
    this.url = String(url)
    this.opts = opts || null
    this.posted = []
    this.terminated = false
    this.onmessage = null
    this.onerror = null
    workers.push(this)
  }
  postMessage(m) { this.posted.push(m) }
  terminate() { this.terminated = true }
}
globalThis.Worker = FakeWorker

function makeCanvas(allowTransfers) {
  let n = 0
  return {
    width: 120,
    height: 80,
    getBoundingClientRect() { return { width: 120, height: 80 } },
    transferControlToOffscreen() {
      n += 1
      if (n > allowTransfers) {
        const err = new Error('InvalidStateError: canvas control already transferred')
        err.name = 'InvalidStateError'
        throw err
      }
      return { tag: 'offscreen-' + n }
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const last = () => workers[workers.length - 1]
const emit = (w, msg) => w.onmessage({ data: msg })
const aliveFrom = (i) => workers.slice(i).filter((w) => !w.terminated).length

let failures = 0
function check(name, cond, detail) {
  if (cond) console.log('PASS ' + name)
  else { failures += 1; console.log('FAIL ' + name + ' :: ' + detail) }
}

async function boot(r) {
  const p = r.start()
  emit(last(), { type: 'ready', seq: 1, run: 1 })
  await p
}

async function main() {
  // A: drive the message surface with malformed and out-of-order inputs.
  const a = createWorkerRenderer(makeCanvas(1), { readyTimeoutMs: 200, onStats: () => {} })
  await boot(a)
  check('A1 ready accepted', a.getState().state === 'live', JSON.stringify(a.getState()))

  emit(last(), { type: 'frame', frame: 1 })
  let o = a.getOrder()
  check('A2 no seq and no run is accepted', o.unstampedAccepted === 1 && o.staleRunRejected === 0 && o.outOfOrderRejected === 0, JSON.stringify(o))

  emit(last(), { type: 'frame', seq: 2, run: 9999, frame: 2 })
  o = a.getOrder()
  check('A3 run from a generation that does not exist is accepted', o.workerRun === 9999 && o.seq === 2 && o.staleGenerationRejected === 0, JSON.stringify(o))

  emit(last(), { type: 'frame', seq: 3, run: 5, frame: 3 })
  o = a.getOrder()
  check('A4 lower run dropped', o.staleRunRejected === 1 && o.workerRun === 9999, JSON.stringify(o))

  emit(last(), { type: 'frame', seq: 2, run: 9999, frame: 4 })
  o = a.getOrder()
  check('A5 replayed seq dropped', o.outOfOrderRejected === 1, JSON.stringify(o))

  emit(last(), { type: 'frame', seq: 0, run: 9999 })
  o = a.getOrder()
  check('A6 seq 0 dropped', o.outOfOrderRejected === 2, JSON.stringify(o))

  emit(last(), { type: 'frame', seq: null, run: null })
  o = a.getOrder()
  check('A7 null seq and null run count as stamped zero, dropped as stale run', o.staleRunRejected === 2 && o.unstampedAccepted === 1, JSON.stringify(o))

  emit(last(), 'not-an-object')
  o = a.getOrder()
  check('A8 a non-object payload is accepted as unstamped', o.unstampedAccepted === 2, JSON.stringify(o))

  emit(last(), { type: 'ready', seq: 9, run: 9999 })
  check('A9 a second ready on one run is a no-op', a.getState().state === 'live', JSON.stringify(a.getState()))

  emit(last(), { type: 'stopped', seq: 10, run: 9999 })
  check('A10 stopped observed', a.getState().state === 'stopped' && a.getState().running === false, JSON.stringify(a.getState()))
  const st = a.getStats()
  check('A11 getStats after stopped keeps the last accepted frame', st.frame === 2 && st.order.run === 1, JSON.stringify(st))

  // B: stopped before ready.
  const b = createWorkerRenderer(makeCanvas(1), { readyTimeoutMs: 200 })
  let settled = null
  const pb = b.start().then(() => { settled = 'resolved' }, (e) => { settled = 'rejected:' + e.message })
  emit(last(), { type: 'stopped', seq: 1, run: 1 })
  await sleep(40)
  check('B1 stopped before ready settles start promptly', settled !== null && String(settled).indexOf('stopped') >= 0, 'settled=' + settled)
  await pb

  // C: a concurrent start cannot build a Worker it does not own.
  const cIdx = workers.length
  const c = createWorkerRenderer(makeCanvas(1), { readyTimeoutMs: 200 })
  const pc = c.start().catch(() => 'start1-settled')
  const pc2 = c.start().then(() => 'resolved', (e) => 'rejected:' + e.message)
  await sleep(10)
  const made = workers.length - cIdx
  check('C1 a concurrent start constructs no second Worker', made === 1 && aliveFrom(cIdx) === 1, 'made=' + made + ' alive=' + aliveFrom(cIdx))
  const second = await pc2
  check('C2 the concurrent start is refused and names the owning run', String(second).indexOf('run 1 is starting') >= 0, String(second))
  await pc

  // D: a stop waiter is owned by the run that stopped.
  const dIdx = workers.length
  const d = createWorkerRenderer(makeCanvas(2), { readyTimeoutMs: 200 })
  await boot(d)
  const w1 = last()
  const stopP = d.stop()
  const refusedStart = await d.start().then(() => 'resolved', (e) => 'rejected:' + e.message)
  const madeWhileStopping = workers.length - dIdx
  check('D1 a start while run 1 is stopping builds no second Worker', madeWhileStopping === 1 && last() === w1, 'made=' + madeWhileStopping)
  check('D2 that start is refused and names the owning run', String(refusedStart).indexOf('run 1 is stopping') >= 0, String(refusedStart))
  const stopRes = await stopP
  check('D3 the run-1 stop waiter is settled by run 1 alone', stopRes.ok === true && stopRes.reason === 'stopped' && stopRes.message && stopRes.message.type === 'stop-terminated', JSON.stringify(stopRes))
  check('D4 run 1 released its own Worker', w1.terminated === true, 'w1.terminated=' + w1.terminated)
  await boot(d)
  const w2 = last()
  check('D5 the restart got its own Worker', w2 !== w1 && workers.length - dIdx === 2, 'w2 === w1')
  emit(w1, { type: 'stopped', seq: 2, run: 1 })
  check('D6 a message from the dead run cannot move run 2', d.getState().state === 'live' && d.getOrder().run === 2, JSON.stringify(d.getState()) + ' ' + JSON.stringify(d.getOrder()))

  // E: order counters keep a previous run disorder.
  const e = createWorkerRenderer(makeCanvas(3), { readyTimeoutMs: 200 })
  await boot(e)
  emit(last(), { type: 'frame', seq: 5, run: 1 })
  emit(last(), { type: 'frame', seq: 3, run: 1 })
  const beforeRestart = e.getOrder()
  check('E1 disorder recorded on run 1', beforeRestart.outOfOrderRejected === 1 && beforeRestart.run === 1, JSON.stringify(beforeRestart))
  await e.stop()
  await sleep(320)
  await boot(e)
  const afterRestart = e.getOrder()
  check('E2 a dead run disorder is unreachable from the new run', afterRestart.outOfOrderRejected === 0 && afterRestart.run === 2, JSON.stringify(afterRestart))

  await sleep(400)
  console.log(failures === 0 ? 'RESULT: PASS' : 'RESULT: FAIL (' + failures + ')')  
  process.exitCode = failures === 0 ? 0 : 1
}

main()
