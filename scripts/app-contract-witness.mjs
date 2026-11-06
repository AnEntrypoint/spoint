import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { checkAppContractSource, appContractFiles } from './lib/app-contract.mjs'

const dir = 'scripts/lib/app-contract-fixtures'
const cases = [
  ['good.js', []],
  ['bad-on-editor-update.js', ['app-contract-on-editor-update']],
  ['bad-low-level-collider.js', ['app-contract-low-level-collider']],
  ['bad-render.js', ['app-contract-render-no-object']],
  ['bad-nested-helper.js', ['app-contract-nested-helper']],
  ['bad-manual-teardown.js', ['app-contract-manual-child-teardown']],
]
for (const [file, expected] of cases) {
  const text = readFileSync(`${dir}/${file}`, 'utf8')
  const codes = checkAppContractSource(text, file).map(v => v.code)
  assert.deepEqual(codes, expected, `${file}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(codes)}`)
}
const files = appContractFiles('apps')
assert.ok(files.length > 20, `the shipped app scan must be non-vacuous, got ${files.length}`)
assert.ok(files.every(f => f.startsWith('apps/')))
const check = readFileSync('scripts/check.mjs', 'utf8')
assert.match(check, /scripts\/check-app-contract\.mjs/)
console.log(`RESULT: PASS app contract linter catches ${cases.length - 1} violation classes, accepts a compliant app and gates ${files.length} shipped app module(s)`)
