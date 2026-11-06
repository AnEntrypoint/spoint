import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { checkAppContractSource, appContractFiles, FIXTURE_DIR, FIXTURE_EXPECTATIONS } from './lib/app-contract.mjs'

for (const [file, expected] of FIXTURE_EXPECTATIONS) {
  const codes = checkAppContractSource(readFileSync(`${FIXTURE_DIR}/${file}`, 'utf8'), file).map(v => v.code)
  assert.deepEqual(codes, expected, `${file}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(codes)}`)
}
const files = appContractFiles('apps')
assert.ok(files.length > 20, `the shipped app scan must be non-vacuous, got ${files.length}`)
assert.ok(files.every(f => f.startsWith('apps/')))
const check = readFileSync('scripts/check.mjs', 'utf8')
assert.match(check, /scripts\/check-app-contract\.mjs/)
console.log(`RESULT: PASS app contract linter catches ${FIXTURE_EXPECTATIONS.length - 1} violation classes, accepts a compliant app and gates ${files.length} shipped app module(s)`)
