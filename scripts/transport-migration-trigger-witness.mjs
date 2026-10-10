#!/usr/bin/env node
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs, strArg } from './lib/witness-args.mjs'

const startedAt = new Date().toISOString()
const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = parseArgs(process.argv.slice(2))
const modulePath = resolve(strArg(args.module, resolve(SDK_ROOT, 'src/client/TransportMigrationTrigger.js')))
const { TransportMigrationTrigger } = await import(pathToFileURL(modulePath).href)

const passes = []
const failures = []

function expect(condition, label) {
  if (condition) passes.push(label)
  else failures.push(label)
  console.log(`${condition ? '[PASS]' : '[FAIL]'} ${label}`)
}

const clock = { now: 1000000 }
const intervals = []
let intervalSeq = 0
const savedDescriptors = {
  dateNow: Object.getOwnPropertyDescriptor(Date, 'now'),
  setInterval: Object.getOwnPropertyDescriptor(globalThis, 'setInterval'),
  clearInterval: Object.getOwnPropertyDescriptor(globalThis, 'clearInterval'),
  navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
}

function overrideGlobal(target, key, value) {
  Object.defineProperty(target, key, { value, configurable: true, writable: true, enumerable: true })
}

function restoreGlobal(target, key, descriptor) {
  if (descriptor) Object.defineProperty(target, key, descriptor)
  else delete target[key]
}

function installFakeClock() {
  overrideGlobal(Date, 'now', () => clock.now)
}

function installFakeTimers() {
  overrideGlobal(globalThis, 'setInterval', (fn, ms) => {
    intervalSeq += 1
    const record = { fn, ms, handle: { fakeIntervalId: intervalSeq }, cleared: false, clearCount: 0 }
    intervals.push(record)
    return record.handle
  })
  overrideGlobal(globalThis, 'clearInterval', handle => {
    const record = intervals.find(candidate => candidate.handle === handle)
    if (record) {
      record.cleared = true
      record.clearCount += 1
    }
  })
}

function installNavigator(value) {
  overrideGlobal(globalThis, 'navigator', value)
}

function fakeConnection() {
  const connection = {
    effectiveType: '4g',
    type: 'wifi',
    added: [],
    removed: [],
    addEventListener(event, fn) { connection.added.push({ event, fn }) },
    removeEventListener(event, fn) { connection.removed.push({ event, fn }) },
  }
  return connection
}

function fakeClient({ rtt = 0, results = [], open = true, hasIsOpen = true, hasMigrate = true } = {}) {
  const client = {
    rtt,
    open,
    results: [...results],
    migrateCalls: 0,
    release: null,
    getRTT() { return client.rtt },
    migrateTransport() {
      client.migrateCalls += 1
      const next = client.results.length > 0 ? client.results.shift() : 'failed'
      if (next === 'throw') return Promise.reject(new Error('transport closed'))
      if (next === 'hold') return new Promise(resolveHeld => { client.release = resolveHeld })
      return Promise.resolve(next)
    },
    _isOpen() { return client.open },
  }
  if (!hasIsOpen) delete client._isOpen
  if (!hasMigrate) delete client.migrateTransport
  return client
}

function spyAttempts(trigger) {
  const spy = { calls: [], pending: [] }
  const original = trigger._attemptMigration
  trigger._attemptMigration = (reason, detail) => {
    spy.calls.push({ reason, detail })
    const outcome = original.call(trigger, reason, detail)
    spy.pending.push(outcome)
    return outcome
  }
  return spy
}

async function settle(spy) {
  await Promise.all(spy.pending.splice(0))
}

