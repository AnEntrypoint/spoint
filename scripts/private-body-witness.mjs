import assert from 'node:assert/strict'
import { redactBody, redactRawBodies } from './lib/private-body.mjs'

const body = { token: 'super-secret', email: 'person@example.invalid', friends: [{ name: 'hidden' }], count: 7 }
const redacted = redactBody(body, ['count'])
assert.deepEqual(redacted.keys, ['count', 'email', 'friends', 'token'])
assert.equal(redacted.dropped, 4)
assert.deepEqual(redacted.allowlistedKeys, ['count'])
const text = JSON.stringify(redacted)
for (const secret of ['super-secret', 'person@example.invalid', 'hidden', '7']) {
  assert.equal(text.includes(secret), false, `a value leaked through the redaction: ${secret}`)
}

const entries = redactRawBodies([
  { path: 'http/raw/me.json', body, allowlist: ['count'] },
  { path: 'http/raw/notifications.json', body: { unread: 3 } },
])
assert.equal(entries.length, 2)
assert.equal(entries[0].path, 'http/raw/me.json')
assert.deepEqual(entries[1].keys, ['unread'])
assert.equal(JSON.stringify(entries).includes('super-secret'), false)

for (const [call, code] of [
  [() => redactBody('not an object'), 'private-body-invalid'],
  [() => redactBody(body, [1]), 'private-allowlist-invalid'],
  [() => redactRawBodies({}), 'private-body-invalid'],
  [() => redactRawBodies([{ body }]), 'private-entry-invalid'],
]) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

console.log('RESULT: PASS raw HTTP bodies export only key names, values are dropped, and the allowlist is explicit')
