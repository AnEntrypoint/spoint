#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const SCOPE_DIRS = ['src', 'client', 'apps', 'bin', 'scripts']
const SCANNED_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.css']
const MIN_SCOPE_FILES = 200

const EXEMPT_PREFIXES = ['client/vendor/']
const EXEMPT_FILES = [
  'client/editor/wm/wm.css',
  'client/editor/sdk-typings.generated.d.ts',
]

const SWEPT_FILES = [
  'client/core/QualityGovernor.js',
]

const PENDING_FILES = [
  ['src/apps/CustomVersion.js', 'held-dirty-another-lane'],
  ['src/behaviours/steering.js', 'held-dirty-another-lane'],
  ['src/sharding/ClusterHandoff.js', 'held-dirty-another-lane'],
  ['client/core/Vegetation.js', 'held-dirty-another-lane'],
  ['scripts/quality-governor-witness.mjs', 'witness-expectation-prose-routes-to-agents-md'],
  ['scripts/render-debug-panel-witness.mjs', 'witness-expectation-prose-routes-to-agents-md'],
  ['scripts/AnimationController-witness.mjs', 'witness-expectation-prose-routes-to-agents-md'],
  ['scripts/fireWeather-witness.mjs', 'witness-expectation-prose-routes-to-agents-md'],
  ['scripts/SpointCoreLib-witness.mjs', 'witness-expectation-prose-routes-to-agents-md'],
]

const MUTANT_TARGET = 'client/core/QualityGovernor.js'
const MUTANT_LINE = '/'.repeat(2) + ' mutant: re-introduced by scripts/comment-sweep-invariant-3-witness.mjs'

function isExempt(p) {
  if (EXEMPT_FILES.indexOf(p) !== -1) return true
  return EXEMPT_PREFIXES.some(function (pre) { return p.indexOf(pre) === 0 })
}

function isPending(p) {
  return PENDING_FILES.some(function (e) { return e[0] === p })
}

function isSwept(p) {
  return SWEPT_FILES.indexOf(p) !== -1
}

function isIdLike(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '$'
}

function scanComments(text, ext) {
  const css = ext === '.css'
  const found = []
  const n = text.length
  let i = 0
  let line = 1
  let quote = ''
  let prev = ''
  while (i < n) {
    const c = text[i]
    if (quote !== '') {
      if (c === '\\') { i += 2; continue }
      if (c === '\n') { line++; i++; continue }
      if (c === quote) quote = ''
      i++
      continue
    }
    if (c === '\n' || c === ' ' || c === '\t' || c === '\r') {
      if (c === '\n') line++
      i++
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      if (css) { i += 2; prev = '/'; continue }
      if (i > 0 && text[i - 1] === ':') { i += 2; continue }
      const startLine = line
      let j = i
      while (j < n && text[j] !== '\n') j++
      found.push({ line: startLine, text: text.slice(i, j).trim() })
      i = j
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const startLine = line
      let j = i + 2
      while (j < n && !(text[j] === '*' && text[j + 1] === '/')) {
        if (text[j] === '\n') line++
        j++
      }
      found.push({ line: startLine, text: text.slice(i, Math.min(j + 2, n)).trim() })
      i = Math.min(j + 2, n)
      continue
    }
    if (!css && c === '/' && (prev === '' || !(isIdLike(prev) || prev === ')' || prev === ']'))) {
      let j = i + 1
      let inClass = false
      let closed = false
      while (j < n && text[j] !== '\n') {
        const d = text[j]
        if (d === '\\') { j += 2; continue }
        if (inClass) { if (d === ']') inClass = false; j++; continue }
        if (d === '[') { inClass = true; j++; continue }
        if (d === '/') { closed = true; j++; break }
        j++
      }
      if (closed) { i = j; prev = '/'; continue }
    }
    if (c === '\'' || c === '"' || c === '`') { quote = c; i++; continue }
    prev = c
    i++
  }
  return found
}

const argv = process.argv.slice(2)
const mutant = argv.indexOf('--mutant') !== -1
const ledger = argv.indexOf('--ledger') !== -1

let files
try {
  const out = execFileSync('git', ['ls-files', '--'].concat(SCOPE_DIRS), {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
  files = out.split('\n').map(function (s) { return s.trim() }).filter(Boolean)
} catch (e) {
  console.log('RESULT: FAIL')
  console.log('  git ls-files over ' + SCOPE_DIRS.join(',') + ' failed: ' + String((e && e.message) || e))
  process.exit(1)
}

const scanned = files.filter(function (p) { return SCANNED_EXTS.indexOf(extname(p)) !== -1 })
const violations = []
const ledgerRows = []

if (scanned.length < MIN_SCOPE_FILES) {
  violations.push('scope floor not met: ' + scanned.length + ' scannable tracked files, floor ' + MIN_SCOPE_FILES)
}

SWEPT_FILES.forEach(function (p) {
  if (files.indexOf(p) === -1) violations.push('swept file is not tracked: ' + p)
})

EXEMPT_FILES.concat(PENDING_FILES.map(function (e) { return e[0] })).forEach(function (p) {
  if (files.indexOf(p) === -1) {
    violations.push('declared file is not tracked: ' + p)
    return
  }
  const got = scanComments(readFileSync(resolve(ROOT, p), 'utf8'), extname(p))
  if (got.length === 0) violations.push('stale declaration, zero comments remain in ' + p)
})

let commentFree = 0
scanned.forEach(function (p) {
  if (isExempt(p) || isPending(p)) return
  let text = readFileSync(resolve(ROOT, p), 'utf8')
  if (mutant && p === MUTANT_TARGET) text = MUTANT_LINE + '\n' + text
  const got = scanComments(text, extname(p))
  if (got.length === 0) { commentFree++; return }
  ledgerRows.push(p + ' ' + got.length)
  const tag = isSwept(p) ? 'swept file still carries a comment' : 'unledgered comment-bearing file'
  got.forEach(function (c) { violations.push(tag + ' ' + p + ':' + c.line + ' ' + c.text.slice(0, 100)) })
})

if (ledger) {
  ledgerRows.sort()
  ledgerRows.forEach(function (r) { console.log('  ' + r) })
  console.log('  ledger files: ' + ledgerRows.length)
  process.exit(0)
}

if (violations.length > 0) {
  console.log('RESULT: FAIL')
  violations.slice(0, 40).forEach(function (v) { console.log('  ' + v) })
  console.log('  violations: ' + violations.length)
  process.exit(1)
}

console.log('RESULT: PASS')
console.log('  scanned: ' + scanned.length + ' scannable tracked files under ' + SCOPE_DIRS.join(','))
console.log('  comment-free: ' + commentFree)
console.log('  swept: ' + SWEPT_FILES.length + ' files')
console.log('  exempt: ' + EXEMPT_FILES.length + ' files, ' + EXEMPT_PREFIXES.length + ' prefix')
console.log('  pending: ' + PENDING_FILES.length + ' files')
process.exit(0)
