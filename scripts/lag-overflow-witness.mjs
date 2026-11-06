import assert from 'node:assert/strict'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { LagCompensator } = await import('../src/netcode/LagCompensator.js')

const TICK_RATE = 60
const SAMPLES = 300
const HISTORY_CAPACITY = 256

function drive(historyWindowMs) {
  const lc = new LagCompensator(historyWindowMs, TICK_RATE)
  for (let t = 0; t < SAMPLES; t += 1) {
    lc.beginTick(t)
    lc.recordPlayerPosition('p', [t, 0, 0], [0, 0, 0, 1], [0, 0, 0], t)
  }
  const current = SAMPLES - 1
  const ring = lc.playerHistory.get('p')
  const clampsBefore = lc.getStats().clamped
  const resolved = lc.resolveViewTick(0, current)
  const clampDelta = lc.getStats().clamped - clampsBefore
  const sample = lc.rewindAtTick('p', 0, null)
  return { resolved, clampDelta, rewindTick: sample.tick, ringLen: ring.len, oldestStored: ring.buf[ring.head].tick, capacity: HISTORY_CAPACITY }
}

const at4000 = drive(4000)
assert.deepEqual(at4000, { resolved: 59, clampDelta: 1, rewindTick: 58, ringLen: 242, oldestStored: 58, capacity: 256 }, '4000 ms: the request clamps to the oldest stored tick and the rewind returns the stored sample tick')

const at5000 = drive(5000)
assert.deepEqual(at5000, { resolved: 44, clampDelta: 1, rewindTick: 44, ringLen: 256, oldestStored: 44, capacity: 256 }, '5000 ms overflows the 256-sample ring: the clamp counter rises and the rewind returns the oldest stored tick')

const at4267 = drive(4267)
assert.deepEqual(at4267, { resolved: 44, clampDelta: 1, rewindTick: 44, ringLen: 256, oldestStored: 44, capacity: 256 }, '4267 ms: the clamp is off by one at the ring boundary, so the oldest retained tick is 44, not 43')

const lc = new LagCompensator(4000, TICK_RATE)
for (let t = 0; t < SAMPLES; t += 1) { lc.beginTick(t); lc.recordPlayerPosition('p', [t, 0, 0], [0, 0, 0, 1], [0, 0, 0], t) }
const before = lc.getStats().clamped
assert.equal(lc.resolveViewTick(100, 299), 100, 'an in-window tick is returned unchanged')
assert.equal(lc.getStats().clamped, before, 'an in-window tick does not raise the clamp counter')

console.log('RESULT: PASS lag history at 4000, 5000 and 4267 ms: an overflowing or out-of-window request clamps to the oldest retained tick (44 at 5000 and 4267 ms, 59 at 4000 ms) and raises the clamp counter once, rewindAtTick returns the stored sample tick, and an in-window tick is unchanged')
