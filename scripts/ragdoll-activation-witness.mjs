import assert from 'node:assert/strict'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { parseRagdollActivation, applyRagdollActivation, RagdollActivationError } = await import('../src/animation/ragdollActivation.js')
const { RAGDOLL_JOINTS } = await import('../src/animation/RagdollPose.js')

const plan = parseRagdollActivation({ all: 0.5, bones: { head: { strength: 0.2 }, leftLowerLeg: 0 } })
assert.equal(plan.strengths.head, 0.2, 'per-bone strength object wins')
assert.equal(plan.strengths.leftLowerLeg, 0, 'per-bone number wins')
assert.equal(plan.strengths.spine, 0.5, 'unnamed joints take all')
assert.equal(Object.keys(plan.strengths).length, RAGDOLL_JOINTS.length)

const calls = new Map()
const stub = { setStrength(name, v) { calls.set(name, v); return this }, setAll(v) { calls.set('*', v); return this } }
applyRagdollActivation(stub, plan)
assert.equal(calls.get('head'), 0.2, 'applied per bone')
assert.equal(calls.get('chest'), 0.5, 'applied per bone for unnamed joints')

applyRagdollActivation(stub, parseRagdollActivation({ active: false }))
assert.equal(calls.get('*'), 0, 'inactive plan drops every joint to zero')

for (const [spec, code] of [
  [{ bones: { tail: 1 } }, 'unknown-bone'],
  [{ bones: { head: { strength: 2 } } }, 'strength-invalid'],
  [{ all: NaN }, 'strength-invalid'],
  [{ bones: [] }, 'bones-invalid'],
]) assert.throws(() => parseRagdollActivation(spec), e => e instanceof RagdollActivationError && e.reasonCode === code, code)

console.log(`RESULT: PASS ragdoll activation maps ${RAGDOLL_JOINTS.length} joints with per-bone strength, an inactive plan zeroes every joint, and unknown bones or strengths outside [0, 1] refuse with codes`)
