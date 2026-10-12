import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'gpulock.mjs')
const RUNTIME = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'witness-args.mjs')
const OWNER_CHECK = 'if (owner && record.owner !== owner) {'
const MUTANT = process.argv.includes('--mutant')
const base = process.argv.slice(2).find(arg => !arg.startsWith('--')) || tmpdir()

mkdirSync(base, { recursive: true })
const scratch = mkdtempSync(join(base, 'gpulock-foreign-release-'))
const scratchLock = join(scratch, '.gpu-lock')
const scratchOwner = join(scratchLock, 'owner.json')
const scratchScript = join(scratch, 'scripts', 'gpulock.mjs')

function seedOwner() {
  mkdirSync(scratchLock, { recursive: true })
  const now = Date.now()
  const record = { owner: 'trav-holder', pid: process.pid, startedAt: now, heartbeatAt: now }
  writeFileSync(scratchOwner, `${JSON.stringify(record)}\n`, 'utf8')
}

function release(owner) {
  return spawnSync(process.execPath, [scratchScript, 'release', owner], { encoding: 'utf8', timeout: 30000 })
}

function report(label, result, expectation, met) {
  console.log(`${label}: exit ${result.status}`)
  console.log(`  stdout: ${result.stdout.trim() || '(none)'}`)
  console.log(`  stderr: ${result.stderr.trim() || '(none)'}`)
  console.log(`  expect ${expectation}: ${met ? 'met' : 'NOT met'}`)
  return met
}

let verdict = false
try {
  let source = readFileSync(SOURCE, 'utf8')
  if (!source.includes(OWNER_CHECK)) throw new Error(`gpulock-foreign-release-witness: ${OWNER_CHECK} not found in ${SOURCE}`)
  if (MUTANT) source = source.replace(OWNER_CHECK, 'if (false) {')
  mkdirSync(join(scratch, 'scripts'), { recursive: true })
  mkdirSync(join(scratch, 'scripts', 'lib'), { recursive: true })
  writeFileSync(join(scratch, 'scripts', 'lib', 'witness-args.mjs'), readFileSync(RUNTIME, 'utf8'), 'utf8')
  writeFileSync(scratchScript, source, 'utf8')

  seedOwner()
  const before = readFileSync(scratchOwner, 'utf8')
  const foreign = release('trav-other')
  const foreignRefused = foreign.status === 1
    && foreign.stderr.includes('refusing to release')
    && existsSync(scratchOwner)
    && readFileSync(scratchOwner, 'utf8') === before
  report('1 foreign release (trav-other)', foreign, "exit 1, stderr 'refusing to release', owner.json kept byte-identical", foreignRefused)

  const own = release('trav-holder')
  const ownReleased = own.status === 0
    && own.stdout.includes('released the lock held by trav-holder')
    && !existsSync(scratchOwner)
  report('2 holder release (trav-holder)', own, 'exit 0, released message, owner.json removed', ownReleased)

  const again = release('trav-holder')
  const freeAgain = again.status === 0 && again.stdout.includes('already free')
  report('3 release on free lock', again, "exit 0, 'already free'", freeAgain)

  verdict = foreignRefused && ownReleased && freeAgain
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`mode: ${MUTANT ? 'mutant (owner check replaced by if (false))' : 'real source'}`)
console.log(`RESULT: ${verdict ? 'PASS' : 'FAIL'}`)
process.exit(verdict ? 0 : 1)
