import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { refuseModelLoad, takeModelLoadErrors } from '../src/shared/modelLoadErrors.js'

takeModelLoadErrors()
const cause = new Error('404 Not Found')
const refusal = refuseModelLoad('arena.glb', cause)
assert.equal(refusal.reasonCode, 'model-load-failed')
assert.equal(refusal.url, 'arena.glb')
assert.equal(refusal.cause, cause)
assert.equal(takeModelLoadErrors()[0], refusal)
const src = readFileSync('client/EntityLoader.js', 'utf8')
assert.match(src, /const refusal = refuseModelLoad\(url, err\); console\.error\('\[gltf\]'/)
assert.match(src, /onFirstEntityLoaded\(entityId, true, refusal\)/)
assert.equal(src.includes("console.warn('[prefetch]', url, e.message)"), false)
console.log('RESULT: PASS EntityLoader records and propagates the coded model-load refusal to the first-entity handler')
