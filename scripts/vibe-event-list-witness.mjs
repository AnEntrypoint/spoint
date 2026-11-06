import assert from 'node:assert/strict'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { AppContext } = await import('../src/apps/AppContext.js')
const { eventsBetween } = await import('../src/behaviours/vibe.js')

const entity = { id: 'music-1', custom: {} }
const fake = Object.create(AppContext.prototype)
fake._entity = entity
const pattern = fake.vibe({ bpm: 120, swing: 0.1, length: 4, steps: [{ sample: 'snare', beat: 1 }, { sample: 'hat', beat: 0.5 }, { sample: 'kick', beat: 0 }] }, ['kick', 'snare', 'hat'])
assert.equal(entity.custom._vibe, pattern, 'ctx.vibe writes the parsed pattern to the entity custom block')

const events = eventsBetween(entity.custom._vibe, 0, 4)
assert.deepEqual(events, [
  { sample: 'kick', beat: 0, seconds: 0 },
  { sample: 'hat', beat: 0.6, seconds: 0.3 },
  { sample: 'snare', beat: 1, seconds: 0.5 },
], 'one loop of the fixed pattern yields its three events in beat order with swing applied to the off-beat hat')

const nextLoop = eventsBetween(entity.custom._vibe, 4, 8).map(e => e.sample)
assert.deepEqual(nextLoop, ['kick', 'hat', 'snare'], 'the second loop repeats the pattern')

console.log('RESULT: PASS structural check: ctx.vibe stores the parsed pattern and eventsBetween yields the expected event list for one fixed pattern (no audio playback)')
