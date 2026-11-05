import assert from 'node:assert/strict'
import { createAgentCommandRegistry, COMMANDS } from './lib/agent-commands.mjs'

const registry = createAgentCommandRegistry({
  numbers: [{ world: 'a', players: 3 }, { world: 'b', players: 1 }],
  logs: [{ level: 'error', object: 'door' }, { level: 'warn', object: 'door' }, { level: 'error', object: 'gate' }],
  events: [{ kind: 'chat_mention', at: '2026-11-05T00:00:00Z' }, { kind: 'push', at: '2026-11-06T00:00:00Z' }],
})
assert.equal(registry.numbers({ world: 'a' }), JSON.stringify({ world: 'a', players: 3 }))
assert.equal(registry.logs({ level: 'error' }).split('\n').length, 2)
assert.equal(registry.logs({ object: 'door', limit: 1 }), JSON.stringify({ level: 'error', object: 'door' }))
assert.equal(registry.events({ kind: 'chat_mention', once: true }), JSON.stringify({ kind: 'chat_mention', at: '2026-11-05T00:00:00Z' }))
assert.equal(registry.events({ since: '2026-11-06T00:00:00Z' }).split('\n').length, 1)
assert.equal(JSON.parse(registry.prefetch({ world: 'a', manifest: 'm', hex: 'ff' })).cached, true)
assert.equal(registry.run('numbers', { world: 'b' }), JSON.stringify({ world: 'b', players: 1 }))
assert.equal(COMMANDS.length, 4)

for (const [call, code] of [
  [() => createAgentCommandRegistry([]), 'agent-sources-invalid'],
  [() => registry.numbers({ nope: 1 }), 'agent-filter-invalid'],
  [() => registry.prefetch({ world: 'a' }), 'agent-prefetch-invalid'],
  [() => registry.run('unknown'), 'agent-command-invalid'],
]) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

console.log('RESULT: PASS agent command registry emits JSON lines for numbers, logs, events and prefetch with bounded filters')
