import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { macrotaskYield } from '../client/core/macrotaskYield.js'

const REPS = 5
const VEG_SOURCE = 'C:/dev/spoint/client/core/Vegetation.js'

delete globalThis.requestAnimationFrame
Object.defineProperty(globalThis, 'document', { value: { hidden: true }, configurable: true })

const RealMessageChannel = globalThis.MessageChannel
let channelsOpened = 0
globalThis.MessageChannel = class extends RealMessageChannel {
  constructor() { super(); channelsOpened++ }
}
let setTimeoutCalls = 0
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = function (...args) { setTimeoutCalls++; return realSetTimeout.apply(this, args) }

const failures = []
const expect = (ok, label) => { if (!ok) failures.push(label) }

expect(typeof globalThis.requestAnimationFrame === 'undefined', 'requestAnimationFrame still defined')

const order = []
for (let i = 0; i < REPS; i++) { await macrotaskYield(); order.push(i) }
expect(order.every((v, i) => v === i), 'sequential yields resolved out of order')

let microtaskBeforeYield = 0
const pending = macrotaskYield()
queueMicrotask(() => { microtaskBeforeYield++ })
await pending
expect(microtaskBeforeYield === 1, 'yield resolved before the queued microtask: not a macrotask')

let deferredPastTwoFrames = 0
const frameRace = macrotaskYield().then(() => { deferredPastTwoFrames++ })
for (let i = 0; i < 2; i++) await macrotaskYield()
expect(deferredPastTwoFrames === 1, 'first yield did not settle before two later yields')

globalThis.setTimeout = realSetTimeout
globalThis.MessageChannel = RealMessageChannel

const src = readFileSync(VEG_SOURCE, 'utf8')
const rafInVegetation = (src.match(/requestAnimationFrame/g) || []).length
const macroCalls = (src.match(/macrotaskYield\(/g) || []).length
expect(rafInVegetation === 0, 'client/core/Vegetation.js still references requestAnimationFrame')
expect(macroCalls === 2, 'client/core/Vegetation.js does not call macrotaskYield at both slice yields')

console.log('[veg-macrotask-yield] raf absent, document.hidden true: ' + REPS + ' sequential yield(s) resolved in order')
console.log('[veg-macrotask-yield] macrotask ordering: ' + microtaskBeforeYield + ' microtask(s) drained before their yield')
console.log('[veg-macrotask-yield] delivery: messageChannel=' + channelsOpened + ' setTimeout=' + setTimeoutCalls)
console.log('[veg-macrotask-yield] source pin: requestAnimationFrame=' + rafInVegetation + ' macrotaskYield calls=' + macroCalls)
console.log('[veg-macrotask-yield] RESULT: ' + (failures.length === 0 ? 'PASS' : 'FAIL') + ' (' + failures.length + ' failure(s))')
for (const f of failures) console.log('[veg-macrotask-yield] [FAIL] ' + f)
process.exit(failures.length === 0 ? 0 : 1)
