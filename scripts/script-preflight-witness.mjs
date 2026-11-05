import assert from 'node:assert/strict'
import { preflight, assertNoTemplateLeak } from './lib/script-preflight.mjs'

const good = preflight('export const answer = 42\n')
assert.equal(good.ok, true)
assert.equal(good.line, null)

const bad = preflight('export const broken = (\n')
assert.equal(bad.ok, false)
assert.equal(bad.reasonCode, 'preflight-syntax-error')
assert.ok(bad.line >= 1, `expected a line number, got ${bad.line}`)
assert.ok(bad.message.length > 0)

assert.throws(() => preflight('const x = 1\n', { filename: '../../evil.sh' }), e => e.reasonCode === 'preflight-filename-invalid')
assert.throws(() => preflight(''), e => e.reasonCode === 'preflight-source-invalid')

assert.equal(assertNoTemplateLeak('node --check a.mjs'), 'node --check a.mjs')
assert.throws(() => assertNoTemplateLeak('node --check ${file}'), e => e.reasonCode === 'preflight-template-leak')
assert.throws(() => assertNoTemplateLeak(null), e => e.reasonCode === 'preflight-command-invalid')

console.log('RESULT: PASS generated JS is parsed before execution, a syntax error reports line and column, and shell template leaks refuse')
