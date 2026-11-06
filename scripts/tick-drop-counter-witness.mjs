import assert from 'node:assert/strict'
import { TickSystem } from '../src/netcode/TickSystem.js'
import { EventEmitter } from '../src/protocol/EventEmitter.js'
import { createServerAPI } from '../src/sdk/ServerAPI.js'

const original = globalThis.performance
let nowMs = 1000
globalThis.performance = { now: () => nowMs }
try {
  const tick = new TickSystem(64)
  const drops = []
  const unsubscribe = tick.onTickDrop(detail => drops.push(detail))

  const emitter = new EventEmitter()
  const api = createServerAPI({
    tickSystem: tick, emitter,
    config: {}, port: 0, tickRate: 64, staticDirs: [],
    appLoader: {}, appRuntime: {}, physics: {}, physicsIntegration: {}, stageLoader: {},
    playerManager: {}, networkState: {}, lagCompensator: {}, connections: {}, sessions: {},
    inspector: {}, reloadManager: {}, eventBus: {}, eventLog: {}, storage: {},
  })
  const delivered = []
  api.on('tick-drop', detail => delivered.push(detail))

  tick._state = 'running'
  tick._nextDueMs = 0
  tick._runDueTicks()

  const stats = tick.getSchedulerStats()
  assert.ok(stats.droppedMs > 0, 'a >4-tick backlog must be counted')
  assert.equal(stats.reasonCode, 'tick-catch-up-exceeded')
  assert.equal(stats.maxCatchUpSteps, 4)
  assert.ok(Math.abs(stats.droppedTicks - stats.droppedMs / tick.tickDuration) < 1e-9)
  assert.equal(Object.isFrozen(stats), true, 'the snapshot must not be mutable')
  assert.equal(drops.length, 1, 'the drop callback must fire once')
  assert.equal(drops[0].reasonCode, 'tick-catch-up-exceeded')
  assert.equal(delivered.length, 1, 'ServerAPI must re-emit the drop on the emitter')
  assert.equal(delivered[0].totalDroppedMs, stats.droppedMs)
  assert.deepEqual(api.tickStats(), stats, 'ServerAPI.tickStats must read the live counter')

  const before = tick.getSchedulerStats().droppedMs
  nowMs = 2000
  tick._runDueTicks()
  assert.ok(tick.getSchedulerStats().droppedMs > before, 'a second backlog must add to the counter')
  assert.equal(drops.length, 2)

  unsubscribe()
  nowMs = 3000
  tick._runDueTicks()
  assert.equal(drops.length, 2, 'unsubscribing must stop the callback')
  assert.throws(() => tick.onTickDrop(null), e => e.reasonCode === 'tick-drop-listener-invalid')

  const clean = new TickSystem(64)
  assert.equal(clean.getSchedulerStats().droppedMs, 0)
  assert.equal(clean.getSchedulerStats().reasonCode, null)
} finally {
  globalThis.performance = original
}

console.log('RESULT: PASS tick drop counter is readable, accumulates, emits tick-drop with a reason code and has an unsubscribe')
