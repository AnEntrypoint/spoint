import assert from 'node:assert/strict'
import { createLiveExec, REALMS } from './lib/live-exec.mjs'

const calls = []
const exec = createLiveExec(opts => { calls.push(opts); return { lines: ['ok'] } })
const result = exec.run({ script: 'ctx.now()', realm: 'browser', input: { x: 1 }, out: '/tmp/out.json', place: 'gallery' })
assert.equal(result.ok, true)
assert.equal(result.readOnly, true)
assert.equal(result.persist, false)
assert.equal(result.realm, 'browser')
assert.deepEqual(result.result, { lines: ['ok'] })
assert.equal(calls[0].place, 'gallery')
assert.equal(calls[0].readOnly, true)

const persisted = exec.run({ script: 'save()', persist: true, readOnly: false })
assert.equal(persisted.persist, true)
assert.equal(persisted.readOnly, false)
assert.equal(REALMS.length, 2)

for (const [call, code] of [
  [() => createLiveExec(null), 'exec-hook-invalid'],
  [() => exec.run({ script: '' }), 'exec-script-invalid'],
  [() => exec.run({ script: 'x', realm: 'server' }), 'exec-realm-invalid'],
  [() => exec.run({ script: 'x', persist: true }), 'exec-persist-refused'],
  [() => exec.run({ script: 'x', input: 'bad' }), 'exec-input-invalid'],
  [() => exec.run({ script: 'x', out: 3 }), 'exec-option-invalid'],
]) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

console.log('RESULT: PASS live exec separates read-only from persist, validates realm and options, and refuses by code')
