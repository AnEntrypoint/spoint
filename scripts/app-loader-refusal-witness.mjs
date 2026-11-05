import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppLoader } from '../src/apps/AppLoader.js'

const GOOD = 'refusal-good'
const BLOCKED = 'refusal-blocked'
const PATTERN = 'child_process'
const REASON_CODE = 'app-source-blocked-pattern'

const scratch = mkdtempSync(join(tmpdir(), 'spoint-app-loader-refusal-'))
const registered = []
const runtime = { registerApp(name) { registered.push(name) } }
const consoleErrors = []
const originalError = console.error

try {
  writeFileSync(join(scratch, 'package.json'), '{"type":"module"}\n')
  writeFileSync(join(scratch, `${GOOD}.js`), `export default { name: '${GOOD}' }\n`)
  writeFileSync(join(scratch, `${BLOCKED}.js`), `export default { marker: '${PATTERN}' }\n`)

  console.error = (...args) => { consoleErrors.push(args.map(String).join(' ')) }
  const loader = new AppLoader(runtime, { dir: scratch })
  const result = await loader.loadAll()
  console.error = originalError

  assert.ok(Array.isArray(result.loaded), 'loadAll() must keep its loaded array')
  assert.ok(Array.isArray(result.failed), 'loadAll() must keep its failed array')
  assert.deepEqual(result.loaded, [GOOD], `good app must load: ${JSON.stringify(result)}`)
  assert.deepEqual(result.failed, [BLOCKED], `blocked app must fail: ${JSON.stringify(result)}`)
  assert.deepEqual(registered, [GOOD], 'only the good app may register')

  assert.ok(Array.isArray(result.refusals), 'loadAll() must return a refusals array')
  assert.equal(result.refusals.length, 1, `expected exactly one refusal: ${JSON.stringify(result.refusals)}`)
  const refusal = result.refusals[0]
  assert.equal(typeof refusal.reasonCode, 'string', 'refusal.reasonCode must be a string')
  assert.equal(refusal.reasonCode, REASON_CODE, `refusal.reasonCode must be stable: ${refusal.reasonCode}`)
  assert.equal(refusal.app, BLOCKED, `refusal must name the app: ${JSON.stringify(refusal)}`)
  assert.equal(refusal.pattern, PATTERN, `refusal must carry the matched pattern: ${JSON.stringify(refusal)}`)
  assert.ok(consoleErrors.some(line => line.includes('[AppLoader] blocked pattern')),
    `console.error compatibility message missing: ${JSON.stringify(consoleErrors)}`)

  console.log(`RESULT: PASS loadAll() keeps loaded/failed and refusals[0].reasonCode=${refusal.reasonCode} names ${refusal.app} for pattern ${refusal.pattern}`)
} finally {
  console.error = originalError
  rmSync(scratch, { recursive: true, force: true })
}
