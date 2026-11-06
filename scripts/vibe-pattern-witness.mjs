import assert from 'node:assert/strict'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { parseVibe, eventsBetween, VibeError } = await import('../src/behaviours/vibe.js')

const samples = new Set(['kick', 'snare', 'hat'])
const pattern = parseVibe({ bpm: 120, swing: 0.25, length: 4, steps: [{ sample: 'kick', beat: 0 }, { sample: 'hat', beat: 0.5 }, { sample: 'snare', beat: 1 }] }, samples)

const first = eventsBetween(pattern, 0, 4)
assert.deepEqual(first.map(e => e.sample), ['kick', 'hat', 'snare'], 'one bar yields the three steps in order')
assert.equal(first[1].beat, 0.75, 'the off-beat eighth is pushed by swing')
assert.equal(first[0].seconds, 0, 'beat 0 is at 0 s')
assert.equal(first[2].seconds, 0.5, 'at 120 bpm beat 1 is 0.5 s')

const looped = eventsBetween(pattern, 4, 8)
assert.equal(looped.length, 3, 'the pattern repeats every length beats')
assert.equal(eventsBetween(pattern, 0, 0.5).length, 1, 'a half-open range excludes its end')

for (const [spec, code] of [
  [{ bpm: 120, length: 4, steps: [{ sample: 'bell', beat: 0 }] }, 'unknown-sample'],
  [{ bpm: 9, length: 4, steps: [] }, 'bpm-invalid'],
  [{ bpm: 120, swing: 0.9, length: 4, steps: [] }, 'swing-invalid'],
  [{ bpm: 120, length: 4, steps: [{ sample: 'kick', beat: 4 }] }, 'beat-invalid'],
]) assert.throws(() => parseVibe(spec, samples), e => e instanceof VibeError && e.reasonCode === code, code)

console.log('RESULT: PASS vibe pattern parses against a sample manifest, swing pushes off-beat steps, patterns repeat per length, and unknown samples, bpm, swing and beat refuse with codes')
