import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'gpulock.mjs')
const RUNTIME = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'witness-args.mjs')
const LEASE_RUNTIME = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'browser-lease.mjs')
const MUTANT = process.argv.includes('--mutant')
const base = process.argv.slice(2).find(arg => !arg.startsWith('--')) || tmpdir()
const scratch = join(base, 'gpulock-child-exit-witness')
const scratchLock = join(scratch, '.gpu-lock')
const scratchScript = join(scratch, 'scripts', 'gpulock.mjs')
const EXIT_LINE = 'if (mode === \'run\') process.exit(await runMode(rest))'
const MUTANT_LINE = 'if (mode === \'run\') process.exit(0)'

rmSync(scratch, { recursive: true, force: true })
mkdirSync(join(scratch, 'scripts'), { recursive: true })
mkdirSync(join(scratch, 'scripts', 'lib'), { recursive: true })
writeFileSync(join(scratch, 'scripts', 'lib', 'witness-args.mjs'), readFileSync(RUNTIME, 'utf8'), 'utf8')
writeFileSync(join(scratch, 'scripts', 'lib', 'browser-lease.mjs'), readFileSync(LEASE_RUNTIME, 'utf8'), 'utf8')
let source = readFileSync(SOURCE, 'utf8')
if (!source.includes(EXIT_LINE)) throw new Error(`gpulock-child-exit-witness: run-exit line not found in ${SOURCE}`)
if (MUTANT) source = source.replace(EXIT_LINE, MUTANT_LINE)
writeFileSync(scratchScript, source, 'utf8')

function runLock(owner, waitMs, command) {
  return spawnSync(process.execPath, [scratchScript, 'run', owner, '--wait-ms', String(waitMs), '--', ...command], { encoding: 'utf8', timeout: 30000 })
}

function lockIsFree() {
  return !existsSync(scratchLock)
}

function check(label, result, expectExit) {
  const ok = result.status === expectExit
  console.log(`${label}: exit ${result.status}, expect ${expectExit}: ${ok ? 'met' : 'NOT met'}`)
  return ok
}

const exit3 = runLock('trav-probe', 2000, [process.execPath, '-e', 'process.exit(3)'])
const passesExit3 = check('STATE child exit 3 is passed through', exit3, 3)
const releasedAfterExit3 = lockIsFree()
console.log(`STATE lock released after child exit: ${releasedAfterExit3 ? 'met' : 'NOT met'}`)

const exit0 = runLock('trav-probe', 2000, [process.execPath, '-e', 'process.exit(0)'])
const passesExit0 = check('RES child exit 0 is passed through', exit0, 0)

const missing = runLock('trav-probe', 2000, [join(scratch, 'no-such-command-xyz')])
const missingOk = check('RES missing command maps to 127', missing, 127)

const concurrentHolder = spawn(process.execPath, [scratchScript, 'run', 'trav-a', '--wait-ms', '2000', '--', process.execPath, '-e', 'setTimeout(() => {}, 1500)'], { stdio: 'ignore' })
const holderClosed = new Promise(done => concurrentHolder.on('close', done))
await new Promise(done => setTimeout(done, 400))
const contender = runLock('trav-b', 0, [process.execPath, '-e', '0'])
const concurrentOk = check('CONC contender refused while held', contender, 1)
await holderClosed
const freeAfterHolder = lockIsFree()
console.log(`CONC lock free after holder exits: ${freeAfterHolder ? 'met' : 'NOT met'}`)

const verdict = passesExit3 && releasedAfterExit3 && passesExit0 && missingOk && concurrentOk && freeAfterHolder
console.log(`mode: ${MUTANT ? 'mutant (process.exit(0) for run)' : 'real source'}`)
console.log(`RESULT: ${verdict ? 'PASS' : 'FAIL'}`)
if (!verdict) process.exitCode = 1
