import assert from 'node:assert/strict'
import { countRows, assertClaimedCount, coverageVerdict } from './lib/count-verifier.mjs'

const files = new Map([
  ['a.md', '- [x] one\n- [ ] two\nprose'],
  ['b.md', '- [ ] three'],
  ['c.md', 'no rows here'],
])
const counted = countRows([...files.keys()], path => files.get(path))
assert.equal(counted.total, 3)
assert.deepEqual(counted.perFile, [
  { path: 'a.md', rows: 2 },
  { path: 'b.md', rows: 1 },
  { path: 'c.md', rows: 0 },
])
assert.deepEqual(assertClaimedCount({ claimed: 3, computed: counted.total }), { ok: true, claimed: 3, computed: 3 })

assert.throws(() => assertClaimedCount({ claimed: 4, computed: counted.total }), e => e.reasonCode === 'count-mismatch')
assert.throws(() => assertClaimedCount({ claimed: -1, computed: counted.total }), e => e.reasonCode === 'count-claim-invalid')
assert.throws(() => countRows('no', path => files.get(path)), e => e.reasonCode === 'count-input-invalid')
assert.throws(() => countRows(['a.md'], () => null), e => e.reasonCode === 'count-read-invalid')

assert.deepEqual(coverageVerdict({ expected: 3, found: 3 }), { complete: true, short: 0, gaps: 0, openItems: 0 })
assert.deepEqual(coverageVerdict({ expected: 5, found: 3, gaps: ['missing b'], openItems: ['row 4'] }), { complete: false, short: 2, gaps: 1, openItems: 1 })

console.log('RESULT: PASS counts are recomputed from files, a short report refuses the no-gaps claim, and coverage refuses incomplete sets')
