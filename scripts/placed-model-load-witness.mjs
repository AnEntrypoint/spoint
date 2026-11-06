import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadPlacedModelRecords, takeModelLoadErrors } from '../src/shared/modelLoadErrors.js'

takeModelLoadErrors()
const fp = '/data/placed-models.json'
const missing = await loadPlacedModelRecords({
  access: async () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e },
  readFile: async () => '',
  fp,
})
assert.deepEqual(missing, [])
assert.equal(takeModelLoadErrors().length, 0, 'a missing saved-model file is not a failure')
const records = await loadPlacedModelRecords({ access: async () => {}, readFile: async () => '[{"id":"a"}]', fp })
assert.deepEqual(records, [{ id: 'a' }])
await assert.rejects(
  () => loadPlacedModelRecords({ access: async () => {}, readFile: async () => 'not json', fp }),
  e => e.reasonCode === 'model-load-failed' && e.url === fp,
)
assert.equal(takeModelLoadErrors().length, 1)
const src = readFileSync('src/sdk/ServerAPI.js', 'utf8')
assert.match(src, /loadPlacedModelRecords\(\{ access, readFile, fp \}\)/)
assert.match(src, /catch \(e\) \{ throw recordModelLoadError\(e\) \}/)
assert.equal(src.includes("}).catch(() => {})"), false)
console.log('RESULT: PASS ServerAPI placed-model load refuses malformed JSON by code, tolerates ENOENT and rethrows')
