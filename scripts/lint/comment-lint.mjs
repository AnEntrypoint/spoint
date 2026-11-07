#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tokenize } from '../lib/js-token-stream.mjs'
import { selfTest } from '../comment-sweep-token-witness.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PRAGMA = /@__PURE__|#__PURE__|@ts-|eslint|@vite-ignore|webpackIgnore|sourceMappingURL|@dsCard|@license|@preserve|@jsx|prettier-ignore|istanbul|c8 ignore/
const EXT = /\.(m?js|cjs)$/
const NAMED_CLIENT = ['client/core/ProgramReadiness.js', 'client/core/Vegetation.js']

export function inScope(path) {
  if (NAMED_CLIENT.includes(path)) return true
  if (!EXT.test(path)) return false
  const parts = path.split('/')
  if (parts[0] !== 'scripts') return false
  return parts.length === 2 || (parts.length === 3 && parts[1] === 'lib')
}

export function scopeFiles() {
  return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((p) => p && inScope(p))
}

export function lineOf(text, offset) {
  let line = 1
  for (let i = 0; i < offset; i += 1) if (text.charCodeAt(i) === 10) line += 1
  return line
}

export function lintText(text) {
  const { comments } = tokenize(text)
  const found = comments.filter((c) => c.kind !== 'hashbang')
  const violations = found
    .filter((c) => !PRAGMA.test(c.text))
    .map((c) => ({ line: lineOf(text, c.start), text: c.text.split('\n')[0].slice(0, 120) }))
  const pragmas = found.length - violations.length
  return { violations, pragmas }
}

function main() {
  const control = selfTest()
  if (control.failures.length > 0) {
    console.log('SELF-TEST FAIL: ' + JSON.stringify(control.failures))
    console.log('RESULT: FAIL comment-lint lexer controls')
    process.exitCode = 1
    return
  }
  const files = scopeFiles()
  let total = 0
  let pragmas = 0
  let filesWithComments = 0
  for (const rel of files) {
    const { violations, pragmas: p } = lintText(readFileSync(ROOT + rel, 'utf8'))
    pragmas += p
    if (violations.length > 0) filesWithComments += 1
    for (const v of violations) {
      total += 1
      console.log(rel + ':' + v.line + ': ' + v.text)
    }
  }
  console.log('scope: ' + files.length + ' file(s); files with a comment: ' + filesWithComments + '; pragma comments allowed: ' + pragmas)
  if (total > 0) {
    console.log('RESULT: FAIL ' + total + ' comment(s) listed above')
    process.exitCode = 1
    return
  }
  console.log('RESULT: PASS 0 comment(s) in ' + files.length + ' file(s)')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
