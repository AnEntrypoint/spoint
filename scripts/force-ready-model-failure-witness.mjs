import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { createLoadingStateMachine, notModelFailure } = await import('../client/core/LoadingMachine.js')

assert.equal(notModelFailure({ context: { modelFailure: true } }), false)
const machine = createLoadingStateMachine()
machine.send('MODEL_LOAD_FAILED', { reasonCode: 'model-load-failed', url: 'bad.glb' })
assert.equal(machine.context.modelFailure, true)
machine.send('FORCE_READY')
machine.send('WORLD_EXISTS')
assert.equal(machine.isWorldReady, false, 'FORCE_READY must not bypass a coded model failure')
assert.equal(machine.state, 'loading')

const clean = createLoadingStateMachine()
clean.send('FORCE_READY')
clean.send('WORLD_EXISTS')
assert.equal(clean.isWorldReady, true, 'FORCE_READY still works when no model failed')

const src = readFileSync('client/core/LoadingMachine.js', 'utf8')
assert.match(src, /FORCE_READY: \[\{ guard: notModelFailure, target: 'ready' \}, \{ target: 'loading' \}\]/)
console.log('RESULT: PASS FORCE_READY is guarded by modelFailure and cannot reach worldReady after a coded model failure')
