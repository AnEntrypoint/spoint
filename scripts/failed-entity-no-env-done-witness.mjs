import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { shouldSendEnvironmentDone } from '../src/shared/modelLoadErrors.js'

assert.equal(shouldSendEnvironmentDone(true, true, false), false, 'a failed load must never send ENVIRONMENT_DONE')
assert.equal(shouldSendEnvironmentDone(true, false, false), false)
assert.equal(shouldSendEnvironmentDone(false, true, false), true)
assert.equal(shouldSendEnvironmentDone(false, false, false), true)
assert.equal(shouldSendEnvironmentDone(false, false, true), false)
const src = readFileSync('client/app.js', 'utf8')
assert.match(src, /if \(failed\) \{/)
assert.match(src, /if \(shouldSendEnvironmentDone\(failed, isEnv, _anyEntityDone\)\) loadingMachine\.send\('ENVIRONMENT_DONE'\)/)
assert.equal(src.indexOf('if (failed)') < src.indexOf('shouldSendEnvironmentDone(failed'), true)
console.log('RESULT: PASS a failed entity load returns before ENVIRONMENT_DONE while a successful load still sends it')
