import { resolveQualityTier, QualityTierError } from '../client/core/QualityTierChoice.js'

let failures = 0
const results = []
function expect(name, ok) {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  if (!ok) failures++
}
function refusedWith(fn, code) {
  try { fn() } catch (e) { return e instanceof QualityTierError && e.reasonCode === code }
  return false
}

expect('auto request resolves to null', resolveQualityTier(null, 5) === null)
expect('in-range request is returned unchanged', resolveQualityTier(2, 5) === 2)
expect('request at creator ceiling is accepted', resolveQualityTier(5, 5) === 5)
expect('tier 0 is accepted under ceiling 0', resolveQualityTier(0, 0) === 0)
expect('request above creator ceiling is refused', refusedWith(() => resolveQualityTier(6, 5), 'out-of-range'))
expect('negative request is refused', refusedWith(() => resolveQualityTier(-1, 5), 'out-of-range'))
expect('string request is refused, not defaulted', refusedWith(() => resolveQualityTier('2', 5), 'bad-request'))
expect('NaN request is refused', refusedWith(() => resolveQualityTier(NaN, 5), 'bad-request'))
expect('fractional request is refused', refusedWith(() => resolveQualityTier(1.5, 5), 'bad-request'))
expect('undefined request is refused', refusedWith(() => resolveQualityTier(undefined, 5), 'bad-request'))
expect('non-integer ceiling is refused', refusedWith(() => resolveQualityTier(1, 2.5), 'bad-ceiling'))
expect('negative ceiling is refused', refusedWith(() => resolveQualityTier(0, -1), 'bad-ceiling'))
expect('missing ceiling is refused', refusedWith(() => resolveQualityTier(0), 'bad-ceiling'))

for (const r of results) console.log(r)
const pass = failures === 0
console.log(pass ? 'RESULT: PASS' : `RESULT: FAIL (${failures})`)
process.exit(pass ? 0 : 1)
