import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { acquire, status, sessionDir } from './lib/browser-lease.mjs'

const PASS = []
const FAIL = []
function check(label, cond, detail) {
  if (cond) { PASS.push(label); console.log(`  [PASS] ${label}`) }
  else { FAIL.push(label); console.log(`  [FAIL] ${label}${detail ? ' -- ' + detail : ''}`) }
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LEASE_URL = 'file:///' + path.resolve(HERE, 'lib', 'browser-lease.mjs').replace(/\\/g, '/')
const CHILD_SRC =
  `const { acquire } = await import(${JSON.stringify(LEASE_URL)});\n` +
  `const l = await acquire({ root: process.argv[1], owner: 'arm-B', fingerprint: 'fp-b', waitMs: Number(process.argv[2]) });\n` +
  `console.log('ACQUIRED');\n` +
  `l.release();\n`

function runChild(root, waitMs) {
  return new Promise((done) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', CHILD_SRC, root, String(waitMs)], { encoding: 'utf8' })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code) => done({ code, out: out.trim(), err: err.trim() }))
  })
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-witness-'))
const dir = sessionDir(root)

const armA = await acquire({ root, owner: 'arm-A', fingerprint: 'fp-a', waitMs: 5000 })
check('arm A holds the project session', fs.existsSync(path.join(dir, 'owner.json')), `dir ${dir}`)

const blocked = await runChild(root, 1500)
check(
  'a second arm with DIFFERENT launch args cannot acquire while arm A holds',
  !blocked.out.includes('ACQUIRED'),
  `child stdout "${blocked.out}" stderr "${blocked.err.slice(0, 120)}"`,
)
check(
  'the blocked arm names the holder instead of opening another browser',
  /browser-lease:.*held by/.test(blocked.err),
  `stderr "${blocked.err.slice(0, 160)}"`,
)

const heldStatus = status({ root })
check('status reports the session held by arm A', heldStatus.held === true && heldStatus.owner === 'arm-A', JSON.stringify(heldStatus))
check('status reports a single session dir for the project', heldStatus.dir === dir, `${heldStatus.dir} vs ${dir}`)

armA.release()
const freed = status({ root })
check('releasing arm A frees the project session', freed.held === false, JSON.stringify(freed))

const admitted = await runChild(root, 8000)
check(
  'the second arm acquires once arm A releases',
  admitted.out.includes('ACQUIRED'),
  `exit ${admitted.code} stdout "${admitted.out}" stderr "${admitted.err.slice(0, 160)}"`,
)
check('the released session is not held afterwards', status({ root }).held === false, JSON.stringify(status({ root })))

try { fs.rmSync(root, { recursive: true, force: true }) } catch (_) {}

console.log(`\n  passed ${PASS.length}, failed ${FAIL.length}`)
console.log(FAIL.length === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(FAIL.length === 0 ? 0 : 1)
