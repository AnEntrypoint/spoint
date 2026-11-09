import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { createVirtualClock, installVirtualGlobals } from './lib/virtual-clock.mjs'

await installSpecifierHooks()
const clock = createVirtualClock({ seed: 2 })
installVirtualGlobals(clock)
const { createLoadingStateMachine, notModelFailure, LOADING_HARD_MS } = await import('../client/core/LoadingMachine.js')
const sleepOn = (ms) => new Promise((resolveSleep) => clock.setTimeout(resolveSleep, ms))

assert.equal(notModelFailure({ context: { modelFailure: true } }), false)

await clock.drive(async () => {
  const machine = createLoadingStateMachine()
  machine.send('MODEL_LOAD_FAILED', { reasonCode: 'model-load-failed', url: 'bad.glb' })
  assert.equal(machine.context.modelFailure, true)
  machine.send('FORCE_READY')
  machine.send('WORLD_EXISTS')
  assert.equal(machine.isWorldReady, false, 'FORCE_READY must not bypass a coded model failure')
  assert.equal(machine.state, 'loading')
  await sleepOn(LOADING_HARD_MS + 1)
  assert.equal(clock.now() > LOADING_HARD_MS, true, 'the virtual clock must pass LOADING_HARD_MS')
  assert.equal(machine.isWorldReady, false, 'FORCE_READY must not reach worldReady once the hard-stop timer runs')
  assert.equal(machine.state, 'loading')
}, { maxVirtualMs: LOADING_HARD_MS + 1000 })

const clean = createLoadingStateMachine()
clean.send('FORCE_READY')
clean.send('WORLD_EXISTS')
assert.equal(clean.isWorldReady, true, 'FORCE_READY still works when no model failed')

const src = readFileSync('client/core/LoadingMachine.js', 'utf8')
assert.match(src, /FORCE_READY: \[\{ guard: notModelFailure, target: 'ready' \}, \{ target: 'loading' \}\]/)
console.log('RESULT: PASS FORCE_READY is guarded by modelFailure on a virtual clock past LOADING_HARD_MS and cannot reach worldReady after a coded model failure')
