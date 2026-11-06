import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createModelErrorHandler, takeModelLoadErrors } from '../src/shared/modelLoadErrors.js'

takeModelLoadErrors()
const seen = []
const handler = createModelErrorHandler({ onError: err => seen.push(err) })
const err = handler.onError('missing.glb')
assert.equal(err.reasonCode, 'model-load-failed')
assert.equal(err.url, 'missing.glb')
assert.equal(handler.errors.length, 1)
assert.equal(seen.length, 1)
assert.equal(takeModelLoadErrors().length, 1)
assert.throws(() => createModelErrorHandler({ onError: 1 }), e => e.reasonCode === 'model-load-failed')
const src = readFileSync('client/core/SceneSetup.js', 'utf8')
assert.match(src, /createModelErrorHandler\(\{ onError:/)
assert.match(src, /loadingManager\.onError = url => modelErrors\.onError\(url\)/)
assert.match(src, /loadingManager\.modelLoadErrors = modelErrors/)
assert.equal(src.includes("console.warn('[THREE] Failed to load:'"), false)
console.log('RESULT: PASS THREE LoadingManager failures produce a coded refusal in the modelLoadErrors registry')
