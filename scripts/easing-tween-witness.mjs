import assert from 'node:assert/strict'
import { EASING, EASING_NAMES, easing } from '../src/shared/easing.js'
import { createTween } from '../src/shared/tween.js'

const EPS = 1e-9
const OVERSHOOT = /Back|Elastic|Bounce/

assert.ok(EASING_NAMES.length >= 25, `easing registry unexpectedly small: ${EASING_NAMES.length}`)
for (const name of EASING_NAMES) {
  assert.ok(Math.abs(EASING[name](0)) <= EPS, `${name}(0) is not 0: ${EASING[name](0)}`)
  assert.ok(Math.abs(EASING[name](1) - 1) <= EPS, `${name}(1) is not 1: ${EASING[name](1)}`)
  if (!OVERSHOOT.test(name)) {
    for (let i = 0; i < 100; i++) {
      const a = EASING[name](i / 100)
      const b = EASING[name]((i + 1) / 100)
      assert.ok(b >= a - EPS, `${name} decreases between ${i / 100} and ${(i + 1) / 100}`)
    }
  }
}

for (const [call, code] of [
  [() => easing('nope', 0.5), 'easing-unknown'],
  [() => easing('linear', NaN), 'easing-t-out-of-range'],
  [() => easing('linear', 1.0001), 'easing-t-out-of-range'],
  [() => createTween({ from: NaN, to: 1, durationMs: 10, onUpdate() {} }), 'tween-from-invalid'],
  [() => createTween({ from: 0, to: 1, durationMs: 0, onUpdate() {} }), 'tween-duration-invalid'],
  [() => createTween({ from: 0, to: 1, durationMs: 10, easingName: 'nope', onUpdate() {} }), 'tween-easing-unknown'],
  [() => createTween({ from: 0, to: 1, durationMs: 10 }), 'tween-onUpdate-invalid'],
]) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

const seen = []
let completed = 0
const tween = createTween({
  from: 0,
  to: 10,
  durationMs: 100,
  onUpdate: (v, t) => seen.push([v, t]),
  onComplete: () => { completed++ },
})
assert.equal(tween.value, 0)
assert.equal(tween.update(0), false)
assert.equal(tween.value, 0)
assert.equal(tween.update(50), false)
assert.ok(Math.abs(tween.value - 5) <= EPS, `linear midpoint is ${tween.value}, expected 5`)
assert.equal(tween.progress, 0.5)
assert.equal(tween.update(50), true)
assert.ok(Math.abs(tween.value - 10) <= EPS)
assert.equal(tween.done, true)
assert.equal(completed, 1)
assert.equal(tween.update(10), false)
assert.equal(seen.length, 3)
assert.ok(Math.abs(seen[2][1] - 1) <= EPS)

const eased = createTween({ from: 0, to: 1, durationMs: 100, easingName: 'easeInQuad', onUpdate() {} })
eased.update(50)
assert.ok(Math.abs(eased.value - 0.25) <= EPS, `easeInQuad midpoint is ${eased.value}, expected 0.25`)

const cancelled = createTween({ from: 0, to: 1, durationMs: 100, onUpdate() {} })
cancelled.update(10)
cancelled.cancel()
assert.equal(cancelled.cancelled, true)
assert.equal(cancelled.update(100), false)
assert.ok(Math.abs(cancelled.value - 0.1) <= EPS)

assert.equal(tween.update(-1), false)
assert.throws(() => eased.update(NaN), e => e.reasonCode === 'tween-dt-invalid')
assert.throws(() => eased.update(-1), e => e.reasonCode === 'tween-dt-invalid')

import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { AppContext } = await import('../src/apps/AppContext.js')
for (const name of ['easing', 'easingNames', 'createTween']) {
  assert.equal(typeof AppContext.prototype[name], 'function', `ctx.${name} is not exposed by AppContext`)
}
assert.ok(AppContext.prototype.easingNames().length >= 25)

console.log(`RESULT: PASS ${EASING_NAMES.length} easing law(s), refusals carry codes, tween advances by dt and completes once`)
