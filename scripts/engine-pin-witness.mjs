import assert from 'node:assert/strict'
import { readPin, verifyPin } from './lib/pin-manifest.mjs'

const sha = 'a'.repeat(64)
const other = 'b'.repeat(64)
const record = { version: '6.0.0', sha256: sha }
assert.deepEqual(readPin(record), { version: '6.0.0', sha256: sha })
assert.equal(Object.isFrozen(readPin(record)), true)
assert.deepEqual(verifyPin(record, record), { ok: true, reasonCode: null, version: '6.0.0' })
assert.equal(verifyPin(record, { version: '6.0.0', sha256: other }).reasonCode, 'pin-sha-changed-under-same-version')
assert.equal(verifyPin(record, { version: '6.1.0', sha256: other }).reasonCode, 'pin-sha-mismatch')
assert.equal(verifyPin(record, { version: '6.1.0', sha256: sha }).reasonCode, 'pin-version-mismatch')

for (const [call, code] of [
  [() => readPin(null), 'pin-record-invalid'],
  [() => readPin({ version: 'six', sha256: sha }), 'pin-version-invalid'],
  [() => readPin({ version: '6.0.0', sha256: 'ABC' }), 'pin-sha-invalid'],
]) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

console.log('RESULT: PASS engine pin verifier refuses a changed sha under the same semver and reads a frozen record')
