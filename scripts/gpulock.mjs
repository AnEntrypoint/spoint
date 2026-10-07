import { mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOCK_DIR = join(REPO_ROOT, '.gpu-lock')
const OWNER_FILE = join(LOCK_DIR, 'owner.json')
const HEARTBEAT_MS = 2000
const DEFAULT_TTL_MS = 120000
const DEFAULT_WAIT_MS = 600000
const POLL_MS = 500

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

function claim(owner) {
  try { mkdirSync(LOCK_DIR) } catch { return false }
  writeOwner({ owner, pid: process.pid, startedAt: nowMs(), heartbeatAt: nowMs() })
  return true
}

function takeOver(owner, reason) {
  try { rmSync(OWNER_FILE, { force: true }) } catch {}
  writeOwner({ owner, pid: process.pid, startedAt: nowMs(), heartbeatAt: nowMs(), tookOverFrom: reason })
  return true
}

function holderIsLive(record) {
  if (!record) return false
  if (!pidAlive(record.pid)) return false
  const age = nowMs() - Number(record.heartbeatAt ?? 0)
  return Number.isFinite(age) && age < currentTtl
}

let currentTtl = DEFAULT_TTL_MS

function tryAcquire(owner) {
  if (claim(owner)) return { held: true, tookOverFrom: null }
  const record = readOwner()
  if (holderIsLive(record)) return { held: false, holder: record }
  const reason = record
    ? `owner ${record.owner} pid ${record.pid} heartbeat ${nowMs() - Number(record.heartbeatAt ?? 0)} ms old`
    : 'a lock directory with no readable owner record'
  return { held: takeOver(owner, reason), tookOverFrom: reason }
}

async function acquire(owner, waitMs) {
  const deadline = nowMs() + waitMs
  for (;;) {
    const attempt = tryAcquire(owner)
    if (attempt.held) return attempt
    if (nowMs() >= deadline) {
      throw new Error(`gpulock: ${owner} waited ${waitMs} ms for the GPU lock held by ${attempt.holder.owner} pid ${attempt.holder.pid} (holding since ${new Date(attempt.holder.startedAt).toISOString()}), so no measurement was taken`)
    }
    await sleep(POLL_MS)
  }
}

function release() {
  const record = readOwner()
  if (record && record.pid === process.pid) {
    try { rmSync(OWNER_FILE, { force: true }) } catch {}
    try { rmSync(LOCK_DIR, { recursive: true, force: true }) } catch {}
  }
}

function startHeartbeat(owner) {
  let lost = false
  const timer = setInterval(() => {
    if (lost) return
    const record = readOwner()
    if (!record || record.pid !== process.pid) {
      lost = true
      clearInterval(timer)
      console.error(`gpulock: ${owner} no longer holds the GPU lock, so this arm is not exclusive and its numbers are contended`)
      return
    }
    try {
      writeOwner({ ...record, heartbeatAt: nowMs() })
    } catch {
      try { mkdirSync(LOCK_DIR) } catch {}
      try {
        writeOwner({ ...record, heartbeatAt: nowMs() })
      } catch (e) {
        console.error(`gpulock: heartbeat could not refresh the lock (${e?.code || e}), so another acquirer may take over at the ${currentTtl} ms ttl`)
      }
    }
  }, HEARTBEAT_MS)
  timer.unref?.()
  return timer
}

function numFlag(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const value = Number(argv[i + 1])
  return Number.isFinite(value) ? value : fallback
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
  currentTtl = numFlag(flags, 'ttl-ms', DEFAULT_TTL_MS)
  const waitMs = numFlag(flags, 'wait-ms', DEFAULT_WAIT_MS)
  const attempt = await acquire(owner, waitMs)
  if (attempt.tookOverFrom) console.log(`gpulock: ${owner} took the GPU lock from ${attempt.tookOverFrom}`)
  else console.log(`gpulock: ${owner} holds the GPU lock`)
  const timer = startHeartbeat(owner)
  let released = false
  const drop = () => { if (released) return; released = true; clearInterval(timer); release() }
  process.on('exit', drop)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { drop(); process.exit(130) })
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', shell: false })
  const code = await new Promise(done => {
    child.on('error', () => done(127))
    child.on('close', done)
  })
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
  console.log(`gpulock: ${live ? 'HELD' : 'STALE'} by ${record.owner} pid ${record.pid}${live ? '' : ' (dead or past ttl, so the next acquirer takes over)'}, holding since ${new Date(record.startedAt).toISOString()}, heartbeat ${nowMs() - Number(record.heartbeatAt ?? 0)} ms ago`)
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
