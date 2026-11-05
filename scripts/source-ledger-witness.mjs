import assert from 'node:assert/strict'
import { createSourceLedger, fromJSONL } from './lib/source-ledger.mjs'

const ledger = createSourceLedger()
assert.equal(ledger.append({ id: 'a', at: '2026-11-05T00:00:00Z', url: 'https://example.invalid/1' }), 1)
assert.equal(ledger.append({ id: 'b', at: '2026-11-06T00:00:00Z', url: 'https://example.invalid/2' }), 2)
assert.equal(ledger.cursor(), '2026-11-06T00:00:00Z')
assert.equal(ledger.size(), 2)
const jsonl = ledger.toJSONL()
assert.equal(jsonl.split('\n').filter(Boolean).length, 2)
const restored = fromJSONL(jsonl)
assert.deepEqual(restored.rows(), ledger.rows())
assert.equal(restored.cursor(), ledger.cursor())

assert.throws(() => ledger.append({ id: 'a', at: '2026-11-05T00:00:00Z', url: 'x' }), e => e.reasonCode === 'ledger-duplicate')
assert.throws(() => ledger.append({ id: 'c', at: '2026-11-05T12:00:00Z', url: 'x' }), e => e.reasonCode === 'ledger-cursor-invalid')
assert.throws(() => ledger.append({ id: '', at: 'z', url: 'x' }), e => e.reasonCode === 'ledger-id-invalid')
assert.throws(() => ledger.append({ id: 'c', at: 'z', url: '' }), e => e.reasonCode === 'ledger-url-invalid')
assert.throws(() => fromJSONL('not json'), e => e.reasonCode === 'ledger-line-invalid')
assert.throws(() => fromJSONL('[]\n'), e => e.reasonCode === 'ledger-line-invalid')
assert.throws(() => createSourceLedger('no'), e => e.reasonCode === 'ledger-records-invalid')

console.log('RESULT: PASS JSONL source ledger dedupes by id+at, keeps a monotonic cursor and round-trips')
