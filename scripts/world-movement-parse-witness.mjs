import { parseWorld, assertWorld, validateMovement, WorldResolveError, WORLD_FIELD_INVALID, WORLD_NOT_A_PLAIN_OBJECT } from '../src/shared/worldResolve.js'
import { DEFAULT_MOVEMENT } from '../src/shared/movement.js'
import tps from '../src/presets/tps.js'

const failures = []
let probes = 0
let admitted = 0
let refused = 0

const expect = (actual, expected, label) => {
  if (!Object.is(actual, expected)) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
const expectOk = (condition, label) => {
  if (condition !== true) failures.push(`${label}: expected true, got ${String(condition)}`)
}
const parsed = world => { probes += 1; return parseWorld(world) }
const validated = movement => { probes += 1; return validateMovement(movement) }
const asserted = (world, name) => { probes += 1; return assertWorld(world, name) }

const CORE_FIELDS = Object.keys(DEFAULT_MOVEMENT)
const EXTENSION_FIELDS = [
  'crouchSpeedMul', 'coyoteTime', 'jumpBuffer', 'slideMinSpeed',
  'airMaxSpeed', 'airSpeedCap', 'collisionRestitution', 'collisionDamping'
]
const INVALID_VALUES = [
  ['Infinity', Infinity], ['-Infinity', -Infinity], ['NaN', NaN], ['zero', 0], ['negative', -1],
  ['string', 'fast'], ['null', null], ['undefined', undefined], ['boolean', true],
  ['array', [7]], ['object', { value: 7 }], ['function', () => 7], ['symbol', Symbol('fast')]
]
const UNKNOWN_FIELDS = ['maxSpeeed', 'turboBoost', 'sprintSpeeed', 'maxspeed', '__proto__', 'constructor', 'toString', '0']
const BAD_SLICES = [
  ['null', null], ['array', [7]], ['string', 'fast'], ['number', 7],
  ['boolean', true], ['function', () => ({})]
]
const OTHER_SLICE_CASES = [
  [{ name: 'w', player: { capsuleRadius: -1 } }, 'player.capsuleRadius'],
  [{ name: 'w', tickRate: 0 }, 'tickRate'],
  [{ name: 'w', gravity: [0, NaN, 0] }, 'gravity'],
  [{ name: 'w', camera: 5 }, 'camera'],
  [{ name: 'w', scene: null }, 'scene'],
  [{ name: 'w', animation: [] }, 'animation'],
  [{ name: 'w', input: 3 }, 'input'],
  [{ name: 'w', equipment: ['a', 'a'] }, 'equipment'],
  [{ name: 'w', planetRadius: -1 }, 'planetRadius']
]

const refusalPath = field => field === 'movement' ? 'movement' : `movement.${field}`
const checkRefusal = (result, field, label) => {
  expect(result.ok, false, `${label}.ok`)
  expect(result.code, WORLD_FIELD_INVALID, `${label}.code`)
  expect(result.reasonCode, WORLD_FIELD_INVALID, `${label}.reasonCode`)
  expect(result.field, field, `${label}.field`)
  expect(result.path, refusalPath(field), `${label}.path`)
  expectOk(typeof result.reason === 'string' && result.reason.includes(refusalPath(field)), `${label}.reason names ${refusalPath(field)}`)
}

const acceptWorld = (world, label, movement) => {
  const r = parsed(world)
  expect(r.ok, true, `${label}.ok`)
  if (r.ok) {
    for (const field of Object.keys(movement)) {
      if (movement[field] === null) continue
      expect(r.world.movement[field], movement[field], `${label}.${field}`)
    }
  }
  admitted += 1
  return r
}

acceptWorld({ name: 'w' }, 'absent-movement', {})
acceptWorld({ name: 'w', movement: undefined }, 'undefined-movement', {})
acceptWorld({ name: 'w', movement: {} }, 'empty-movement', {})
acceptWorld({ name: 'w', movement: { ...DEFAULT_MOVEMENT } }, 'full-default-movement', DEFAULT_MOVEMENT)
acceptWorld({ name: 'w', movement: { maxSpeed: 0.5, friction: 1e-9 } }, 'partial-movement', { maxSpeed: 0.5, friction: 1e-9 })
acceptWorld({ name: 'tutorial-rpg', movement: { maxSpeed: 5, groundAccel: 15, airAccel: 2, friction: 8, stopSpeed: 1, jumpImpulse: 5 } }, 'shipped-tutorial-movement', { maxSpeed: 5, groundAccel: 15, airAccel: 2, friction: 8, stopSpeed: 1, jumpImpulse: 5 })
const shipped = acceptWorld({ name: 'tps-game', movement: { ...tps.movement } }, 'shipped-tps-preset', tps.movement)
expectOk(shipped.ok && Object.values(shipped.world.movement).every(v => typeof v === 'number' && Number.isFinite(v) && v > 0), 'shipped tps movement parses to finite positive numbers')
expectOk(Object.keys(tps.movement).every(k => CORE_FIELDS.includes(k) || EXTENSION_FIELDS.includes(k)), 'every shipped tps movement key is a declared field')

for (const field of CORE_FIELDS) {
  const valid = { ...DEFAULT_MOVEMENT, [field]: 3.25 }
  acceptWorld({ name: 'w', movement: valid }, `core-valid-${field}`, valid)
  for (const [tag, value] of INVALID_VALUES) {
    const record = { ...DEFAULT_MOVEMENT, [field]: value }
    const label = `core-invalid-${field}-${tag}`
    checkRefusal(parsed({ name: 'w', movement: record }), field, `${label}.parseWorld`)
    refused += 1
    checkRefusal(validated(record), field, `${label}.validateMovement`)
    refused += 1
  }
  let threw = false
  try {
    asserted({ name: 'w', movement: { ...DEFAULT_MOVEMENT, [field]: NaN } }, 'w')
  } catch (e) {
    threw = true
    expectOk(e instanceof WorldResolveError, `core-assert-${field}.errorClass`)
    expect(e.code, WORLD_FIELD_INVALID, `core-assert-${field}.code`)
    expect(e.reasonCode, WORLD_FIELD_INVALID, `core-assert-${field}.reasonCode`)
    expect(e.field, field, `core-assert-${field}.field`)
    expect(e.path, `movement.${field}`, `core-assert-${field}.path`)
    expectOk(typeof e.message === 'string' && e.message.includes(`movement.${field}`), `core-assert-${field}.message names the field`)
  }
  expectOk(threw, `core-assert-${field} throws`)
}

for (const field of UNKNOWN_FIELDS) {
  const record = { [field]: 7 }
  checkRefusal(parsed({ name: 'w', movement: record }), field, `unknown-${field}.parseWorld`)
  refused += 1
  checkRefusal(validated(record), field, `unknown-${field}.validateMovement`)
  refused += 1
}

for (const [tag, value] of BAD_SLICES) {
  checkRefusal(parsed({ name: 'w', movement: value }), 'movement', `slice-${tag}.parseWorld`)
  refused += 1
  checkRefusal(validated(value), 'movement', `slice-${tag}.validateMovement`)
  refused += 1
}

for (const field of EXTENSION_FIELDS) {
  const valid = { [field]: 1.5 }
  acceptWorld({ name: 'w', movement: valid }, `extension-valid-${field}`, valid)
  checkRefusal(parsed({ name: 'w', movement: { ...DEFAULT_MOVEMENT, [field]: 'fast' } }), field, `extension-invalid-${field}`)
  refused += 1
  const sentinel = parsed({ name: 'w', movement: { ...DEFAULT_MOVEMENT, [field]: null } })
  expect(sentinel.ok, true, `extension-null-${field}.ok`)
  expect(sentinel.ok ? sentinel.world.movement[field] : 'no-world', undefined, `extension-null-${field} is dropped from the parsed record`)
  admitted += 1
}

for (const [world, path] of OTHER_SLICE_CASES) {
  const r = parsed(world)
  expect(r.ok, false, `other-slice-${path}.ok`)
  expect(r.code, WORLD_FIELD_INVALID, `other-slice-${path}.code`)
  expect(r.path, path, `other-slice-${path}.path`)
  refused += 1
}
expect(parsed(null).code, WORLD_NOT_A_PLAIN_OBJECT, 'world-not-a-plain-object.code')
expect(parsed([]).code, WORLD_NOT_A_PLAIN_OBJECT, 'world-array.code')

let assertedGood = null
try {
  assertedGood = asserted({ name: 'w', movement: { ...DEFAULT_MOVEMENT } }, 'w')
} catch (e) {
  failures.push(`assertWorld on a valid movement record threw: ${e.message}`)
}
expectOk(assertedGood !== null && assertedGood.movement.maxSpeed === DEFAULT_MOVEMENT.maxSpeed, 'assertWorld returns the parsed movement record')

const summary = `${probes} parseWorld/validateMovement/assertWorld probes: ${admitted} admitted, ${refused} refused; ${CORE_FIELDS.length} DEFAULT_MOVEMENT fields x ${INVALID_VALUES.length} invalid values; ${EXTENSION_FIELDS.length} optional fields; ${UNKNOWN_FIELDS.length} unknown keys; every refusal code=reasonCode=${WORLD_FIELD_INVALID} with field and a movement.<field> path; shipped tps and tutorial movement parse; other slices unchanged`
if (failures.length) {
  console.log(`RESULT: FAIL (${failures.length} assertion(s) failed over ${summary})`)
  for (const f of failures.slice(0, 20)) console.error(`  ${f}`)
  process.exitCode = 1
} else {
  console.log(`RESULT: PASS (${summary})`)
}
