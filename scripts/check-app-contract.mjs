import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkAppContractSource, appContractFiles, FIXTURE_DIR, FIXTURE_EXPECTATIONS } from './lib/app-contract.mjs'

const failures = []
for (const [file, expected] of FIXTURE_EXPECTATIONS) {
  const codes = checkAppContractSource(readFileSync(join(FIXTURE_DIR, file), 'utf8'), file).map(v => v.code)
  const same = codes.length === expected.length && codes.every((c, i) => c === expected[i])
  if (!same) failures.push(`fixture ${file}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(codes)}`)
}
if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}

const files = appContractFiles('apps')
if (files.length === 0) {
  console.error('check-app-contract: no app modules found -- an empty scan is not a pass')
  process.exit(1)
}
const violations = []
for (const file of files) violations.push(...checkAppContractSource(readFileSync(file, 'utf8'), file))
if (violations.length) {
  console.error(JSON.stringify(violations, null, 2))
  process.exit(1)
}
console.log(`RESULT: PASS ${FIXTURE_EXPECTATIONS.length} fixture(s) behave as expected and ${files.length} app module(s) satisfy the node-checked authoring contract`)
