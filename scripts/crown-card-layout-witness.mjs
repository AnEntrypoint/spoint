import assert from 'node:assert/strict'
import { createCrownLayout, CROWN_SHAPES } from '../src/vegetation/crownCards.js'

const spec = { center: [3, 5, -2], radius: 2, height: 4, headClearanceM: 2, cardCount: 64, normal: [0, 1, 0], seed: 7 }
const cards = createCrownLayout(spec)
assert.equal(cards.length, 64)
assert.ok(cards.every(c => c.position[1] >= 5 + 2 - 1e-12), 'every card must clear the head')
assert.ok(cards.every(c => c.position[1] <= 5 + 4 + 1e-12), 'every card must stay inside the crown height')
assert.ok(cards.every(c => c.normal[1] === 1), 'every card inherits the crown normal')
assert.ok(cards.some(c => c.dark), 'some heart cards are dark')
assert.ok(cards.some(c => c.tiltRad > 0) && cards.some(c => c.tiltRad < 0), 'tilts are mixed')
assert.ok(new Set(cards.map(c => c.scale[0])).size > 10, 'sizes are mixed')
assert.deepEqual(createCrownLayout(spec), cards, 'the layout is deterministic')
assert.notDeepEqual(createCrownLayout({ ...spec, seed: 8 }), cards)
for (const shape of CROWN_SHAPES) {
  const laid = createCrownLayout({ ...spec, shape })
  assert.equal(laid.length, 64)
  assert.ok(laid.every(c => c.position[1] >= 7 - 1e-12))
}

for (const [call, code] of [
  [() => createCrownLayout({ radius: 0 }), 'crown-radius-invalid'],
  [() => createCrownLayout({ height: -1 }), 'crown-height-invalid'],
  [() => createCrownLayout({ headClearanceM: 10, height: 4 }), 'crown-clearance-invalid'],
  [() => createCrownLayout({ cardCount: 0 }), 'crown-count-invalid'],
  [() => createCrownLayout({ tiltMaxRad: 3 }), 'crown-tilt-invalid'],
  [() => createCrownLayout({ seed: 1.5 }), 'crown-seed-invalid'],
  [() => createCrownLayout({ darkFraction: 2 }), 'crown-dark-invalid'],
  [() => createCrownLayout({ shape: 'sphere' }), 'crown-shape-invalid'],
  [() => createCrownLayout({ center: [0, 0] }), 'crown-vec-invalid'],
]) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

console.log('RESULT: PASS crown card layout clears the head, inherits the crown normal, mixes size and tilt, and refuses by code')
