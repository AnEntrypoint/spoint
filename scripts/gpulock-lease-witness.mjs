import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'gpulock.mjs')
const RUNTIME = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'witness-args.mjs')

function copyRuntime(scratch) {
  mkdirSync(join(scratch, 'scripts', 'lib'), { recursive: true })
  writeFileSync(join(scratch, 'scripts', 'lib', 'witness-args.mjs'), readFileSync(RUNTIME, 'utf8'), 'utf8')
}
const MUTANT = process.argv.includes('--mutant')
const base = process.argv.slice(2).find(arg => !arg.startsWith('--')) || tmpdir()
const scratch = join(base, 'gpulock-lease-witness')
const scratchLock = join(scratch, '.gpu-lock')
const scratchScript = join(scratch, 'scripts', 'gpulock.mjs')
const TTL_LINE = 'const DEFAULT_TTL_MS = 120000'

rmSync(scratch, { recursive: true, force: true })
mkdirSync(join(scratch, 'scripts'), { recursive: true })
copyRuntime(scratch)
let source = readFileSync(SOURCE, 'utf8')
if (!source.includes(TTL_LINE)) throw new Error(`gpulock-lease-witness: ${TTL_LINE} not found in ${SOURCE}`)
if (MUTANT) source = source.replace(TTL_LINE, 'const DEFAULT_TTL_MS = 1e9')
writeFileSync(scratchScript, source, 'utf8')

const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
await new Promise(done => setTimeout(done, 300))

function seedOwner(ageMs) {
  mkdirSync(scratchLock, { recursive: true })
  const now = Date.now()
  const record = { owner: 'trav-holder', pid: holder.pid, startedAt: now - ageMs, heartbeatAt: now - ageMs }
  writeFileSync(join(scratchLock, 'owner.json'), `${JSON.stringify(record)}\n`, 'utf8')
}

function runLock(extraFlags) {
  return spawnSync(process.execPath, [scratchScript, 'run', 'trav-probe', '--wait-ms', '1000', ...extraFlags, '--', process.execPath, '-e', '0'], { encoding: 'utf8', timeout: 30000 })
}

function scenario(label, ageMs, extraFlags, expect) {
  seedOwner(ageMs)
  const result = runLock(extraFlags)
  const refused = result.status === 1 && result.stderr.includes('waited 1000 ms')
  const tookOver = result.status === 0 && result.stdout.includes('took the GPU lock from')
  const clamped = result.status === 2
    && result.stderr.includes('ttl-ms-out-of-range')
    && result.stderr.includes('outside 10000..120000 ms')
    && !result.stdout.includes('GPU lock')
  const ok = expect === 'refuse' ? refused : expect === 'takeover' ? tookOver : clamped
  console.log(`${label}: heartbeat ${ageMs} ms old, flags [${extraFlags.join(' ')}], exit ${result.status}`)
  console.log(`  stdout: ${result.stdout.trim() || '(none)'}`)
  console.log(`  stderr: ${result.stderr.trim() || '(none)'}`)
  console.log(`  expect ${expect}: ${ok ? 'met' : 'NOT met'}`)
  return ok
}

let verdict = false
try {
  const refusedInsideTtl = scenario('A live holder inside TTL', 118000, [], 'refuse')
  const takenAt121 = scenario('B live holder past TTL', 121000, [], 'takeover')
  const clampedAboveCeiling = scenario('C --ttl-ms 200000 above the 120000 ms ceiling', 121000, ['--ttl-ms', '200000'], 'clamped')
  const takenAtFloor = scenario('D --ttl-ms 10000 floor, heartbeat past it', 11000, ['--ttl-ms', '10000'], 'takeover')
  verdict = refusedInsideTtl && takenAt121 && clampedAboveCeiling && takenAtFloor
} finally {
  holder.kill()
}

console.log(`mode: ${MUTANT ? 'mutant (DEFAULT_TTL_MS = 1e9)' : 'real source'}`)
console.log(`RESULT: ${verdict ? 'PASS' : 'FAIL'}`)
process.exit(verdict ? 0 : 1)
