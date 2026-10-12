import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

const HEARTBEAT_MS = 2000
const DEFAULT_TTL_MS = 120000
const DEFAULT_WAIT_MS = 600000
const POLL_MS = 500

const held = new Set()

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

export function sessionFingerprint({ args = [], headless = false } = {}) {
  return crypto.createHash('sha1')
    .update(JSON.stringify({ headless: headless === true, args: [...args].map(String).sort() }))
    .digest('hex')
    .slice(0, 16)
}

export function sessionDir(root) {
  return path.join(path.resolve(root), '.gm', 'browser-lease', 'session')
}

function ownerFile(dir) {
  return path.join(dir, 'owner.json')
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

function holderIsLive(record, ttlMs) {
  if (!record) return false
  if (record.pid === process.pid && !held.has(record.dir)) return false
  if (!pidAlive(record.pid)) return false
  const age = nowMs() - Number(record.heartbeatAt ?? 0)
  return Number.isFinite(age) && age < ttlMs
}

function claim(dir, owner, fingerprint, ttlMs) {
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  try {
    fs.mkdirSync(dir)
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
    const record = readOwner(dir)
    if (holderIsLive(record, ttlMs)) return null
    killTree(Number(record?.pid ?? 0))
    killTree(Number(record?.browserPid ?? 0))
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    try {
      fs.mkdirSync(dir)
    } catch {
      return null
    }
  }
  held.add(dir)
  writeOwner(dir, { owner, fingerprint, pid: process.pid, startedAt: nowMs(), heartbeatAt: nowMs(), ttlMs })
  return true
}

function startHeartbeat(dir, owner, ttlMs) {
  const timer = setInterval(() => {
    const record = readOwner(dir)
    if (!record || record.pid !== process.pid) return
    try {
      writeOwner(dir, { ...record, heartbeatAt: nowMs() })
    } catch {}
  }, HEARTBEAT_MS)
  timer.unref?.()
  return timer
}

export async function acquire({ root = process.cwd(), owner = `browser-${process.pid}`, fingerprint, waitMs = DEFAULT_WAIT_MS, ttlMs = DEFAULT_TTL_MS } = {}) {
  const dir = sessionDir(root)
  const deadline = nowMs() + waitMs
  for (;;) {
    if (claim(dir, owner, fingerprint, ttlMs)) break
    const record = readOwner(dir)
    if (nowMs() >= deadline) {
      throw new Error(
        `browser-lease: ${owner} waited ${waitMs}ms for the accelerated browser session of ${path.resolve(root)} held by ` +
        `${record?.owner ?? 'an unreadable holder'} pid ${record?.pid ?? '?'} fingerprint ${record?.fingerprint ?? '?'} since ${new Date(Number(record?.startedAt ?? nowMs())).toISOString()}, so no browser was launched`,
      )
    }
    await sleep(POLL_MS)
  }
  const timer = startHeartbeat(dir, owner, ttlMs)
  const release = () => {
    if (!held.delete(dir)) return
    clearInterval(timer)
    const record = readOwner(dir)
    if (record && record.pid === process.pid) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  }
  process.once('exit', release)
  return {
    dir,
    owner,
    record(record_) { writeOwner(dir, { ...readOwner(dir), ...record_, pid: process.pid, heartbeatAt: nowMs() }) },
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
    live: holderIsLive({ ...record, dir }, Number(record.ttlMs ?? DEFAULT_TTL_MS)),
  }
}
