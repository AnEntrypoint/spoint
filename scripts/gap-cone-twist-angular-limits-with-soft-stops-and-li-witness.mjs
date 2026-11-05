import { swingTwistLimits, ConstraintLimitError } from '../src/physics/constraintLimits.js'

const results = []
function expect(name, actual, expected) {
  const ok = Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected)
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`)
}
function refusal(name, fn, code) {
  let got = null
  try { fn() } catch (e) { got = e instanceof ConstraintLimitError ? e.reasonCode : `other:${e?.message}` }
  expect(name, got, code)
}

const PI = Math.PI

const limp = swingTwistLimits({ cone: PI })
expect('limp cone is PI', limp.cone, PI)
expect('limp twist is free', [limp.twistMin, limp.twistMax], [-PI, PI])
expect('limp has no spring', limp.spring, null)

const spin = swingTwistLimits({ cone: 0 })
expect('cone 0 is rigid cone', spin.cone, 0)
expect('cone 0 keeps free twist', [spin.twistMin, spin.twistMax], [-PI, PI])

const omitted = swingTwistLimits({ twist: [0, 1] })
expect('omitted cone is free', omitted.cone, PI)
expect('one-way twist kept', [omitted.twistMin, omitted.twistMax], [0, 1])

const soft = swingTwistLimits({ cone: 0.5, twist: [-0.3, 0.3] }, { frequency: 4, damping: 0.6 })
expect('soft spring carried', soft.spring, { frequency: 4, damping: 0.6 })
expect('soft cone carried', soft.cone, 0.5)

expect('no limits argument is free', swingTwistLimits(), { cone: PI, twistMin: -PI, twistMax: PI, spring: null })

refusal('negative cone refused', () => swingTwistLimits({ cone: -0.1 }), 'angle-out-of-range')
refusal('cone above PI refused', () => swingTwistLimits({ cone: PI + 0.01 }), 'angle-out-of-range')
refusal('NaN cone refused', () => swingTwistLimits({ cone: NaN }), 'angle-out-of-range')
refusal('string cone refused', () => swingTwistLimits({ cone: '0.5' }), 'angle-out-of-range')
refusal('twist not a pair refused', () => swingTwistLimits({ twist: [0] }), 'twist-not-pair')
refusal('inverted twist refused', () => swingTwistLimits({ twist: [1, 0] }), 'twist-inverted')
refusal('twist beyond PI refused', () => swingTwistLimits({ twist: [-PI, 4] }), 'angle-out-of-range')
refusal('zero frequency refused', () => swingTwistLimits({}, { frequency: 0, damping: 0 }), 'softness-frequency')
refusal('negative damping refused', () => swingTwistLimits({}, { frequency: 2, damping: -1 }), 'softness-damping')

const pass = results.every(Boolean)
console.log(`checks ${results.length} ${pass ? 'all passed' : 'failed'}`)
console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(pass ? 0 : 1)
