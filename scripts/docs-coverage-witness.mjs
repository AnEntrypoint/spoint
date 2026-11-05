import assert from 'node:assert/strict'
import { buildCoverageReport } from './lib/coverage-report.mjs'

const report = buildCoverageReport({
  title: 'Coverage: expected against found',
  areas: [
    { name: 'Tome headings', expected: 68, found: 68, gaps: [] },
    { name: 'Skills', expected: 23, found: 23, gaps: [] },
    { name: 'HTTP doors', expected: 60, found: 53, gaps: ['7 write doors not exercised'] },
  ],
  openItems: ['verify the skill JSON set'],
})
assert.match(report.markdown, /^# Coverage: expected against found/)
assert.match(report.markdown, /\| Tome headings \| 68 \| 68 \| Matches \|/)
assert.match(report.markdown, /\| HTTP doors \| 60 \| 53 \| Short \|/)
assert.match(report.markdown, /Total gaps: 1\. Open items: 1\./)
assert.match(report.markdown, /Is this complete: NO\./)
assert.equal(report.complete, false)
assert.equal(report.totalGaps, 1)
assert.equal(report.shortAreas, 1)

const clean = buildCoverageReport({ title: 'Clean', areas: [{ name: 'All', expected: 3, found: 3 }] })
assert.equal(clean.complete, true)
assert.match(clean.markdown, /Is this complete: YES\./)

for (const [call, code] of [
  [() => buildCoverageReport({ title: '', areas: [] }), 'coverage-title-invalid'],
  [() => buildCoverageReport({ title: 'x', areas: [] }), 'coverage-areas-invalid'],
  [() => buildCoverageReport({ title: 'x', areas: [{}] }), 'coverage-area-invalid'],
  [() => buildCoverageReport({ title: 'x', areas: [{ name: 'a', expected: -1, found: 0 }] }), 'coverage-count-invalid'],
  [() => buildCoverageReport({ title: 'x', areas: [{ name: 'a', expected: 1, found: 1 }], openItems: [1] }), 'coverage-open-invalid'],
]) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

console.log('RESULT: PASS coverage report counts expected versus found, lists gaps and refuses a complete verdict when short')
