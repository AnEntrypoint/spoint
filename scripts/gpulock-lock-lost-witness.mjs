import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

// A holder that loses the GPU lock must stop its own arm and exit 146, so a displaced
// arm never renders alongside the holder that displaced it. Run it on an isolated lock
// directory (SPOINT_GPU_LOCK_DIR), never the real .gpu-lock.
// usage: node scripts/gpulock-lock-lost-witness.mjs [baseDir] [--mutant]

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'gpulock.mjs')
const RUNTIME = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'witness-args.mjs')
const MUTANT = process.argv.includes('--mutant')
const base = process.argv.slice(2).find(arg => !arg.startsWith('--')) || tmpdir()
const scratch = join(base, 'gpulock-lock-lost-witness')
const scratchLock = join(scratch, '.gpu-lock')
const scratchScript = join(scratch, 'scripts', 'gpulock.mjs')
const scratchOwner = join(scratchLock, 'owner.json')
const STOP_LINE = '    await stopChild(child)\n'
const REAP_LINE = '  const reaped = stopOrphanedChild(record)\n'
const DEAD_PID = 999999

const sleep = ms => new Promise(done => setTimeout(done, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const armCommand = pidFile => [process.execPath, '-e', `require('fs').writeFileSync(process.argv[1],String(process.pid));setTimeout(()=>{},60000)`, pidFile]

function pidIsDead(pid) {
  try { process.kill(pid, 0); return false } catch { return true }
}

if (!pidIsDead(DEAD_PID)) throw new Error(`gpulock-lock-lost-witness: pid ${DEAD_PID} is alive, so it cannot model a dead holder`)

rmSync(scratch, { recursive: true, force: true })
mkdirSync(join(scratch, 'scripts', 'lib'), { recursive: true })
let source = readFileSync(SOURCE, 'utf8')
for (const line of [STOP_LINE, REAP_LINE]) {
  if (!source.includes(line)) throw new Error(`gpulock-lock-lost-witness: ${JSON.stringify(line)} not found in ${SOURCE}`)
}
if (MUTANT) source = source.replace(STOP_LINE, '').replace(REAP_LINE, '  const reaped = 0\n')
writeFileSync(scratchScript, source, 'utf8')
writeFileSync(join(scratch, 'scripts', 'lib', 'witness-args.mjs'), readFileSync(RUNTIME, 'utf8'), 'utf8')

const ENV = { ...process.env, SPOINT_GPU_LOCK_DIR: scratchLock }

function owner() {
  if (!existsSync(scratchOwner)) return null
  try { return JSON.parse(readFileSync(scratchOwner, 'utf8')) } catch { return null }
}

const arms = []

function startHolder(name, pidFile) {
  const proc = spawn(process.execPath, [scratchScript, 'run', name, '--wait-ms', '0', '--', ...armCommand(pidFile)], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] })
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  let out = '', err = ''
  proc.stdout.on('data', chunk => { out += chunk })
  proc.stderr.on('data', chunk => { err += chunk })
  const holder = {
    proc,
    exitCode: undefined,
    out: () => out,
    err: () => err,
    hold: () => new Promise(done => proc.on('close', done)),
  }
  proc.on('close', code => { holder.exitCode = code })
  arms.push(holder)
  return holder
}

async function waitExit(holder, ms) {
  const started = Date.now()
  while (Date.now() - started < ms) {
    if (holder.exitCode !== undefined) return holder.exitCode
    await sleep(50)
  }
  return 'still running'
}

async function waitForOwner(pid, ms = 15000) {
  const started = Date.now()
  while (Date.now() - started < ms) {
    const record = owner()
    if (record && record.pid === pid) return true
    await sleep(40)
  }
  return false
}

async function armPid(pidFile, ms = 15000) {
  const started = Date.now()
  while (Date.now() - started < ms) {
    try { const pid = Number(readFileSync(pidFile, 'utf8')); if (pid > 0) return pid } catch {}
    await sleep(40)
  }
  return 0
}

function check(label, ok) {
  console.log(`${label}: ${ok ? 'met' : 'NOT met'}`)
  return ok
}

const failures = []
function expect(label, ok) {
  if (!check(label, ok)) failures.push(label)
}

