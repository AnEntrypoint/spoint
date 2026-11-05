import assert from 'node:assert/strict'
import { createDecisionRuntime } from '../src/behaviours/decisionRuntime.js'

let clock = 0
let players = 1
let failAsk = false
const calls = []
const emitted = []
const runtime = createDecisionRuntime({
  now: () => clock,
  hasPlayers: () => players > 0,
  periodMs: 1000,
  random: () => 0.25,
  ask: async ({ state, questions }) => {
    calls.push({ state, questions })
    if (failAsk) throw new Error('backend down')
    return { go: { probability: 0.75 }, mood: { probabilities: { calm: 1, angry: 3 } } }
  },
})

const questions = {
  go: { type: 'boolean' },
  mood: { type: 'choice', criteria: { calm: {}, angry: {} } },
}

runtime.register('npc-1', { questions, state: { hp: 10 }, onDecision: d => emitted.push(d) })
assert.equal(runtime.size(), 1)

const first = await runtime.tick()
assert.equal(first.ran, 1)
assert.equal(first.decisions[0].ok, true)
assert.equal(first.decisions[0].data.answers.go, true)
assert.equal(first.decisions[0].data.answers.mood, 'angry')
assert.equal(emitted.length, 1)
assert.equal(calls[0].state.hp, 10)

const tooSoon = await runtime.tick()
assert.equal(tooSoon.ran, 0, 'the per-entity cadence must suppress an early tick')

clock = 1000
const second = await runtime.tick()
assert.equal(second.ran, 1, 'the next tick runs once the period has elapsed')

players = 0
clock = 2000
const noPlayers = await runtime.tick()
assert.equal(noPlayers.ran, 0)
assert.equal(noPlayers.skipped, 'no-players')
players = 1

failAsk = true
clock = 3000
const failed = await runtime.tick()
assert.equal(failed.decisions[0].ok, false)
assert.equal(failed.decisions[0].error.code, 'ask-failed')
failAsk = false

runtime.unregister('npc-1')
assert.equal(runtime.size(), 0)
clock = 4000
assert.equal((await runtime.tick()).ran, 0)

for (const [call, code] of [
  [() => createDecisionRuntime({ ask: null, random: () => 0, now: () => 0 }), 'runtime-hooks-invalid'],
  [() => createDecisionRuntime({ ask: async () => ({}), random: () => 0, now: () => 0, periodMs: 0 }), 'runtime-period-invalid'],
  [() => runtime.register('', { questions }), 'runtime-entity-invalid'],
  [() => runtime.register('x', {}), 'runtime-questions-invalid'],
  [() => runtime.unregister('missing'), 'runtime-unknown-entity'],
]) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

runtime.register('npc-2', { questions })
assert.throws(() => runtime.register('npc-2', { questions }), e => e.reasonCode === 'runtime-duplicate')
const capped = createDecisionRuntime({ ask: async () => ({ go: { probability: 1 } }), random: () => 0, now: () => 0, maxEntities: 1 })
capped.register('only', { questions: { go: { type: 'boolean' } } })
assert.throws(() => capped.register('extra', { questions: { go: { type: 'boolean' } } }), e => e.reasonCode === 'runtime-cap-reached')

console.log('RESULT: PASS decision runtime honours per-entity cadence, no-players gate, ask failure, duplicate/cap refusals and named callbacks')
