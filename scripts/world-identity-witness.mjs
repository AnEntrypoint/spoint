import assert from 'node:assert/strict'
import { resolveWorldIdentity } from './lib/world-identity.mjs'

const good = resolveWorldIdentity({
  agentsH1: '# The Savi Gallery',
  configName: 'The Savi Gallery',
  docsName: 'The Savi Gallery',
  appId: 'd21d322b',
  worldId: '26f64424',
})
assert.deepEqual(good, { ok: true, reasonCode: null, name: 'The Savi Gallery', appId: 'd21d322b', worldId: '26f64424' })

const mismatched = resolveWorldIdentity({ agentsH1: '# game-6', configName: 'The Savi Gallery', docsName: 'game-6', appId: 'a', worldId: 'b' })
assert.equal(mismatched.reasonCode, 'world-identity-mismatch')
assert.equal(mismatched.names.configName, 'The Savi Gallery')

assert.equal(resolveWorldIdentity({ agentsH1: 'x', configName: 'x', docsName: 'x', appId: 'same', worldId: 'same' }).reasonCode, 'world-identity-ids-collide')

for (const [call, code] of [
  [() => resolveWorldIdentity({ agentsH1: '', configName: 'x', docsName: 'x', appId: 'a', worldId: 'b' }), 'identity-field-invalid'],
  [() => resolveWorldIdentity({ agentsH1: 'x', configName: 'x', docsName: 'x', appId: 'a' }), 'identity-field-invalid'],
]) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

console.log('RESULT: PASS world identity refuses a mismatch between AGENTS.md, world config, docs and ids')
