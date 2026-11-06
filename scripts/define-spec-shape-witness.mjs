import assert from 'node:assert/strict'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { assertDefineSpecKeys, parseDefineSpec, DEFINE_SPEC_SCHEMAS } = await import('../src/behaviours/specBoundary.js')
const name = 'defineWeapon'

const symbolSpec = { damage: 1, [Symbol('hidden')]: 2 }
assert.throws(() => assertDefineSpecKeys(name, symbolSpec), e => e.reasonCode === 'define-spec-symbol-key')
assert.throws(() => parseDefineSpec(name, symbolSpec, DEFINE_SPEC_SCHEMAS.weapon), e => e.reasonCode === 'define-spec-symbol-key')

const hidden = { damage: 1 }
Object.defineProperty(hidden, 'sneaky', { value: 2, enumerable: false })
assert.throws(() => assertDefineSpecKeys(name, hidden), e => e.reasonCode === 'define-spec-hidden-key' && e.field === 'sneaky')
assert.throws(() => parseDefineSpec(name, hidden, DEFINE_SPEC_SCHEMAS.weapon), e => e.reasonCode === 'define-spec-hidden-key' && e.field === 'sneaky')

const inherited = Object.create({ base: 1 })
inherited.damage = 2
assert.throws(() => assertDefineSpecKeys(name, inherited), e => e.reasonCode === 'define-spec-inherited-key')
assert.throws(() => parseDefineSpec(name, inherited, DEFINE_SPEC_SCHEMAS.weapon), e => e.reasonCode === 'define-spec-inherited-key')

const customProto = Object.create({})
customProto.damage = 3
assert.throws(() => assertDefineSpecKeys(name, customProto), e => e.reasonCode === 'define-spec-inherited-key')
assert.throws(() => parseDefineSpec(name, customProto, DEFINE_SPEC_SCHEMAS.weapon), e => e.reasonCode === 'define-spec-inherited-key')

assert.doesNotThrow(() => assertDefineSpecKeys(name, { damage: 1 }))
assert.doesNotThrow(() => parseDefineSpec(name, { damage: 1 }, DEFINE_SPEC_SCHEMAS.weapon))
assert.doesNotThrow(() => assertDefineSpecKeys(name, Object.assign(Object.create(null), { damage: 1 })))

console.log('RESULT: PASS define* spec objects refuse symbol, hidden and inherited keys in both the key list and typed boundary')
