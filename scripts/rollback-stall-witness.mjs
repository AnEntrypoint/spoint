import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { createRollbackGameLoop } = await import(pathToFileURL(path.join(ROOT, 'src/netcode/RollbackGameLoop.js')).href)

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const MAX = 12
const WINDOW = 64

const harness = (options = {}) => {
  const tickSystem = { cb: null, onTick(cb) { this.cb = cb }, start() {}, stop() {} }
  const transport = { submitLocalInput() {}, submitChecksum() {}, submitDropReport() {} }
  const rollback = { windowSize: WINDOW, save() {}, restore() {}, has() { return true }, get() { return null } }
  const simulated = []
  const loop = createRollbackGameLoop({
    tickSystem, transport, rollback, roster: ['a', 'b'], localPeerId: 'a',
    simulate: (t, dt, inputs, resim) => { simulated.push({ t, resim }) },
    getLocalInput: () => null,
    options: { maxRollbackTicks: MAX, inputDelayTicks: 1, checksumIntervalTicks: 1000, ...options },
  })
  loop.start()
  const drive = (n) => { for (let i = 1; i <= n; i++) tickSystem.cb(i, 1 / 60) }
  return { loop, transport, drive, simulated }
}

{
  const h = harness()
  h.drive(40)
  const stats = h.loop.getStats()
  check('with no remote input the loop stops at maxRollbackTicks ahead of the remote', h.loop.simTick === MAX, `simTick=${h.loop.simTick} max=${MAX}`)
  const highest = Math.max(...h.simulated.map((s) => s.t))
  check('no simulation step runs past the bound: the highest simulated tick is maxRollbackTicks', highest === MAX, `highest=${highest}`)
  check('every driver tick is either a step, a stall or a time-sync yield', stats.ticksSimulated + stats.stalls + stats.timeSyncYields === 40 && stats.stalls > 0, `steps=${stats.ticksSimulated} stalls=${stats.stalls} yields=${stats.timeSyncYields}`)
}

{
  const h = harness()
  h.drive(40)
  for (let t = 1; t <= 5; t++) h.transport.onRemoteInput('b', t, null)
  h.drive(40)
  check('a remote confirmed through tick 5 lifts the stall to 5 + maxRollbackTicks', h.loop.simTick === 5 + MAX, `simTick=${h.loop.simTick} expected=${5 + MAX}`)
  check('the lift is exact: the tick one past the bound stays stalled', h.loop.simTick + 1 - 5 > MAX, `simTick+1-remote=${h.loop.simTick + 1 - 5}`)
}

{
  const h = harness()
  h.drive(MAX)
  const before = h.loop.simTick
  h.transport.onRemoteInput('b', 1, { forward: true })
  h.drive(1)
  const stats = h.loop.getStats()
  check('a misprediction from tick 1 rolls back once, with depth equal to the ticks run before it, within maxRollbackTicks', stats.rollbacks === 1 && stats.maxRollbackDepth === before && before <= MAX, `rollbacks=${stats.rollbacks} depth=${stats.maxRollbackDepth} before=${before}`)
  const resims = h.simulated.filter((s) => s.resim)
  check('the rollback re-simulates from the mispredicted tick with resim set', resims.length === before && resims[0].t === 1, `resims=${resims.length}`)
}

{
  let refused = null
  try { harness({ maxRollbackTicks: WINDOW - 1, inputDelayTicks: 1 }) } catch (e) { refused = e.message }
  check('maxRollbackTicks plus inputDelayTicks at the window size is refused at construction', refused !== null && /must be < state ring window/.test(refused), refused ?? 'accepted')
}

const failed = checks.filter((c) => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`)
  process.exit(1)
}
console.log(`RESULT: PASS RollbackGameLoop stalls with no simulation step once the tick it would run is more than maxRollbackTicks (${MAX}) ahead of the slowest remote, lifts exactly at the bound, and rolls back within maxRollbackTicks in the scenario checked`)
process.exit(0)
