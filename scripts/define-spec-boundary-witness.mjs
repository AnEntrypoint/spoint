import assert from 'node:assert/strict'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { parseDefineSpec, DEFINE_SPEC_SCHEMAS } = await import('../src/behaviours/specBoundary.js')
const { defineWeapon } = await import('../src/behaviours/weapon.js')
const { definePickup } = await import('../src/behaviours/pickup.js')
const { defineHealth } = await import('../src/behaviours/health.js')
const { defineTeams } = await import('../src/behaviours/teams.js')
const { AppContext } = await import('../src/apps/AppContext.js')

const stub = { debug: { warn() {} }, players: { getAll: () => [] }, entity: { position: [0, 0, 0] } }

const typo = { magazin: 3, typoKey: 1 }
assert.throws(() => defineWeapon(typo, stub), e => e.reasonCode === 'define-spec-unknown-key' && e.field === 'magazin')
assert.throws(() => defineWeapon({ damage: NaN }, stub), e => e.reasonCode === 'define-spec-invalid-field' && e.field === 'damage')
assert.throws(() => defineWeapon({ range: 0 }, stub), e => e.reasonCode === 'define-spec-invalid-field' && e.field === 'range')
assert.throws(() => defineWeapon({ headshotMult: 'fast' }, stub), e => e.reasonCode === 'define-spec-invalid-field' && e.field === 'headshotMult')
const plainWeapon = defineWeapon({}, stub)
assert.equal(plainWeapon.magazine, 0)
assert.equal(plainWeapon.ammo, Infinity)

assert.throws(() => definePickup({}, stub), e => e.reasonCode === 'define-spec-missing-field' && e.field === 'onCollect')
assert.throws(() => definePickup({ onCollect() {}, radius: -1 }, stub), e => e.reasonCode === 'define-spec-invalid-field' && e.field === 'radius')
assert.throws(() => definePickup({ onCollect() {}, cooldown: 'soon' }, stub), e => e.reasonCode === 'define-spec-invalid-field' && e.field === 'cooldown')
assert.ok(definePickup({ onCollect() {} }, stub))

assert.throws(() => defineHealth({}, stub), e => e.reasonCode === 'define-spec-missing-field' && e.field === 'max')
assert.throws(() => defineHealth({ max: 100, hp: 'fast' }, stub), e => e.reasonCode === 'define-spec-invalid-field' && e.field === 'hp')
const health = defineHealth({ max: 100 }, stub)
assert.equal(health.hp, 100)
assert.equal(health.max, 100)

assert.throws(() => defineTeams({ teams: [] }, stub), e => e.reasonCode === 'define-spec-invalid-field' && e.field === 'teams')
assert.throws(() => defineTeams({ teams: ['a'], typo: 1 }, stub), e => e.reasonCode === 'define-spec-unknown-key' && e.field === 'typo')
assert.ok(defineTeams({ teams: ['red', 'blue'], scoreLimit: 5 }, stub))
assert.ok(defineTeams({ teams: ['red'], scoreLimit: null }, stub))

assert.throws(() => AppContext.prototype.defineWeapon.call(stub, { typo: 1 }), e => e.reasonCode === 'define-spec-unknown-key')
assert.throws(() => AppContext.prototype.defineHealth.call(stub, {}), e => e.reasonCode === 'define-spec-missing-field')
assert.throws(() => AppContext.prototype.definePickup.call(stub, { onCollect() {}, typo: 1 }), e => e.reasonCode === 'define-spec-unknown-key')
assert.throws(() => AppContext.prototype.defineTeams.call(stub, { teams: ['a'], typo: 1 }), e => e.reasonCode === 'define-spec-unknown-key')

const parsed = parseDefineSpec('defineWeapon', { damage: 20 }, DEFINE_SPEC_SCHEMAS.weapon)
assert.equal(Object.isFrozen(parsed), true)
assert.equal(parsed.damage, 20)
assert.equal(parsed.range, 100)
assert.equal(parsed.headshotMult, 2)

parseDefineSpec('defineWeapon', { damage: 20, range: 100, fireRateMs: 250, magazine: 0 }, DEFINE_SPEC_SCHEMAS.weapon)
parseDefineSpec('definePickup', { radius: 1.5, oneShot: true, cooldown: 0, onCollect() {} }, DEFINE_SPEC_SCHEMAS.pickup)
parseDefineSpec('defineHealth', { max: 100, onDamage() {}, onDeath() {} }, DEFINE_SPEC_SCHEMAS.health)

console.log('RESULT: PASS shared define* spec boundary refuses typo keys, invalid present values and missing fields across weapon, pickup, health, teams and ctx, with shipped specs still parsing')
