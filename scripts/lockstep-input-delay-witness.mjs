import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { createLockstepGameLoop, INPUT_RETAIN_TICKS } = await import(pathToFileURL(path.join(ROOT, 'src/netcode/LockstepGameLoop.js')).href)

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const build = (options) => {
  const transport = { submitLocalInput() {}, submitDropReport() {} }
  const tickSystem = { onTick() {}, start() {}, stop() {} }
  return createLockstepGameLoop({ tickSystem, transport, roster: ['a', 'b'], localPeerId: 'a', simulate() {}, getLocalInput: () => null, options, now: () => 0 })
}
const refusal = (options) => {
  try { build(options); return null } catch (e) { return e.message }
}

check('the default options construct', refusal({}) === null)
check('inputDelayTicks equal to INPUT_RETAIN_TICKS constructs', refusal({ inputDelayTicks: INPUT_RETAIN_TICKS }) === null, `INPUT_RETAIN_TICKS=${INPUT_RETAIN_TICKS}`)

const over = refusal({ inputDelayTicks: INPUT_RETAIN_TICKS + 1 })
check('inputDelayTicks one above INPUT_RETAIN_TICKS is refused by name', over !== null && over.includes(`must be <= INPUT_RETAIN_TICKS (${INPUT_RETAIN_TICKS})`), over ?? 'accepted')
check('an infinite inputDelayTicks is refused by the same bound', refusal({ inputDelayTicks: Infinity }) !== null)
check('an inputDelayTicks of 0 is refused', refusal({ inputDelayTicks: 0 }) !== null)
check('a negative inputDelayTicks is refused', refusal({ inputDelayTicks: -1 }) !== null)

for (const [label, value] of [['NaN', NaN], ['undefined', undefined], ['the string "3"', '3'], ['the fraction 2.5', 2.5]]) {
  const msg = refusal({ inputDelayTicks: value })
  check(`inputDelayTicks ${label} is refused (not a whole tick count)`, msg !== null && /integer/.test(msg), msg ?? 'accepted')
}

for (const [label, value] of [['NaN', NaN], ['undefined', undefined], ['the fraction 1.5', 1.5], ['0', 0]]) {
  const msg = refusal({ maxCatchUpTicks: value })
  check(`maxCatchUpTicks ${label} is refused`, msg !== null, msg ?? 'accepted')
}

for (const [label, value] of [['NaN', NaN], ['undefined', undefined], ['the fraction 2.5', 2.5], ['0', 0]]) {
  const msg = refusal({ stallTicks: value })
  check(`stallTicks ${label} is refused (a NaN would never drop a silent peer)`, msg !== null, msg ?? 'accepted')
}

const peerTransport = { submitLocalInput() {}, submitDropReport() {} }
const captured = createLockstepGameLoop({ tickSystem: { onTick() {}, start() {}, stop() {} }, transport: peerTransport, roster: ['a', 'b'], localPeerId: 'a', simulate() {}, getLocalInput: () => null, options: { inputDelayTicks: 3 }, now: () => 0 })
captured.start()
peerTransport.onRemoteInput('b', INPUT_RETAIN_TICKS + 1, null)
check('an input more than INPUT_RETAIN_TICKS ticks ahead is counted as future and ignored', captured.getStats().futureInputsIgnored === 1, `futureInputsIgnored=${captured.getStats().futureInputsIgnored}`)
peerTransport.onRemoteInput('b', INPUT_RETAIN_TICKS, null)
check('an input exactly INPUT_RETAIN_TICKS ticks ahead is kept, not counted as future', captured.getStats().futureInputsIgnored === 1, `futureInputsIgnored=${captured.getStats().futureInputsIgnored}`)

const failed = checks.filter((c) => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`)
  process.exit(1)
}
console.log(`RESULT: PASS createLockstepGameLoop refuses an inputDelayTicks above INPUT_RETAIN_TICKS (${INPUT_RETAIN_TICKS}) and any non-integer or out-of-range delay, and ignores inputs more than INPUT_RETAIN_TICKS ahead`)
process.exit(0)
