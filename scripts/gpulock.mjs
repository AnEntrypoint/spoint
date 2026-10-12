import { mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { numericFlag } from './lib/witness-args.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOCK_DIR = process.env.SPOINT_GPU_LOCK_DIR ? resolve(process.env.SPOINT_GPU_LOCK_DIR) : join(REPO_ROOT, '.gpu-lock')
const OWNER_FILE = join(LOCK_DIR, 'owner.json')
const HEARTBEAT_MS = 2000
const DEFAULT_TTL_MS = 120000
const MIN_TTL_MS = HEARTBEAT_MS * 5
const MAX_TTL_MS = DEFAULT_TTL_MS
const DEFAULT_WAIT_MS = 600000
const MIN_WAIT_MS = 0
const MAX_WAIT_MS = MAX_TTL_MS * 5
const POLL_MS = 500
const RECLAIM_CONFIRM_MS = 250
const CHILD_STOP_GRACE_MS = 2000
const CHILD_STOP_HARD_MS = 5000
const EXIT_LOCK_LOST = 146

function nowMs() {
  return Date.now()
}

function sleep(ms) {
  return new Promise(done => setTimeout(done, ms))
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

function readOwner() {
  let text
  try { text = readFileSync(OWNER_FILE, 'utf8') } catch { return null }
  try { return JSON.parse(text) } catch { return null }
}

function writeOwner(record) {
  const tmp = `${OWNER_FILE}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, 'utf8')
  renameSync(tmp, OWNER_FILE)
}

function claim(owner, nonce) {
  try { mkdirSync(LOCK_DIR) } catch { return false }
  writeOwner({ owner, pid: process.pid, nonce, childPid: 0, startedAt: nowMs(), heartbeatAt: nowMs() })
  return true
}

function takeOver(owner, nonce, reason) {
  try { rmSync(OWNER_FILE, { force: true }) } catch {}
  writeOwner({ owner, pid: process.pid, nonce, childPid: 0, startedAt: nowMs(), heartbeatAt: nowMs(), tookOverFrom: reason })
  return true
}

function holderIsLive(record) {
  if (!record) return false
  if (!pidAlive(record.pid)) return false
  const age = nowMs() - Number(record.heartbeatAt ?? 0)
  return Number.isFinite(age) && age < currentTtl
}

let currentTtl = DEFAULT_TTL_MS
let currentChildPid = 0

function stopOrphanedChild(record) {
  const childPid = Number(record?.childPid ?? 0)
  if (!Number.isInteger(childPid) || childPid <= 0) return 0
  if (childPid === process.pid || !pidAlive(childPid)) return 0
  try { process.kill(childPid, 'SIGKILL') } catch { return 0 }
  return childPid
}

async function takeoverAllowed(record) {
  if (holderIsLive(record)) return false
  const age = nowMs() - Number(record.heartbeatAt ?? 0)
  if (!Number.isFinite(age) || age >= currentTtl) return true
  if (pidAlive(record.pid)) return false
  await sleep(RECLAIM_CONFIRM_MS)
  const again = readOwner()
  if (!again || again.nonce !== record.nonce) return false
  return !holderIsLive(again)
}

async function tryAcquire(owner, nonce) {
  if (claim(owner, nonce)) return { held: true, tookOverFrom: null, reaped: 0 }
  const record = readOwner()
  if (!record) {
    const reason = 'a lock directory with no readable owner record'
    return { held: takeOver(owner, nonce, reason), tookOverFrom: reason, reaped: 0 }
  }
  if (!(await takeoverAllowed(record))) return { held: false, holder: record }
  const reason = `owner ${record.owner} pid ${record.pid} heartbeat ${nowMs() - Number(record.heartbeatAt ?? 0)} ms old`
  const reaped = stopOrphanedChild(record)
  return { held: takeOver(owner, nonce, reason), tookOverFrom: reason, reaped }
}

async function acquire(owner, nonce, waitMs) {
  const deadline = nowMs() + waitMs
  for (;;) {
    const attempt = await tryAcquire(owner, nonce)
    if (attempt.held) return attempt
    if (nowMs() >= deadline) {
      throw new Error(`gpulock: ${owner} waited ${waitMs} ms for the GPU lock held by ${attempt.holder.owner} pid ${attempt.holder.pid} (holding since ${new Date(attempt.holder.startedAt).toISOString()}), so no measurement was taken`)
    }
    await sleep(POLL_MS)
  }
}

function release(nonce) {
  const record = readOwner()
  if (record && record.pid === process.pid && (!record.nonce || record.nonce === nonce)) {
    try { rmSync(OWNER_FILE, { force: true }) } catch {}
    try { rmSync(LOCK_DIR, { recursive: true, force: true }) } catch {}
  }
}

function recordChildPid(nonce) {
  const record = readOwner()
  if (!record || record.nonce !== nonce) return
  try { writeOwner({ ...record, childPid: currentChildPid, heartbeatAt: nowMs() }) } catch {}
}

function startHeartbeat(owner, nonce, onLost) {
  let lost = false
  const timer = setInterval(() => {
    if (lost) return
    const record = readOwner()
    if (!record || record.nonce !== nonce) {
      lost = true
      clearInterval(timer)
      onLost(record)
      return
    }
    try {
      writeOwner({ ...record, heartbeatAt: nowMs(), childPid: currentChildPid })
    } catch {
      try { mkdirSync(LOCK_DIR) } catch {}
      try {
        writeOwner({ ...record, heartbeatAt: nowMs(), childPid: currentChildPid })
      } catch (e) {
        console.error(`gpulock: heartbeat could not refresh the lock (${e?.code || e}), so another acquirer may take over at the ${currentTtl} ms ttl`)
      }
    }
  }, HEARTBEAT_MS)
  timer.unref?.()
  return timer
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise(done => child.once('close', done))
  try { child.kill('SIGTERM') } catch {}
  const closedGracefully = await Promise.race([closed.then(() => true), sleep(CHILD_STOP_GRACE_MS).then(() => false)])
  if (closedGracefully) return
  try { child.kill('SIGKILL') } catch {}
  await Promise.race([closed, sleep(CHILD_STOP_HARD_MS)])
}

function numFlag(argv, name, fallback) {
  const eq = argv.find(a => a.startsWith(`--${name}=`))
  if (eq !== undefined) return numericFlag({ [name]: eq.slice(name.length + 3) }, name, fallback)
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  return numericFlag({ [name]: argv[i + 1] ?? true }, name, fallback)
}

function boundedMs(argv, name, fallback, min, max, code) {
  const value = numFlag(argv, name, fallback)
  if (!Number.isFinite(value) || value < min || value > max) {
    console.error(`gpulock: ${code}: --${name}=${value} ms is outside ${min}..${max} ms`)
    process.exit(2)
  }
  return value
}

function argSplit(argv) {
  const at = argv.indexOf('--')
  if (at === -1) return { flags: argv, command: [] }
  return { flags: argv.slice(0, at), command: argv.slice(at + 1) }
}

async function runMode(argv) {
  const { flags, command } = argSplit(argv)
  const owner = flags[0]
  if (!owner) throw new Error('gpulock: run needs an owner name: gpulock.mjs run <owner> -- <command>')
  if (command.length === 0) throw new Error('gpulock: run needs a command after --')
  currentTtl = boundedMs(flags, 'ttl-ms', DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS, 'ttl-ms-out-of-range')
  const waitMs = boundedMs(flags, 'wait-ms', DEFAULT_WAIT_MS, MIN_WAIT_MS, MAX_WAIT_MS, 'wait-ms-out-of-range')
  const nonce = randomUUID()
  const attempt = await acquire(owner, nonce, waitMs)
  if (attempt.reaped) console.log(`gpulock: orphan-reaped: stopped pid ${attempt.reaped}, the arm of the holder this lock was taken from, so it cannot share the adapter`)
  if (attempt.tookOverFrom) console.log(`gpulock: ${owner} took the GPU lock from ${attempt.tookOverFrom}`)
  else console.log(`gpulock: ${owner} holds the GPU lock`)
  let child = null
  let lockLost = false
  const whoTookIt = seen => (seen ? `owner ${seen.owner} pid ${seen.pid}` : 'an acquirer that removed the owner record')
  const voidArm = async seen => {
    if (lockLost) return
    lockLost = true
    clearInterval(timer)
    console.error(`gpulock: lock-lost: ${owner} no longer holds the GPU lock (${whoTookIt(seen)}), so this arm is void, its child pid ${child?.pid ?? 'none'} is stopped, and its numbers must not be read as a measurement`)
    await stopChild(child)
    process.exit(EXIT_LOCK_LOST)
  }
  const timer = startHeartbeat(owner, nonce, seen => { void voidArm(seen) })
  let released = false
  const drop = () => { if (released) return; released = true; clearInterval(timer); release(nonce) }
  process.on('exit', drop)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { drop(); process.exit(130) })
  child = spawn(command[0], command.slice(1), { stdio: 'inherit', shell: false })
  currentChildPid = child.pid ?? 0
  recordChildPid(nonce)
  const code = await new Promise(done => {
    child.on('error', () => done(127))
    child.on('close', done)
  })
  if (lockLost) return EXIT_LOCK_LOST
  const afterArm = readOwner()
  if (!afterArm || afterArm.nonce !== nonce) {
    console.error(`gpulock: lock-lost: ${owner} no longer holds the GPU lock (${whoTookIt(afterArm)}), so this arm is void and its numbers must not be read as a measurement`)
    return EXIT_LOCK_LOST
  }
  drop()
  return code
}

function statusMode() {
  const record = readOwner()
  if (!record) {
    console.log('gpulock: the GPU lock is free')
    return 0
  }
  const live = holderIsLive(record)
  const arm = Number(record.childPid ?? 0) > 0 ? `, arm pid ${record.childPid}` : ''
  console.log(`gpulock: ${live ? 'HELD' : 'STALE'} by ${record.owner} pid ${record.pid}${arm}${live ? '' : ' (dead or past ttl, so the next acquirer takes over)'}, holding since ${new Date(record.startedAt).toISOString()}, heartbeat ${nowMs() - Number(record.heartbeatAt ?? 0)} ms ago`)
  return 0
}

function releaseMode(argv) {
  const owner = argv[0]
  const record = readOwner()
  if (!record) {
    console.log('gpulock: the GPU lock is already free')
    return 0
  }
  if (owner && record.owner !== owner) {
    console.error(`gpulock: refusing to release a lock held by ${record.owner}, not ${owner}`)
    return 1
  }
  try { rmSync(OWNER_FILE, { force: true }) } catch {}
  try { rmSync(LOCK_DIR, { recursive: true, force: true }) } catch {}
  console.log(`gpulock: released the lock held by ${record.owner} pid ${record.pid}`)
  return 0
}

function usage() {
  console.error('gpulock: usage: gpulock.mjs run <owner> [--wait-ms N] [--ttl-ms N] -- <command> <args...> | gpulock.mjs status | gpulock.mjs release [owner]')
  console.error(`gpulock: run exits with the child's code, 127 when the command cannot start, 2 on a bad flag, or ${EXIT_LOCK_LOST} when the lock was lost mid-arm (that arm is void, retry it)`)
  return 2
}

async function main() {
  const argv = process.argv.slice(2)
  const mode = argv[0]
  const rest = argv.slice(1)
  if (mode === 'run') process.exit(await runMode(rest))
  if (mode === 'status') process.exit(statusMode())
  if (mode === 'release') process.exit(releaseMode(rest))
  process.exit(usage())
}

main().catch(e => {
  console.error(`gpulock: ${e?.message || e}`)
  process.exit(1)
})