async function main() {
  expect(typeof globalThis.window === 'undefined', 'no browser window global exists during the run')
  installFakeClock()
  installFakeTimers()

  installNavigator({})
  const fresh = new TransportMigrationTrigger(fakeClient()).getStats()
  expect(fresh.attempts === 0 && fresh.cooldownUntil === 0 && fresh.migrating === false && fresh.lastResult === null && fresh.rttStreak === 0, 'a new trigger reports zeroed attempts, cooldown, migration flag, last result and spike streak')

  const connection = fakeConnection()
  installNavigator({ connection })
  intervals.length = 0
  const linked = fakeClient()
  const linkedTrigger = new TransportMigrationTrigger(linked)
  const linkedSpy = spyAttempts(linkedTrigger)
  linkedTrigger.start()
  expect(connection.added.length === 1 && connection.added[0].event === 'change' && typeof connection.added[0].fn === 'function', 'start registers one change listener on navigator.connection')
  expect(intervals.length === 1 && intervals[0].ms === 1000 && intervals[0].cleared === false, 'start arms one 1000 ms RTT poll timer that stays live')
  linkedTrigger.start()
  expect(connection.added.length === 1 && intervals.length === 1, 'a repeated start() registers no second listener or timer')
  connection.added[0].fn()
  expect(linkedSpy.calls.length === 1 && linkedSpy.calls[0].reason === 'connection-change' && linkedSpy.calls[0].detail.effectiveType === '4g' && linkedSpy.calls[0].detail.type === 'wifi', 'a connection change attempts a migration tagged connection-change with the link type')
  await settle(linkedSpy)
  linkedTrigger.stop()
  expect(connection.removed.length === 1 && connection.removed[0].event === 'change' && connection.removed[0].fn === connection.added[0].fn, 'stop removes the same change listener it registered')
  expect(intervals[0].cleared === true && intervals[0].clearCount === 1, 'stop clears the RTT poll timer exactly once')
  linkedTrigger.stop()
  expect(connection.removed.length === 1 && intervals[0].clearCount === 1, 'a second stop() removes and clears nothing further')

  installNavigator({})
  intervals.length = 0
  const polled = fakeClient({ rtt: 300 })
  const pollTrigger = new TransportMigrationTrigger(polled)
  const pollSpy = spyAttempts(pollTrigger)
  pollTrigger.start()
  const tick = intervals[0].fn
  tick()
  expect(pollTrigger.getStats().rttStreak === 0 && pollSpy.calls.length === 0, 'an RTT exactly at the threshold is not counted as a spike')
  polled.rtt = 500
  tick()
  tick()
  expect(pollTrigger.getStats().rttStreak === 2 && pollSpy.calls.length === 0, 'two consecutive spikes stay below the streak of three')
  polled.rtt = 100
  tick()
  expect(pollTrigger.getStats().rttStreak === 0, 'a sample under the threshold resets the spike streak')
  polled.rtt = 500
  tick()
  tick()
  tick()
  expect(pollSpy.calls.length === 1 && pollSpy.calls[0].reason === 'rtt-spike' && pollSpy.calls[0].detail.rtt === 500, 'the third consecutive spike attempts one rtt-spike migration')
  expect(pollTrigger.getStats().rttStreak === 0, 'the spike streak resets once it has produced an attempt')
  await settle(pollSpy)
  expect(polled.migrateCalls === 1, 'the spike attempt reaches migrateTransport exactly once')
  pollTrigger.stop()
  expect(intervals[0].cleared === true, 'stop clears the poll timer that drove the streak')

  const backoffClient = fakeClient({ results: ['failed', 'failed', 'migrated'] })
  const backoff = new TransportMigrationTrigger(backoffClient)
  spyAttempts(backoff)
  const first = await backoff._attemptMigration('manual', {})
  const afterFirst = backoff.getStats()
  expect(first === 'failed' && afterFirst.attempts === 1 && afterFirst.cooldownUntil === clock.now + 1000 && afterFirst.lastResult.result === 'failed', 'a non-migrated result backs off by the base delay of 1000 ms')
  const blocked = await backoff._attemptMigration('manual', {})
  expect(blocked === undefined && backoffClient.migrateCalls === 1, 'an attempt inside the cooldown is refused without calling migrateTransport')
  clock.now += 999
  await backoff._attemptMigration('manual', {})
  expect(backoffClient.migrateCalls === 1, 'the cooldown still holds one millisecond before it expires')
  clock.now += 1
  const second = await backoff._attemptMigration('manual', {})
  const afterSecond = backoff.getStats()
  expect(second === 'failed' && backoffClient.migrateCalls === 2 && afterSecond.attempts === 2 && afterSecond.cooldownUntil === clock.now + 1500, 'the cooldown lapses at its exact expiry and the second failure backs off 1500 ms')
  clock.now += 1500
  const third = await backoff._attemptMigration('manual', {})
  const afterThird = backoff.getStats()
  expect(third === 'migrated' && afterThird.attempts === 0 && afterThird.cooldownUntil === 0 && afterThird.lastResult.result === 'migrated', 'a migrated result clears the attempt count and the cooldown')
  const fourth = await backoff._attemptMigration('manual', {})
  expect(fourth === 'failed' && backoffClient.migrateCalls === 4 && backoff.getStats().attempts === 1, 'after a migrated result the next attempt runs at once and starts the backoff again')

  const cappedClient = fakeClient({ results: ['failed', 'failed', 'failed', 'failed'] })
  const capped = new TransportMigrationTrigger(cappedClient, { baseBackoffMs: 1000, maxBackoffMs: 2000 })
  const deltas = []
  for (let round = 0; round < 4; round += 1) {
    await capped._attemptMigration('manual', {})
    const delta = capped.getStats().cooldownUntil - clock.now
    deltas.push(delta)
    clock.now += delta
  }
  expect(deltas.join(',') === '1000,1500,2000,2000', `backoff grows by 1.5x and is capped at maxBackoffMs (observed ${deltas.join(',')})`)

  const closedClient = fakeClient({ open: false })
  const closedTrigger = new TransportMigrationTrigger(closedClient)
  const closedResult = await closedTrigger._attemptMigration('manual', {})
  expect(closedResult === undefined && closedClient.migrateCalls === 0 && closedTrigger.getStats().attempts === 0, 'a closed transport is left to the reconnect manager and no migration is attempted')
  closedClient.open = true
  await closedTrigger._attemptMigration('manual', {})
  expect(closedClient.migrateCalls === 1, 'an open transport proceeds to migrateTransport')
  const bareClient = fakeClient({ hasIsOpen: false })
  const bareTrigger = new TransportMigrationTrigger(bareClient)
  await bareTrigger._attemptMigration('manual', {})
  expect(bareClient.migrateCalls === 1, 'a client without _isOpen is not gated on connection state')
  const unmigratableClient = fakeClient({ hasMigrate: false })
  const unmigratable = new TransportMigrationTrigger(unmigratableClient)
  const unmigratableResult = await unmigratable._attemptMigration('manual', {})
  expect(unmigratableResult === undefined && unmigratable.getStats().attempts === 0 && unmigratable.getStats().lastResult === null, 'a client without migrateTransport is skipped without touching backoff state')

  const throwingClient = fakeClient({ results: ['throw'] })
  const throwing = new TransportMigrationTrigger(throwingClient)
  const thrown = await throwing._attemptMigration('manual', {})
  const thrownStats = throwing.getStats()
  expect(thrown === 'failed' && thrownStats.attempts === 1 && thrownStats.cooldownUntil === clock.now + 1000 && thrownStats.migrating === false, 'a migrateTransport that throws counts as a failed attempt and backs off')

  const heldClient = fakeClient({ results: ['hold'] })
  const held = new TransportMigrationTrigger(heldClient)
  const inFlight = held._attemptMigration('manual', {})
  expect(held.getStats().migrating === true, 'a migration in flight marks the trigger as migrating')
  const overlapping = await held._attemptMigration('manual', {})
  expect(overlapping === undefined && heldClient.migrateCalls === 1, 'an overlapping attempt is dropped while a migration is in flight')
  heldClient.release('migrated')
  const settled = await inFlight
  expect(settled === 'migrated' && held.getStats().migrating === false && held.getStats().attempts === 0, 'the in-flight migration settles and clears the migrating flag')

  installNavigator({})
  intervals.length = 0
  const restartClient = fakeClient({ rtt: 500 })
  const restarted = new TransportMigrationTrigger(restartClient)
  const restartSpy = spyAttempts(restarted)
  restarted.start()
  intervals[0].fn()
  intervals[0].fn()
  expect(restarted.getStats().rttStreak === 2, 'two spikes build a streak before the trigger is stopped')
  restarted.stop()
  expect(restarted.getStats().rttStreak === 0 && intervals[0].cleared === true, 'stop resets the spike streak and clears the timer')
  restarted.start()
  expect(intervals.length === 2 && intervals[1].cleared === false, 'a restart arms a fresh poll timer')
  intervals[1].fn()
  expect(restarted.getStats().rttStreak === 1 && restartSpy.calls.length === 0, 'after a restart one spike does not attempt a migration, because the streak began at zero')
  restarted.stop()

  expect(intervals.every(record => record.cleared), 'every poll timer the witness armed is cleared')
}

try {
  await main()
} catch (error) {
  failures.push(`uncaught: ${error.message}`)
  console.log(`[FAIL] uncaught: ${error.message}`)
  process.exitCode = 1
} finally {
  restoreGlobal(Date, 'now', savedDescriptors.dateNow)
  restoreGlobal(globalThis, 'setInterval', savedDescriptors.setInterval)
  restoreGlobal(globalThis, 'clearInterval', savedDescriptors.clearInterval)
  restoreGlobal(globalThis, 'navigator', savedDescriptors.navigator)
}

console.log(`run ${startedAt} module ${modulePath}`)
if (failures.length === 0) {
  console.log(`RESULT: PASS -- ${passes.length} check(s) held over the transport migration trigger`)
} else {
  console.log(`RESULT: FAIL -- ${failures.length} of ${passes.length + failures.length} check(s) failed: ${failures.join('; ')}`)
  process.exitCode = 1
}
