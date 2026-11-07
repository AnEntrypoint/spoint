#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tokenize } from './lib/js-token-stream.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PRAGMA = /@__PURE__|#__PURE__|@ts-|eslint|@vite-ignore|webpackIgnore|sourceMappingURL|@dsCard|@license|@preserve|@jsx|prettier-ignore|istanbul|c8 ignore/

export function signature(text) {
  const { tokens, comments } = tokenize(text)
  const sig = tokens.map((t, i) => (i === 0 ? '' : t.nl ? 'N' : '-') + t.kind + ':' + t.text)
  const ranges = comments.filter((c) => c.kind !== 'hashbang')
  return { sig, ranges }
}

export function compare(headText, newText) {
  const reasons = []
  const next = signature(newText)
  const remaining = next.ranges.filter((r) => !PRAGMA.test(r.text))
  if (remaining.length > 0) reasons.push(remaining.length + ' non-pragma comment(s) remain')
  let removed = 0
  if (headText !== null) {
    const head = signature(headText)
    const pragmaHead = head.ranges.filter((r) => PRAGMA.test(r.text)).length
    const pragmaNew = next.ranges.length - remaining.length
    if (pragmaHead !== pragmaNew) reasons.push('pragma comments ' + pragmaHead + ' -> ' + pragmaNew)
    const width = Math.max(head.sig.length, next.sig.length)
    let at = -1
    for (let i = 0; i < width; i += 1) {
      if (head.sig[i] !== next.sig[i]) {
        at = i
        break
      }
    }
    if (at !== -1) reasons.push('token ' + at + ' differs: ' + String(head.sig[at]) + ' vs ' + String(next.sig[at]))
    removed = head.ranges.length - next.ranges.length
  }
  return { ok: reasons.length === 0, reasons, removed, remaining: remaining.length }
}

const CONTROLS = [
  ['a;\n// c\nb;', 'a;\nb;', true],
  ['a = 1; // c\n', 'a = 1;\n', true],
  ['return // c\n5', 'return\n5', true],
  ['return // c\n5', 'return 5', false],
  ['a/*x*/b', 'ab', false],
  ['a/*x*/b', 'a b', true],
  ['a;\n/* x */\nb', 'a;\n/* x */\nb', false],
  ['x = 1;', 'x = 2;', false],
  ['const s = "// not a comment";', 'const s = "// not a comment";', true],
  ['/* @__PURE__ */ f();', '/* @__PURE__ */ f();', true],
  ['f(/* @__PURE__ */ g())', 'f(g())', false],
  ['#!/usr/bin/env node\na;\n// c\n', '#!/usr/bin/env node\na;\n', true],
  ['const r = /\\/\\//;', 'const r = /\\/\\//;', true],
  ['const r = a / b; // c\n', 'const r = a / b;\n', true],
  ['if (x) /re\\/*/.test(y);', 'if (x) /re\\/*/.test(y);', true],
  ['const t = `// not ${a} a comment`;', 'const t = `// not ${a} a comment`;', true],
  ['const t = `x ${a /* c */} y`;', 'const t = `x ${a} y`;', true],
  ['const t = `x ${a /* c */} y`;', 'const t = `x ${a /* c */} y`;', false],
  ['if (a) { b(); } // c\nx();', 'if (a) { b(); }\nx();', true],
]

export function selfTest() {
  const failures = []
  for (const [head, next, expect] of CONTROLS) {
    const got = compare(head, next).ok
    if (got !== expect) failures.push({ head, next, expect, got })
  }
  return { cases: CONTROLS.length, failures }
}

function changedFiles() {
  return execFileSync('git', ['diff', '--name-only', 'HEAD', '--'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(m?js|cjs)$/.test(f))
}

function headText(rel) {
  try {
    return execFileSync('git', ['show', 'HEAD:' + rel], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return null
  }
}

function main() {
  const control = selfTest()
  if (control.failures.length > 0) {
    console.log('SELF-TEST FAIL: ' + JSON.stringify(control.failures))
    console.log('RESULT: FAIL comment-sweep witness controls')
    process.exitCode = 1
    return
  }
  console.log('self-test: ' + control.cases + ' controls, all as expected')
  const args = process.argv.slice(2)
  if (args[0] !== '--sweep') {
    console.log('RESULT: PASS lexer controls hold; run with --sweep [files] to verify a comment sweep against HEAD')
    return
  }
  const files = args.length > 1 ? args.slice(1) : changedFiles()
  let failed = 0
  let removedTotal = 0
  for (const rel of files) {
    const current = readFileSync(ROOT + rel, 'utf8')
    const verdict = compare(headText(rel), current)
    removedTotal += verdict.removed
    if (!verdict.ok) {
      failed += 1
      console.log('FAIL ' + rel + ': ' + verdict.reasons.join('; '))
    } else {
      console.log('OK ' + rel + ' removed=' + verdict.removed)
    }
  }
  if (failed > 0) {
    console.log('RESULT: FAIL ' + failed + ' of ' + files.length + ' file(s) changed code or kept a comment')
    process.exitCode = 1
    return
  }
  console.log('RESULT: PASS ' + files.length + ' file(s): token streams match HEAD, ' + removedTotal + ' comment(s) removed, no non-pragma comment remains')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
