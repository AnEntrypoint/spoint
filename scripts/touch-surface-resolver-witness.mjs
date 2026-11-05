import assert from 'node:assert/strict'
import { resolveControls, MAX_TOUCH_CHIPS } from '../src/client/touchSurfaces.js'

const draft = { sticks: [{ id: 'move' }], buttons: [{ id: 'jump' }] }
const doc = {
  sticks: [{ id: 'move', side: 'left', axis: 'move' }],
  buttons: [{ id: 'jump', label: 'Jump', action: 'jump' }, { id: 'fire', label: 'Fire' }],
  pads: [{ id: 'dpad' }],
  gestures: [{ id: 'pinch' }],
  style: { safeArea: true },
  axes: ['touchActive', 'touchTwist'],
}
const resolved = resolveControls(doc, draft)
assert.equal(resolved.ok, true)
assert.equal(resolved.reasonCode, null)
assert.equal(resolved.diagnostics.length, 0)
assert.equal(resolved.controls.sticks.length, 1)
assert.equal(resolved.controls.buttons.length, 2)
assert.deepEqual(resolved.controls.axes, ['touchActive', 'touchTwist'])
assert.deepEqual(resolved.sendAction('jump'), { type: 'action', id: 'jump' })
assert.deepEqual(resolved.sendAxis('move', 0.5), { type: 'axis', id: 'move', value: 0.5 })

const tooMany = resolveControls({ ...doc, buttons: Array.from({ length: 8 }, (_, i) => ({ id: 'b' + i })) }, draft)
assert.equal(tooMany.ok, true)
assert.ok(tooMany.diagnostics.some(d => d.startsWith('chip-cap-exceeded')))
assert.equal(tooMany.controls.sticks.length + tooMany.controls.buttons.length + tooMany.controls.pads.length, MAX_TOUCH_CHIPS)

const badChips = resolveControls({ sticks: [null], buttons: [{ id: 'ok' }], pads: 'no' }, draft)
assert.equal(badChips.ok, true)
assert.ok(badChips.diagnostics.includes('bad-sticks-0'))
assert.ok(badChips.diagnostics.includes('pads-not-array'))

const unusable = resolveControls({ sticks: [], buttons: [], pads: [{ id: 'p' }] }, draft)
assert.equal(unusable.ok, false)
assert.equal(unusable.reasonCode, 'touch-surface-unusable')
assert.deepEqual(unusable.fallback, draft)
assert.equal(unusable.controls, null)

for (const [call, code] of [
  [() => resolveControls(null, draft), 'touch-document-invalid'],
  [() => resolveControls(doc, []), 'touch-draft-invalid'],
]) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

console.log('RESULT: PASS touch surface resolver caps chips, names diagnostics, falls back to the draft and refuses bad documents')
