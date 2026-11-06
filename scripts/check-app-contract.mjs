import { readFileSync } from 'node:fs'
import { checkAppContractSource, appContractFiles } from './lib/app-contract.mjs'

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
console.log(`RESULT: PASS ${files.length} app module(s) satisfy the node-checked authoring contract`)
