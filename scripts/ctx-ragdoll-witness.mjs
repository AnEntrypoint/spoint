import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { AppContext } = await import('../src/apps/AppContext.js')
assert.equal(typeof AppContext.prototype.ragdoll, 'function', 'ctx.ragdoll must be exposed')
const entity = { id: 'npc-1', custom: {} }
const fake = Object.create(AppContext.prototype)
fake._entity = entity
const plan = fake.ragdoll({ all: 0.5, bones: { head: { strength: 0.1 } } })
assert.equal(entity.custom._ragdoll, plan, 'the plan is written to the entity custom block')
assert.equal(plan.strengths.head, 0.1)
assert.throws(() => fake.ragdoll({ bones: { tail: 1 } }), e => e.reasonCode === 'unknown-bone')
assert.equal(entity.custom._ragdoll, plan, 'a refused spec leaves the previous plan in place')
assert.match(readFileSync('src/apps/AppContext.js', 'utf8'), /import \{ parseRagdollActivation \} from '..\/animation\/ragdollActivation.js'/)
console.log('RESULT: PASS ctx.ragdoll validates the spec and writes the plan to the entity custom block; an unknown bone refuses with unknown-bone and keeps the previous plan')
