import assert from 'node:assert/strict'
import { createSurfaceSelectorRuntime } from '../src/apps/SurfaceSelectorRuntime.js'

let clock = 0
const selector = createSurfaceSelectorRuntime({
  labels: { 'touch-portrait': 'Portrait controls', desktop: 'Desktop' },
  now: () => clock,
  maxSwapsPerSecond: 4,
})

assert.deepEqual(selector.select({ player: { surface: 'custom' }, device: {} }), { name: 'custom', hidden: false, label: 'custom' })
assert.deepEqual(selector.select({ player: {}, device: { coarse: true, orientation: 'portrait' } }), { name: 'touch-portrait', hidden: false, label: 'Portrait controls' })
assert.deepEqual(selector.select({ player: { surface: null }, device: {} }), { name: null, hidden: true, label: null })

selector.hold('p1')
assert.deepEqual(selector.swap('touch-portrait'), { ok: true, reasonCode: null, active: 'touch-portrait', released: ['p1'] })
assert.deepEqual(selector.held(), [])
selector.swap('a'); clock = 100; selector.swap('b'); clock = 200; selector.swap('c')
const suppressed = selector.swap('d')
assert.equal(suppressed.ok, false)
assert.equal(suppressed.reasonCode, 'selector-swap-suppressed')
assert.ok(selector.diagnostics().some(d => d.startsWith('swap-suppressed')))
clock = 1200
assert.equal(selector.swap('e').ok, true, 'the window must clear after a second')

for (const [call, code] of [
  [() => createSurfaceSelectorRuntime({ labels: [], now: () => 0 }), 'selector-labels-invalid'],
  [() => createSurfaceSelectorRuntime({ maxSwapsPerSecond: 0, now: () => 0 }), 'selector-rate-invalid'],
  [() => createSurfaceSelectorRuntime({}), 'selector-clock-invalid'],
  [() => selector.swap(''), 'selector-name-invalid'],
  [() => selector.select({ player: null }), 'selector-context-invalid'],
]) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

console.log('RESULT: PASS per-player surface selector maps labels, hides on null, suppresses rapid swaps and releases held fingers')
