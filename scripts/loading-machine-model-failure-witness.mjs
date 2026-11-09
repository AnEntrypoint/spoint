import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { createVirtualClock, installVirtualGlobals } from './lib/virtual-clock.mjs'

await installSpecifierHooks()
const clock = createVirtualClock({ seed: 1 })
installVirtualGlobals(clock)
const { notModelFailure, allDone, hasContent, createLoadingStateMachine, LOADING_FALLBACK_MS, LOADING_HARD_MS } = await import('../client/core/LoadingMachine.js')
const sleepOn = (ms) => new Promise((resolveSleep) => clock.setTimeout(resolveSleep, ms))

assert.equal(notModelFailure({ context: { modelFailure: true } }), false)
assert.equal(notModelFailure({ context: { modelFailure: false } }), true)
assert.equal(allDone({ context: { modelFailure: true, assets: true, environment: true, firstSnapshot: true, models: true, worldConfig: true, entityPending: 0 } }), false)
assert.equal(hasContent({ context: { modelFailure: true, firstSnapshot: true, environment: true } }), false)

await clock.drive(async () => {
  const machine = createLoadingStateMachine()
  machine.send('MODEL_LOAD_FAILED', { reasonCode: 'model-load-failed', url: 'bad.glb' })
  assert.equal(machine.context.modelFailure, true)
  machine.send('ASSETS_DONE')
  machine.send('WORLD_CONFIG')
  machine.send('ENVIRONMENT_DONE')
  machine.send('FIRST_SNAPSHOT')
  machine.send('MODELS_DONE')
  machine.send('SET_PENDING', { count: 0 })
  machine.send('WORLD_EXISTS')
  assert.equal(machine.isWorldReady, false, 'a model failure must not reach worldReady')
  assert.equal(machine.state, 'loading', 'the loading machine must stay stopped')
  await sleepOn(LOADING_FALLBACK_MS + 1)
  assert.equal(clock.now() > LOADING_FALLBACK_MS, true, 'the virtual clock must pass LOADING_FALLBACK_MS')
  assert.equal(machine.isWorldReady, false, 'the fallback timer must not reach worldReady after a model failure')
  assert.equal(machine.state, 'loading', 'the loading machine must stay stopped after the fallback timer')
  await sleepOn(LOADING_HARD_MS - LOADING_FALLBACK_MS)
  assert.equal(clock.now() > LOADING_HARD_MS, true, 'the virtual clock must pass LOADING_HARD_MS')
  assert.equal(machine.isWorldReady, false, 'the hard-stop timer must not reach worldReady after a model failure')
  assert.equal(machine.state, 'loading', 'the loading machine must stay stopped after the hard stop')
}, { maxVirtualMs: LOADING_HARD_MS + 1000 })

const src = readFileSync('client/core/LoadingMachine.js', 'utf8')
assert.equal((src.match(/\[LOADING_HARD_MS\]: \[\{ guard: notModelFailure, target: 'ready' \}, \{ target: 'loading' \}\]/g) || []).length, 2)
assert.equal((src.match(/MODEL_LOAD_FAILED/g) || []).length >= 2, true)
console.log('RESULT: PASS on a virtual clock, LOADING_FALLBACK_MS and LOADING_HARD_MS are advanced past and neither reaches ready/worldReady after a coded model failure')
