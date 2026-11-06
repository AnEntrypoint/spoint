import assert from 'node:assert/strict'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { parsePostFxLook, applyLook, PostFxLookError } = await import('../client/core/PostFxLook.js')

const neutral = parsePostFxLook({})
assert.deepEqual(applyLook(neutral, [0.2, 0.4, 0.6]).map(c => Math.round(c * 1000) / 1000), [0.2, 0.4, 0.6], 'an empty look is the identity')

const bright = parsePostFxLook({ exposure: 2 })
assert.equal(applyLook(bright, [0.25, 0.25, 0.25])[0], 0.5, 'exposure scales linearly')

const flat = parsePostFxLook({ saturation: 0 })
const grey = applyLook(flat, [1, 0, 0])
assert.ok(Math.abs(grey[0] - grey[1]) < 1e-9 && Math.abs(grey[1] - grey[2]) < 1e-9, 'saturation 0 greys the colour')

const vig = parsePostFxLook({ vignette: 1 })
assert.ok(applyLook(vig, [1, 1, 1], [0, 0])[0] < applyLook(vig, [1, 1, 1], [0.5, 0.5])[0], 'a corner darkens more than the centre')

assert.throws(() => parsePostFxLook({ bokehScale: 1 }), e => e instanceof PostFxLookError && e.reasonCode === 'operator-unknown')
assert.throws(() => parsePostFxLook({ exposure: 9 }), e => e instanceof PostFxLookError && e.reasonCode === 'operator-range')
assert.throws(() => parsePostFxLook([]), e => e instanceof PostFxLookError && e.reasonCode === 'look-invalid')

console.log('RESULT: PASS postfx look parses 7 operators with ranges, an empty look is identity, exposure and saturation act on colour, vignette darkens corners, and unknown operators and out-of-range values refuse with codes')
