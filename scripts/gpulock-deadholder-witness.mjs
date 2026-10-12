import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'gpulock.mjs')
const RUNTIME = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'witness-args.mjs')
const LEASE_RUNTIME = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'browser-lease.mjs')
const MUTANT = process.argv.includes('--mutant')
const base = process.argv.slice(2).find(arg => !arg.startsWith('--')) || tmpdir()
const scratch = join(base, 'gpulock-deadholder-witness')
const scratchLock = join(scratch, '.gpu-lock')
const scratchScript = join(scratch, 'scripts', 'gpulock.mjs')
const DEAD_PID = 999999
const LIVENESS_LINE = '  if (!pidAlive(record.pid)) return false\n'

function pidIsDead(pid) {
  try { process.kill(pid, 0); return false } catch { return true }
}

if (!pidIsDead(DEAD_PID)) throw new Error(`gpulock-deadholder-witness: pid ${DEAD_PID} is alive, so it cannot model a dead holder`)

rmSync(scratch, { recursive: true, force: true })
mkdirSync(join(scratch, 'scripts'), { recursive: true })
mkdirSync(join(scratch, 'scripts', 'lib'), { recursive: true })
writeFileSync(join(scratch, 'scripts', 'lib', 'witness-args.mjs'), readFileSync(RUNTIME, 'utf8'), 'utf8')
writeFileSync(join(scratch, 'scripts', 'lib', 'browser-lease.mjs'), readFileSync(LEASE_RUNTIME, 'utf8'), 'utf8')
let source = readFileSync(SOURCE, 'utf8')
if (!source.includes(LIVENESS_LINE)) throw new Error(`gpulock-deadholder-witness: liveness line not found in ${SOURCE}`)
if (MUTANT) source = source.replace(LIVENESS_LINE, '')
writeFileSync(scratchScript, source, 'utf8')

const liveHolder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
await new Promise(done => setTimeout(done, 300))

function seedOwner(pid) {
  mkdirSync(scratchLock, { recursive: true })
  const now = Date.now()
  const record = { owner: 'trav-dead', pid, startedAt: now, heartbeatAt: now }
  writeFileSync(join(scratchLock, 'owner.json'), `${JSON.stringify(record)}\n`, 'utf8')
}

function runLock() {
  return spawnSync(process.execPath, [scratchScript, 'run', 'trav-probe', '--wait-ms', '2000', '--', process.execPath, '-e', '0'], { encoding: 'utf8', timeout: 30000 })
}

function scenario(label, pid, expect) {
  seedOwner(pid)
  const result = runLock()
  const refused = result.status === 1 && result.stderr.includes('waited 2000 ms')
  const tookOver = result.status === 0 && result.stdout.includes('took the GPU lock from') && result.stdout.includes('trav-dead')
  const ok = expect === 'refuse' ? refused : tookOver
  console.log(`${label}: owner pid ${pid}, heartbeat fresh, exit ${result.status}`)
  console.log(`  stdout: ${result.stdout.trim() || '(none)'}`)
  console.log(`  stderr: ${result.stderr.trim() || '(none)'}`)
  console.log(`  expect ${expect}: ${ok ? 'met' : 'NOT met'}`)
  return ok
}

let verdict = false
try {
  const takenFromDead = scenario('A dead holder, fresh heartbeat', DEAD_PID, 'takeover')
  const refusedFromLive = scenario('B live holder, fresh heartbeat', liveHolder.pid, 'refuse')
  verdict = takenFromDead && refusedFromLive
} finally {
  liveHolder.kill()
}

console.log(`mode: ${MUTANT ? 'mutant (holderIsLive ignores pidAlive)' : 'real source'}`)
console.log(`RESULT: ${verdict ? 'PASS' : 'FAIL'}`)
process.exit(verdict ? 0 : 1)
