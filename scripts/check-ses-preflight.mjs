import assert from 'node:assert/strict'
import { preflightSes, SandboxUnavailableError } from '../src/sdk/SESCompartmentEvaluator.js'

function FakeCompartment() {}

const ok = await preflightSes({
  importSes: async () => ({}),
  lockdown: () => {},
  getCompartment: () => FakeCompartment,
  isFrozen: () => true,
})
assert.equal(ok.ok, true)
assert.equal(ok.Compartment, FakeCompartment)
assert.equal(ok.reasonCode, null)

const cases = [
  {
    name: 'missing optional dep',
    opts: { importSes: async () => { throw new Error('Cannot find package ses') }, lockdown: () => { throw new Error('must not run') }, getCompartment: () => FakeCompartment, isFrozen: () => true },
    code: 'SES_IMPORT_FAILED',
  },
  {
    name: 'lockdown throws',
    opts: { importSes: async () => ({}), lockdown: () => { throw new Error('lockdown failed') }, getCompartment: () => FakeCompartment, isFrozen: () => true },
    code: 'SES_LOCKDOWN_FAILED',
  },
  {
    name: 'no Compartment',
    opts: { importSes: async () => ({}), lockdown: () => {}, getCompartment: () => null, isFrozen: () => true },
    code: 'SES_COMPARTMENT_MISSING',
  },
  {
    name: 'intrinsics not hardened',
    opts: { importSes: async () => ({}), lockdown: () => {}, getCompartment: () => FakeCompartment, isFrozen: () => false },
    code: 'SES_INTRINSICS_NOT_HARDENED',
  },
]
for (const test of cases) {
  const result = await preflightSes(test.opts)
  assert.equal(result.ok, false, `${test.name} must fail closed`)
  assert.equal(result.Compartment, null, `${test.name} must not return a compartment`)
  assert.equal(result.reasonCode, test.code)
}

let lockdownCalls = 0
const already = await preflightSes({
  importSes: async () => ({}),
  lockdown: () => { lockdownCalls++; throw new Error('SES_ALREADY_LOCKED_DOWN') },
  getCompartment: () => FakeCompartment,
  isFrozen: () => true,
})
assert.equal(already.ok, true, 'an already-locked-down runtime is not a refusal')
assert.equal(lockdownCalls, 1)

const cause = Object.assign(new Error('Cannot find package ses'), { reasonCode: 'SES_IMPORT_FAILED' })
const err = new SandboxUnavailableError('untrusted-app', cause)
assert.equal(err.code, 'SANDBOX_UNAVAILABLE')
assert.equal(err.reasonCode, 'SES_IMPORT_FAILED')
assert.equal(err.cause, cause)
assert.equal(new SandboxUnavailableError('x', new Error('plain')).reasonCode, 'SES_UNAVAILABLE')

console.log(`RESULT: PASS SES preflight distinguishes ${cases.length} failure codes, fails closed, tolerates an already-locked-down runtime and keeps SANDBOX_UNAVAILABLE compatibility`)
