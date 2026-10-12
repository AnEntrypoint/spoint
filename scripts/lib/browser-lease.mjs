import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

const HEARTBEAT_MS = 2000
const DEFAULT_TTL_MS = 120000
const DEFAULT_WAIT_MS = 600000
const POLL_MS = 500
const PROFILE_NAME = 'profile'
const DEFAULT_SESSION = 'session'

const held = new Map()

function nowMs() {
  return Date.now()
}

function sleep(ms) {
  return new Promise((done) => { setTimeout(done, ms) })
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try { process.kill(pid, 'SIGKILL') } catch {}
}

function reapProfileOwners(profile) {
  if (process.platform === 'win32') {
    const marker = profile.replace(/'/g, "''")
    const script =
      `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*${marker}*' -and $_.CommandLine -notlike '*--type=*' } | ` +
      `ForEach-Object { $_.ProcessId }`
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
    if (r.status !== 0) return
    for (const line of String(r.stdout || '').split('\n')) {
      const pid = Number(line.trim())
      if (Number.isInteger(pid) && pid > 0) killTree(pid)
    }
    return
  }
  spawnSync('pkill', ['-f', `--user-data-dir=${profile}`], { stdio: 'ignore' })
}

export function sessionFingerprint({ args = [], headless = false } = {}) {
  return crypto.createHash('sha1')
    .update(JSON.stringify({ headless: headless === true, args: [...args].map(String).sort() }))
    .digest('hex')
    .slice(0, 16)
}

export function sessionDir(root) {
  return path.join(path.resolve(root), '.gm', 'browser-lease', DEFAULT_SESSION)
}

function ownerFile(dir) {
  return path.join(dir, 'owner.json')
}

function profileDir(dir) {
  return path.join(dir, PROFILE_NAME)
}

function readOwner(dir) {
  try {
    return JSON.parse(fs.readFileSync(ownerFile(dir), 'utf8'))
  } catch {
    return null
  }
}

function writeOwner(dir, record) {
  const file = ownerFile(dir)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

function holderIsLive(record, dir, ttlMs) {
  if (!record) return false
  if (record.pid === process.pid) return held.has(dir)
  if (!pidAlive(record.pid)) return false
  const age = nowMs() - Number(record.heartbeatAt ?? 0)
  return Number.isFinite(age) && age < ttlMs
}

function claim(dir, owner, fingerprint, ttlMs) {
  fs.mkdirSync(dir, { recursive: true })
  const lock = ownerFile(dir)
  let fd
  try {
    fd = fs.openSync(lock, 'wx')
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
    const record = readOwner(dir)
    if (holderIsLive(record, dir, ttlMs)) return false
    killTree(Number(record?.pid ?? 0))
    killTree(Number(record?.browserPid ?? 0))
    reapProfileOwners(profileDir(dir))
    try { fs.unlinkSync(lock) } catch {}
    try {
      fd = fs.openSync(lock, 'wx')
    } catch {
      return false
    }
  }
  try {
    fs.writeSync(fd, `${JSON.stringify({ owner, fingerprint, pid: process.pid, startedAt: nowMs(), heartbeatAt: nowMs(), ttlMs })}\n`)
  } finally {
    fs.closeSync(fd)
  }
  held.set(dir, { owner, ttlMs })
  return true
}

function startHeartbeat(dir) {
  const timer = setInterval(() => {
    if (!held.has(dir)) return
    const record = readOwner(dir)
    if (!record || record.pid !== process.pid) return
    try {
      writeOwner(dir, { ...record, heartbeatAt: nowMs() })
    } catch {}
  }, HEARTBEAT_MS)
  timer.unref?.()
  return timer
}

export async function acquire({ root = process.cwd(), owner = `browser-${process.pid}`, fingerprint = DEFAULT_SESSION, waitMs = DEFAULT_WAIT_MS, ttlMs = DEFAULT_TTL_MS } = {}) {
  const dir = sessionDir(root)
  const deadline = nowMs() + waitMs
  for (;;) {
    if (claim(dir, owner, fingerprint, ttlMs)) break
    const record = readOwner(dir)
    if (nowMs() >= deadline) {
      throw new Error(
        `browser-lease: ${owner} waited ${waitMs}ms for the accelerated browser session of ${path.resolve(root)} ` +
        `held by ${record?.owner ?? 'an unreadable holder'} pid ${record?.pid ?? '?'} ` +
        `fingerprint ${record?.fingerprint ?? '?'} ` +
        `since ${new Date(Number(record?.startedAt ?? nowMs())).toISOString()}, so no browser was launched`,
      )
    }
    await sleep(POLL_MS)
  }
  const timer = startHeartbeat(dir)
  const release = () => {
    if (!held.delete(dir)) return
    clearInterval(timer)
    const record = readOwner(dir)
    if (record && record.pid === process.pid) {
      killTree(Number(record.browserPid ?? 0))
      reapProfileOwners(profileDir(dir))
      try { fs.unlinkSync(ownerFile(dir)) } catch {}
      try { fs.rmSync(profileDir(dir), { recursive: true, force: true }) } catch {}
    }
  }
  process.once('exit', release)
  return {
    dir,
    owner,
    profileDir: profileDir(dir),
    record(extra) {
      const current = readOwner(dir)
      if (current && current.pid === process.pid) writeOwner(dir, { ...current, ...extra, heartbeatAt: nowMs() })
    },
    release,
  }
}

export function status({ root = process.cwd() } = {}) {
  const dir = sessionDir(root)
  const record = readOwner(dir)
  if (!record) return { held: false, dir }
  return {
    held: true,
    dir,
    owner: record.owner,
    pid: record.pid,
    browserPid: record.browserPid ?? null,
    heartbeatAgeMs: nowMs() - Number(record.heartbeatAt ?? 0),
    live: holderIsLive(record, dir, Number(record.ttlMs ?? DEFAULT_TTL_MS)),
  }
}
