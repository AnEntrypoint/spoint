import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..'))
const server = readFileSync(join(root, 'scripts/lib/witness-server.mjs'), 'utf8')
const guard = readFileSync(join(root, 'scripts/lib/verdict-exit-guard.mjs'), 'utf8')

function bodyOf(src, header) {
  const start = src.indexOf(header)
  assert.notEqual(start, -1, `missing declaration: ${header}`)
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  throw new Error(`unbalanced body for ${header}`)
}

const checks = []
function check(name, fn) {
  try {
    fn()
    checks.push({ name, pass: true })
  } catch (e) {
    checks.push({ name, pass: false, detail: e.message.split('\n')[0] })
  }
}

check('line 40: registering a server arms the verdict guard', () => {
  assert.match(bodyOf(server, 'export function registerWitnessServer('), /\barmGuardFromRegister\(/)
  const armBody = bodyOf(server, 'function armGuardFromRegister(')
  assert.match(armBody, /armVerdictExitGuard\(\{/)
  assert.match(armBody, /hardExitMs:/)
})

check('line 49: the guard is armed through a static import, not import()', () => {
  assert.match(server, /^import \{ armVerdictExitGuard \} from '\.\/verdict-exit-guard\.mjs'$/m)
  assert.doesNotMatch(server, /\bimport\(\s*['"]\.\/verdict-exit-guard/)
})

check('line 54: the arm is synchronous and the import cycle resolves at load', () => {
  assert.doesNotMatch(server, /async function armGuardFromRegister\(/)
  const armBody = bodyOf(server, 'function armGuardFromRegister(')
  assert.doesNotMatch(armBody, /\bawait\b|\.then\(/)
  assert.match(guard, /^import \{[^}]*\} from '\.\/witness-server\.mjs'/m)
})

const failed = checks.filter(c => !c.pass)
for (const c of checks) console.log(`${c.pass ? 'ok  ' : 'FAIL'} ${c.name}${c.pass ? '' : ` :: ${c.detail}`}`)
if (failed.length) {
  console.error(`RESULT: FAIL ${failed.length} of ${checks.length} witness-server assertion(s) do not hold`)
  process.exit(1)
}
process.stdout.write(`RESULT: PASS ${checks.length} witness-server assertions hold: registering arms the verdict guard, the guard is a static import, and the arm is synchronous\n`)
