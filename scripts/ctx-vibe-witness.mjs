import assert from 'node:assert/strict'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { AppContext } = await import('../src/apps/AppContext.js')
assert.equal(typeof AppContext.prototype.vibe, 'function', 'ctx.vibe must be exposed')
const entity = { id: 'music-1', custom: {} }
const fake = Object.create(AppContext.prototype)
fake._entity = entity
const pattern = fake.vibe({ bpm: 120, length: 4, steps: [{ sample: 'kick', beat: 0 }] }, ['kick', 'snare'])
assert.equal(entity.custom._vibe, pattern, 'the pattern is written to the entity custom block')
assert.throws(() => fake.vibe({ bpm: 120, length: 4, steps: [{ sample: 'bell', beat: 0 }] }, ['kick']), e => e.reasonCode === 'unknown-sample')
assert.equal(entity.custom._vibe, pattern, 'a refused pattern leaves the previous one in place')
console.log('RESULT: PASS ctx.vibe validates a pattern against the given sample names and stores it on the entity custom block; an unknown sample refuses with unknown-sample and keeps the previous pattern')
