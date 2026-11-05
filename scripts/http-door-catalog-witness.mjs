import assert from 'node:assert/strict'
import { createDoorCatalog } from './lib/http-door-catalog.mjs'

const catalog = createDoorCatalog([
  { path: '/api/agent/v1/me', method: 'GET', auth: 'bearer', exercised: true, writes: false },
  { path: '/api/agent/v1/me', method: 'PATCH', auth: 'bearer', exercised: false, writes: true },
  { path: '/api/sdk/v1/logs', method: 'GET', auth: 'bearer', exercised: true, writes: false },
])
assert.equal(catalog.rows().length, 3)
assert.deepEqual(catalog.unexercised(), ['PATCH /api/agent/v1/me'])
assert.deepEqual(catalog.verifyNoWrites(), { ok: true, reasonCode: null, violations: [] })

const violated = createDoorCatalog([
  { path: '/api/games/publish', method: 'POST', auth: 'bearer', exercised: true, writes: true },
])
assert.equal(violated.verifyNoWrites().ok, false)
assert.deepEqual(violated.verifyNoWrites().violations, ['POST /api/games/publish'])

for (const [call, code] of [
  [() => createDoorCatalog([]), 'door-doors-invalid'],
  [() => createDoorCatalog([null]), 'door-entry-invalid'],
  [() => createDoorCatalog([{ path: 'me', method: 'GET' }]), 'door-path-invalid'],
  [() => createDoorCatalog([{ path: '/x', method: 'TRACE' }]), 'door-method-invalid'],
  [() => createDoorCatalog([{ path: '/x', method: 'GET', auth: 3 }]), 'door-auth-invalid'],
  [() => createDoorCatalog([{ path: '/x', method: 'GET', exercised: 'yes' }]), 'door-flags-invalid'],
]) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

console.log('RESULT: PASS HTTP door catalog records method, auth, exercised status and enforces the no-write policy')