async function displacedHolderStopsItsArm() {
  rmSync(scratchLock, { recursive: true, force: true })
  mkdirSync(scratchLock, { recursive: true })
  const aPidFile = join(scratch, 'arm-a.pid')
  const bPidFile = join(scratch, 'arm-b.pid')
  const holder = startHolder('arm-a', aPidFile)
  const acquired = await waitForOwner(holder.proc.pid)
  const aArm = await armPid(aPidFile)
  let tookOver = false
  let successor = null
  for (let attempt = 0; attempt < 10 && !tookOver; attempt++) {
    const record = owner()
    if (record) writeFileSync(scratchOwner, `${JSON.stringify({ ...record, heartbeatAt: Date.now() - 121000 })}\n`, 'utf8')
    const probe = spawnSync(process.execPath, [scratchScript, 'run', 'displacer', '--wait-ms', '0', '--', process.execPath, '-e', '0'], { env: ENV, encoding: 'utf8', timeout: 20000 })
    tookOver = probe.stdout.includes('took the GPU lock from')
    if (!tookOver) await sleep(120)
  }
  successor = startHolder('arm-b', bPidFile)
  const successorHolds = await waitForOwner(successor.proc.pid)
  const bArm = await armPid(bPidFile)
  const exitCode = await waitExit(holder, 20000)
  await sleep(1000)
  console.log(`LOST displaced holder (pid ${holder.proc.pid}) arm pid ${aArm}, successor (pid ${successor.proc.pid}) arm pid ${bArm}, displaced exit ${exitCode}`)
  console.log(`  displaced stderr: ${holder.err().trim().replace(/\s+/g, ' ').slice(0, 220) || '(none)'}`)
  expect('LOST the holder was displaced', acquired && tookOver && successorHolds)
  expect('LOST the displaced holder exits 146', exitCode === 146)
  expect('LOST the displaced holder names lock-lost', /gpulock: lock-lost:/.test(holder.err()))
  expect('LOST the displaced arm is stopped', aArm > 0 && !alive(aArm))
  expect('LOST the successor still holds with its arm running', bArm > 0 && alive(bArm))
  const live = [aArm, bArm].filter(pid => pid > 0 && alive(pid)).length
  console.log(`CONC arms running after the displacement: ${live}`)
  expect('CONC exactly one arm runs after the displacement', live === 1)
}

async function deadHolderIsStillReclaimable() {
  rmSync(scratchLock, { recursive: true, force: true })
  mkdirSync(scratchLock, { recursive: true })
  const orphanPidFile = join(scratch, 'orphan-arm.pid')
  const orphan = spawn(process.execPath, [...armCommand(orphanPidFile).slice(1)], { stdio: 'ignore' })
  arms.push({ proc: orphan, out: () => '', err: () => '', hold: () => new Promise(done => orphan.on('close', done)) })
  const orphanArm = await armPid(orphanPidFile)
  const now = Date.now()
  writeFileSync(scratchOwner, `${JSON.stringify({ owner: 'trav-dead', pid: DEAD_PID, childPid: orphanArm, startedAt: now, heartbeatAt: now })}\n`, 'utf8')
  const started = Date.now()
  const reclaimer = spawnSync(process.execPath, [scratchScript, 'run', 'reclaimer', '--wait-ms', '20000', '--', process.execPath, '-e', '0'], { env: ENV, encoding: 'utf8', timeout: 60000 })
  const elapsed = Date.now() - started
  await sleep(500)
  console.log(`RECLAIM dead holder pid ${DEAD_PID} with surviving arm pid ${orphanArm}, reclaimed in ${elapsed} ms`)
  console.log(`  reclaimer stdout: ${reclaimer.stdout.trim().replace(/\s+/g, ' ').slice(0, 220) || '(none)'}`)
  expect('RECLAIM a dead holder is still reclaimable', reclaimer.status === 0 && reclaimer.stdout.includes('took the GPU lock from'))
  expect('RECLAIM the surviving arm is reaped', /orphan-reaped/.test(reclaimer.stdout))
  expect('RECLAIM the surviving arm is stopped', orphanArm > 0 && !alive(orphanArm))
}

let verdict = false
try {
  await displacedHolderStopsItsArm()
  await deadHolderIsStillReclaimable()
} finally {
  for (const holder of arms) {
    try { if (alive(holder.proc.pid)) holder.proc.kill('SIGKILL') } catch {}
  }
  await sleep(300)
  rmSync(scratch, { recursive: true, force: true })
}

verdict = failures.length === 0
console.log(`mode: ${MUTANT ? 'mutant (displaced holder keeps its arm, orphan not reaped)' : 'real source'}`)
console.log(`RESULT: ${verdict ? 'PASS' : 'FAIL'} (${failures.length} failure(s))`)
process.exit(verdict ? 0 : 1)
