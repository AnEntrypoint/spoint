// Row HALTING-n-r101-2.
//
// Drives the REAL module client/core/CacheRevalidationSweep.js under Node with three injected
// surfaces: a fake scheduler (no streaming work runs), an injected now fn, and a fake timer clock
// whose setTimeout/setInterval/clearTimeout/clearInterval replace the globals the module resolves
// at call time. That makes the 15 s first-sweep probe created by start() observable instantly.
//
// RED on the unfixed module: stop() cannot clear that probe, so a sweep started and stopped inside
// 15 s still runs one sweep after stop(), and no sweep prints anything.
// GREEN on the fixed module: the probe is cleared with the interval, and every sweep prints one
// line naming sweeps/enqueued/revalidated/changed/errors.

const realSetTimeout = globalThis.setTimeout
const realSetInterval = globalThis.setInterval

let clock = 0
let seq = 0
const timers = new Map()

globalThis.setTimeout = (fn, ms = 0) => {
  const id = ++seq
  timers.set(id, { at: clock + Number(ms || 0), fn, every: null })
  return id
}
globalThis.setInterval = (fn, ms = 0) => {
  const id = ++seq
  timers.set(id, { at: clock + Number(ms || 0), fn, every: Number(ms || 0) })
  return id
}
const dropTimer = (id) => { timers.delete(id) }
globalThis.clearTimeout = dropTimer
globalThis.clearInterval = dropTimer

function advanceTo(target) {
  clock = target
  for (const entry of [...timers.entries()]) {
    const [id, t] = entry
    if (!timers.has(id)) continue
    if (t.at > clock) continue
    if (t.every === null) timers.delete(id)
    else t.at = clock + t.every
    t.fn()
  }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => realSetTimeout(r, 5))
}

const makeScheduler = () => {
  const jobs = []
  return { enqueue: (job) => { jobs.push(job) }, size: () => jobs.length, jobs }
}

let lines = []
const realLog = console.log
console.log = (...args) => { lines.push(args.map(String).join(' ')) }

const SWEEP_PREFIX = '[cache-revalidate] sweep '
const COUNTERS = ['sweeps=', 'enqueued=', 'revalidated=', 'changed=', 'errors=']

let fails = 0
let checks = 0
function check(name, got, want) {
  checks++
  const ok = got === want
  if (!ok) fails++
  realLog(`${ok ? 'PASS' : 'FAIL'} ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)
}

const sweepLines = () => lines.filter((l) => l.includes(SWEEP_PREFIX))

async function main() {
  const { createCacheRevalidationSweep } = await import(
    new URL('../client/core/CacheRevalidationSweep.js', import.meta.url).href
  )

  // (a) start() then stop() immediately: nothing may sweep once the clock passes 15 s.
  clock = 0
  timers.clear()
  lines = []
  const stopped = createCacheRevalidationSweep({ scheduler: makeScheduler(), now: () => clock, staleMs: 0 })
  stopped.start()
  stopped.stop()
  advanceTo(20000)
  await flush()
  check('a1 sweepOnce not called after stop', stopped.getStats().sweeps, 0)
  check('a2 no sweep line after stop', sweepLines().length, 0)
  check('a3 no timer left armed', timers.size, 0)
  check('a4 reports stopped', stopped.stopped, true)

  // (b) a sweep that does run prints one line naming every counter getStats() carries.
  clock = 0
  timers.clear()
  lines = []
  const live = createCacheRevalidationSweep({ scheduler: makeScheduler(), now: () => clock, staleMs: 0 })
  live.start()
  check('b0 running before stop', live.stopped, false)
  advanceTo(20000)
  await flush()
  check('b1 one sweep ran', live.getStats().sweeps, 1)
  const printed = sweepLines()
  check('b2 exactly one sweep line', printed.length, 1)
  const line = printed[0] || ''
  for (const key of COUNTERS) check(`b3 sweep line names ${key}`, line.includes(key), true)

  // The halting verdict: stop() itself prints one line carrying the same counters.
  lines = []
  live.stop()
  const verdicts = lines.filter((l) => l.includes('[cache-revalidate] stopped'))
  check('b4 stop prints one verdict line', verdicts.length, 1)
  for (const key of COUNTERS) check(`b5 verdict names ${key}`, (verdicts[0] || '').includes(key), true)
  check('b6 still stopped on second stop', (live.stop(), live.stopped), true)
  check('b7 second stop prints nothing', lines.filter((l) => l.includes('[cache-revalidate] stopped')).length, 1)

  // The recurring interval states a bound: it finishes itself at the sweep cap and says so.
  clock = 0
  timers.clear()
  lines = []
  const capped = createCacheRevalidationSweep({ scheduler: makeScheduler(), now: () => clock, staleMs: 0, maxSweeps: 2 })
  capped.start()
  advanceTo(15000)
  await flush()
  check('c1 first interval sweep ran', capped.getStats().sweeps, 1)
  check('c2 still armed before the cap', capped.stopped, false)
  advanceTo(300000)
  await flush()
  check('c3 cap sweep ran', capped.getStats().sweeps, 2)
  check('c4 stopped itself at the cap', capped.stopped, true)
  check('c5 cap verdict printed', lines.filter((l) => l.includes('[cache-revalidate] cap')).length, 1)
  check('c6 no timer left armed after cap', timers.size, 0)

  // restart() re-arms a finished sweep.
  clock = 0
  timers.clear()
  lines = []
  check('d1 restart re-arms', capped.restart(), true)
  check('d2 armed after restart', capped.stopped, false)
  check('d3 restart refused while armed', capped.restart(), false)
  advanceTo(20000)
  await flush()
  check('d4 restarted sweep ran', capped.getStats().sweeps, 3)
}

main().then(async () => {
  await flush()
  console.log = realLog
  globalThis.setTimeout = realSetTimeout
  globalThis.setInterval = realSetInterval
  console.log(`CHECKS ${checks} FAILS ${fails}`)
  console.log(`RESULT: ${fails === 0 ? 'PASS' : 'FAIL'}`)
  process.exitCode = fails === 0 ? 0 : 1
}).catch((e) => {
  console.log = realLog
  globalThis.setTimeout = realSetTimeout
  globalThis.setInterval = realSetInterval
  console.log(`WITNESS ERROR ${e && e.stack ? e.stack : e}`)
  console.log('RESULT: FAIL')
  process.exitCode = 1
})
