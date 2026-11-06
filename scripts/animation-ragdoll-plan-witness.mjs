import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { AnimationSystem } = await import('../src/animation/AnimationSystem.js')
const { parseRagdollActivation } = await import('../src/animation/ragdollActivation.js')

const applied = []
const fakeRagdoll = { setStrength(name, v) { applied.push([name, v]); return this }, setAll() { return this } }
const sys = Object.create(AnimationSystem.prototype)
sys.createRagdoll = function () { this.ragdoll = fakeRagdoll; return fakeRagdoll }
sys.setRagdollPlan(parseRagdollActivation({ all: 0.4, bones: { head: 0.1 } }))
assert.deepEqual(applied.find(([n]) => n === 'head'), ['head', 0.1], 'the plan sets the per-bone strength on the pose')
assert.deepEqual(applied.find(([n]) => n === 'chest'), ['chest', 0.4], 'unnamed joints take the all strength')
assert.throws(() => sys.setRagdollPlan(null), e => e.reasonCode === 'plan-invalid')
assert.match(readFileSync('src/animation/AnimationSystem.js', 'utf8'), /setRagdollPlan\(plan\)/)
console.log('RESULT: PASS AnimationSystem.setRagdollPlan creates the pose when missing and applies a parsed plan per joint; a non-plan refuses with plan-invalid')
