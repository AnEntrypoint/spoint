import assert from 'node:assert/strict'
import { writeAllVerified, verified } from './lib/write-verified.mjs'

const entries = [
  { path: 'a.txt', content: 'alpha' },
  { path: 'b.txt', content: 'beta' },
  { path: 'c.txt', content: 'gamma' },
]

assert.equal(verified('alpha', 'alpha'), true)
assert.equal(verified('', 'alpha'), false)
assert.equal(verified(null, 'alpha'), false)
assert.equal(verified('other', 'alpha'), false)

const store = new Map()
let writes = 0
const flakyWrite = async (path, content) => {
  writes++
  if (path === 'b.txt' && writes <= 3) { store.set(path, ''); return }
  store.set(path, content)
}
const report = await writeAllVerified(entries, flakyWrite, path => store.get(path))
assert.deepEqual(report, { written: 3, retried: 1, attempts: 2, failures: [] })
assert.deepEqual([...store.entries()].sort(), entries.map(e => [e.path, e.content]).sort())

const broken = new Map()
await assert.rejects(
  () => writeAllVerified(entries, async (path) => broken.set(path, ''), path => broken.get(path), { maxAttempts: 2 }),
  e => e.reasonCode === 'write-verification-failed' && e.message.includes('a.txt') && e.message.includes('c.txt'),
)

for (const [call, code] of [
  [() => writeAllVerified([], async () => {}, async () => ''), 'write-empty-batch'],
  [() => writeAllVerified(entries, null, async () => ''), 'write-invalid-hooks'],
  [() => writeAllVerified(entries, async () => {}, async () => '', { maxAttempts: 0 }), 'write-invalid-attempts'],
]) {
  await assert.rejects(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

console.log('RESULT: PASS every output is read back after a parallel write, empty outputs are retried, and a permanent mismatch refuses by code')
