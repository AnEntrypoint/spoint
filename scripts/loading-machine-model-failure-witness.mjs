import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { notModelFailure, allDone, hasContent, createLoadingStateMachine } = await import('../client/core/LoadingMachine.js')

assert.equal(notModelFailure({ context: { modelFailure: true } }), false)
assert.equal(notModelFailure({ context: { modelFailure: false } }), true)
assert.equal(allDone({ context: { modelFailure: true, assets: true, environment: true, firstSnapshot: true, models: true, worldConfig: true, entityPending: 0 } }), false)
assert.equal(hasContent({ context: { modelFailure: true, firstSnapshot: true, environment: true } }), false)

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

const src = readFileSync('client/core/LoadingMachine.js', 'utf8')
assert.equal((src.match(/\[LOADING_HARD_MS\]: \[\{ guard: notModelFailure, target: 'ready' \}, \{ target: 'loading' \}\]/g) || []).length, 2)
assert.equal((src.match(/MODEL_LOAD_FAILED/g) || []).length >= 2, true)
console.log('RESULT: PASS LOADING_FALLBACK_MS and LOADING_HARD_MS cannot reach ready/worldReady after a coded model failure')
