// Witness: the vegetation prewarm yield is a real macrotask -- MessageChannel, not rAF, not a
// microtask -- and client/core/Vegetation.js still uses it at both of its slice yields.
//
// Silence is not an acceptable failure mode: every read and every import is guarded, the counters
// are initialised before anything can throw, and the verdict line is printed from one place after
// the run, so a missing module or a missing source file reports itself as a named FAIL instead of
// an uncaught throw with empty stdout. The verdict is set with process.exitCode and never
// process.exit(), because process.exit() drops stdout still buffered in a pipe.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const TAG = '[veg-macrotask-yield]'
const REPS = 5
const VEG_SOURCE = fileURLToPath(new URL('../client/core/Vegetation.js', import.meta.url))

const failures = []
const checks = []
const check = (label, ok, detail) => {
  checks.push(label)
  if (!ok) failures.push(detail || label)
}
const say = (line) => console.log(TAG + ' ' + line)

let yieldsRequested = 0
let channelsOpened = 0
let setTimeoutCalls = 0
let microtaskBeforeYield = 0
let orderedYields = 0
let rafInVegetation = 0
let macroCalls = 0

async function run() {
  delete globalThis.requestAnimationFrame
  check('requestAnimationFrame is absent', typeof globalThis.requestAnimationFrame === 'undefined',
    'requestAnimationFrame still defined, so the hidden-tab claim was not exercised')
  try {
    Object.defineProperty(globalThis, 'document', { value: { hidden: true }, configurable: true })
  } catch (e) {
    failures.push('document stub refused: ' + e.message)
  }

  const RealMessageChannel = globalThis.MessageChannel
  globalThis.MessageChannel = class extends RealMessageChannel {
    constructor() { super(); channelsOpened++ }
  }
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = function (...args) { setTimeoutCalls++; return realSetTimeout.apply(this, args) }

  // Dynamic, not static: a deleted or unparseable module is a recorded failure, not an ESM link
  // error that kills the process before a single line is printed.
  let macrotaskYield = null
  try {
    ;({ macrotaskYield } = await import('../client/core/macrotaskYield.js'))
  } catch (e) {
    failures.push('client/core/macrotaskYield.js did not import: ' + (e && e.message ? e.message : String(e)))
    return
  }
  check('client/core/macrotaskYield.js exports macrotaskYield', typeof macrotaskYield === 'function',
    'client/core/macrotaskYield.js exported no macrotaskYield function')

  const yieldOnce = async () => { yieldsRequested++; await macrotaskYield() }

  const order = []
  for (let i = 0; i < REPS; i++) { await yieldOnce(); order.push(i); orderedYields++ }
  check('sequential yields resolve in order', order.every((v, i) => v === i),
    'sequential yields resolved out of order')

  const pending = yieldOnce()
  queueMicrotask(() => { microtaskBeforeYield++ })
  await pending
  check('a queued microtask drains before its yield resolves', microtaskBeforeYield === 1,
    'yield resolved before the queued microtask: not a macrotask')

  let deferredPastTwoYields = 0
  const race = yieldOnce().then(() => { deferredPastTwoYields++ })
  for (let i = 0; i < 2; i++) await yieldOnce()
  check('a yield settles before two later yields', deferredPastTwoYields === 1,
    'first yield did not settle before two later yields')

  check('every yield opened one MessageChannel', channelsOpened === yieldsRequested,
    'delivery: ' + channelsOpened + ' channel(s) for ' + yieldsRequested + ' yield(s), so a yield did not go through MessageChannel')
  check('no yield fell back to setTimeout', setTimeoutCalls === 0,
    'setTimeout used ' + setTimeoutCalls + ' time(s), so a yield took the 4 ms-clamped fallback')

  globalThis.setTimeout = realSetTimeout
  globalThis.MessageChannel = RealMessageChannel

  let src = ''
  try {
    src = readFileSync(VEG_SOURCE, 'utf8')
  } catch (e) {
    failures.push('client/core/Vegetation.js unreadable: ' + (e && e.message ? e.message : String(e)))
    return
  }
  rafInVegetation = (src.match(/requestAnimationFrame/g) || []).length
  macroCalls = (src.match(/macrotaskYield\(/g) || []).length
  check('client/core/Vegetation.js has no requestAnimationFrame', rafInVegetation === 0,
    'client/core/Vegetation.js still references requestAnimationFrame ' + rafInVegetation + ' time(s)')
  // One yield per build phase boundary (generate, LOD chain, between species) and one per prewarm
  // chunk: a millisecond budget checked between species could not cut a species costing more than
  // a frame, so the yield sits at each phase boundary instead.
  check('client/core/Vegetation.js yields at every build phase, not only between species', macroCalls >= 4,
    'client/core/Vegetation.js calls macrotaskYield ' + macroCalls + ' time(s), fewer than the 4 phase boundaries')
}

try {
  await run()
} catch (e) {
  failures.push('threw: ' + (e && e.message ? e.message : String(e)))
}

say('raf absent, document.hidden true: ' + orderedYields + ' sequential yield(s) resolved in order')
say('macrotask ordering: ' + microtaskBeforeYield + ' microtask(s) drained before their yield')
say('delivery: messageChannel=' + channelsOpened + ' setTimeout=' + setTimeoutCalls)
say('source pin: requestAnimationFrame=' + rafInVegetation + ' macrotaskYield calls=' + macroCalls)
say('RESULT: ' + (failures.length === 0 ? 'PASS' : 'FAIL') + ' (' + failures.length + ' failure(s) over ' + checks.length + ' check(s))')
for (const f of failures) say('[FAIL] ' + f)
process.exitCode = failures.length === 0 ? 0 : 1
