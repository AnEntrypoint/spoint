import assert from 'node:assert/strict'
import { createHelpRegistry } from './lib/cli-help.mjs'

const registry = createHelpRegistry([
  { name: 'client', help: 'Stand a body in a world and drive it.' },
  { name: 'events', help: 'Stream the live inbox as JSON lines.' },
  { name: 'api', help: 'Print a spec type at the pinned engine version.' },
])
assert.deepEqual(registry.names(), ['client', 'events', 'api'])
assert.deepEqual(registry.help('client'), { ok: true, exitCode: 0, name: 'client', body: 'Stand a body in a world and drive it.' })
assert.deepEqual(registry.help('missing'), { ok: false, reasonCode: 'cli-unknown-verb', name: 'missing' })
assert.deepEqual(registry.verify(), { ok: true, count: 3, distinct: 3 })

for (const [call, code] of [
  [() => createHelpRegistry([]), 'cli-verbs-invalid'],
  [() => createHelpRegistry([{ name: '', help: 'x' }]), 'cli-verb-invalid'],
  [() => createHelpRegistry([{ name: 'a', help: '' }]), 'cli-help-invalid'],
  [() => createHelpRegistry([{ name: 'a', help: 'x' }, { name: 'a', help: 'y' }]), 'cli-duplicate'],
  [() => createHelpRegistry([{ name: 'a', help: 'x' }, { name: 'b', help: 'x' }]), 'cli-help-duplicate'],
]) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

console.log('RESULT: PASS per-verb CLI help registry answers --help with exit 0 and refuses duplicates or empty bodies')
