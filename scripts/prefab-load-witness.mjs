import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadPrefabRecords, takeModelLoadErrors } from '../src/shared/modelLoadErrors.js'

takeModelLoadErrors()
const path = '/data/prefabs.json'
assert.deepEqual(loadPrefabRecords({ existsSync: () => false, readFileSync: () => '', path }), [])
assert.deepEqual(loadPrefabRecords({ existsSync: () => true, readFileSync: () => '[{"name":"crate"}]', path }), [{ name: 'crate' }])
assert.throws(
  () => loadPrefabRecords({ existsSync: () => true, readFileSync: () => '{bad', path }),
  e => e.reasonCode === 'model-load-failed' && e.url === path,
)
assert.equal(takeModelLoadErrors().length, 1)
const src = readFileSync('src/sdk/EditorHandlers.js', 'utf8')
assert.match(src, /loadPrefabRecords\(\{ existsSync, readFileSync, path: _prefabsPath\(\) \}\)/)
assert.equal(src.includes("console.error('[prefab] load error:'"), false)
console.log('RESULT: PASS EditorHandlers prefab disk load throws a coded refusal instead of logging and continuing')
