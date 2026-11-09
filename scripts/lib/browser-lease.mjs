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
const TICKET_MAX_AGE_MS = 3600000

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

function killBrowser(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    killTree(pid)
    return
  }
  try { process.kill(-pid, 'SIGKILL') } catch { killTree(pid) }
}

function processTable() {
  if (process.platform === 'win32') return windowsProcessTable()
  if (process.platform === 'linux') return linuxProcessTable()
  return psProcessTable()
}

function linuxProcessTable() {
  let names
  try { names = fs.readdirSync('/proc') } catch { return null }
  const table = []
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    let stat
    try { stat = fs.readFileSync('/proc/' + name + '/stat', 'utf8') } catch { continue }
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    table.push({ pid: Number(name), ppid: Number(fields[1]), start: fields[19] })
  }
  return table
}

function psProcessTable() {
  const r = spawnSync('ps', ['-Ao', 'pid=,ppid=,lstart='], { encoding: 'utf8' })
  if (r.status !== 0 || !r.stdout) return null
  const table = []
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (m) table.push({ pid: Number(m[1]), ppid: Number(m[2]), start: m[3] })
  }
  return table
}

function windowsProcessTable() {
  const script = 'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; start = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString("o") } else { "" }) } } | ConvertTo-Json -Compress'
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0 || !r.stdout || !r.stdout.trim()) return null
  let rows
  try { rows = JSON.parse(r.stdout) } catch { return null }
  return (Array.isArray(rows) ? rows : [rows]).map((row) => ({ pid: Number(row.pid), ppid: Number(row.ppid), start: String(row.start) }))
}

function browserTreeNow(rootPid) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return []
  const table = processTable()
  if (!table) {
    process.stderr.write('browser-lease: process table unreadable, children of browser pid ' + rootPid + ' not recorded\n')
    return []
  }
  const root = table.find((row) => row.pid === rootPid)
  if (!root) return []
  const found = [root]
  const frontier = [rootPid]
  const seen = new Set([rootPid])
  while (frontier.length) {
    const parent = frontier.shift()
    for (const row of table) {
      if (row.ppid !== parent || seen.has(row.pid)) continue
      seen.add(row.pid)
      found.push(row)
      frontier.push(row.pid)
    }
  }
  return found.map((row) => ({ pid: row.pid, start: row.start }))
}

function mergeTree(prior, found) {
  const byKey = new Map()
  for (const entry of [...(Array.isArray(prior) ? prior : []), ...found]) {
    byKey.set(entry.pid + ':' + entry.start, { pid: entry.pid, start: entry.start })
  }
  return [...byKey.values()]
}

function refreshedTree(record) {
  return mergeTree(record?.browserTree, browserTreeNow(Number(record?.browserPid ?? 0)))
}

function killRecorded(entries) {
  if (entries.length === 0) return
  const table = processTable()
  if (!table) {
    process.stderr.write('browser-lease: process table unreadable, recorded browser children were not stopped\n')
    return
  }
  const live = new Map(table.map((row) => [row.pid, row.start]))
  for (const entry of entries) {
    if (!entry.start || live.get(entry.pid) !== entry.start) continue
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(entry.pid), '/F'], { stdio: 'ignore' })
    else { try { process.kill(entry.pid, 'SIGKILL') } catch {} }
  }
}

export function sessionFingerprint({ args = [] } = {}) {
  return crypto.createHash('sha1')
    .update(JSON.stringify({ args: [...args].map(String).sort() }))
    .digest('hex')
    .slice(0, 16)
}

export function sessionDir(root) {
  const override = process.env.SPOINT_BROWSER_LEASE_DIR
  if (override) return path.resolve(override)
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

function inheritedLeaseOwnerPid() {
  const v = Number(process.env.SPOINT_BROWSER_LEASE_OWNER_PID ?? 0)
  return Number.isInteger(v) && v > 0 ? v : 0
}

function isOurHold(record, dir) {
  if (!record) return false
  if (Number(record.pid) === process.pid) return held.has(dir)
  const adopt = inheritedLeaseOwnerPid()
  return adopt > 0 && Number(record.pid) === adopt && pidAlive(adopt)
}

function portHasListenerSync(port) {
  const p = Number(port)
  if (!Number.isInteger(p) || p <= 0) return null
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' })
      if (r.status !== 0 || !r.stdout) return null
      for (const line of String(r.stdout).split('\n')) {
        const f = line.trim().split(/\s+/)
        if (f.length < 4 || !/^tcp/i.test(f[0])) continue
        if (!/LISTENING/i.test(f[3])) continue
        const m = /[:.](\d+)$/.exec(f[1] ?? '')
        if (m && Number(m[1]) === p) return true
      }
      return false
    }
    const r = spawnSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
    if (r.error) return null
    return Number.parseInt(String(r.stdout || '').trim().split('\n')[0] ?? '', 10) > 0
  } catch {
    return null
  }
}

function browserIsLive(record) {
  const browserPid = Number(record?.browserPid ?? 0)
  if (browserPid > 0 && !pidAlive(browserPid)) return false
  const port = Number(record?.port ?? 0)
  if (port > 0 && portHasListenerSync(port) === false) return false
  return true
}

function holderIsLive(record, dir, ttlMs) {
  if (!record) return false
  if (record.pid === process.pid) return held.has(dir)
  if (!pidAlive(record.pid)) return false
  const age = nowMs() - Number(record.heartbeatAt ?? 0)
  if (!(Number.isFinite(age) && age < ttlMs)) return false
  return browserIsLive(record)
}

function reclaimAbandonedHold(record) {
  const holderPid = Number(record?.pid ?? 0)
  if (!pidAlive(holderPid)) killTree(holderPid)
  killBrowser(Number(record?.browserPid ?? 0))
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
    if (isOurHold(record, dir)) {
      held.set(dir, { owner: record.owner ?? owner, ttlMs, adopted: true })
      return true
    }
    if (holderIsLive(record, dir, ttlMs)) return false
    reclaimAbandonedHold(record)
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
  held.set(dir, { owner, ttlMs, adopted: false })
  return true
}

function waitersDir(dir) {
  return `${dir}-waiters`
}

function sinceMs() {
  for (const name of ['SPOINT_BROWSER_LEASE_SINCE', 'SPOINT_GPU_LOCK_SINCE']) {
    const v = Number(process.env[name])
    if (Number.isFinite(v) && v > 0) return v
  }
  return nowMs()
}

function addTicket(dir, owner, nonce, since) {
  try {
    fs.mkdirSync(waitersDir(dir), { recursive: true })
    fs.writeFileSync(path.join(waitersDir(dir), `${nowMs()}.${nonce}.json`), `${JSON.stringify({ owner, nonce, pid: process.pid, ts: since })}\n`, 'utf8')
  } catch {}
}

function dropTicket(dir, nonce) {
  try {
    for (const name of fs.readdirSync(waitersDir(dir))) {
      if (!name.endsWith('.json')) continue
      let t = null
      try { t = JSON.parse(fs.readFileSync(path.join(waitersDir(dir), name), 'utf8')) } catch {}
      if (t && t.nonce === nonce) { try { fs.unlinkSync(path.join(waitersDir(dir), name)) } catch {} }
    }
  } catch {}
}

function oldestLiveTicket(dir) {
  let list
  try { list = fs.readdirSync(waitersDir(dir)) } catch { return null }
  let oldest = null
  for (const name of list) {
    if (!name.endsWith('.json')) continue
    let t = null
    try { t = JSON.parse(fs.readFileSync(path.join(waitersDir(dir), name), 'utf8')) } catch { continue }
    if (!t || !Number.isFinite(Number(t.ts))) continue
    if (!pidAlive(t.pid) || nowMs() - Number(t.ts) > TICKET_MAX_AGE_MS) {
      try { fs.unlinkSync(path.join(waitersDir(dir), name)) } catch {}
      continue
    }
    if (!oldest || Number(t.ts) < Number(oldest.ts) || (Number(t.ts) === Number(oldest.ts) && String(name) < String(oldest.name))) {
      oldest = { ...t, name }
    }
  }
  return oldest
}

function waitingOn(dir, nonce) {
  const oldest = oldestLiveTicket(dir)
  if (!oldest || oldest.nonce === nonce) return null
  return oldest
}

function startHeartbeat(dir) {
  const timer = setInterval(() => {
    if (!held.has(dir)) return
    const record = readOwner(dir)
    if (!record || record.pid !== process.pid) return
    try {
      writeOwner(dir, { ...record, heartbeatAt: nowMs(), browserTree: refreshedTree(record) })
    } catch {}
  }, HEARTBEAT_MS)
  timer.unref?.()
  return timer
}

export async function acquire({ root = process.cwd(), owner = `browser-${process.pid}`, fingerprint = DEFAULT_SESSION, waitMs = DEFAULT_WAIT_MS, ttlMs = DEFAULT_TTL_MS, sinceMs: sinceOverride } = {}) {
  const dir = sessionDir(root)
  const since = Number.isFinite(Number(sinceOverride)) && Number(sinceOverride) > 0 ? Number(sinceOverride) : sinceMs()
  const nonce = crypto.randomUUID()
  const deadline = nowMs() + waitMs
  addTicket(dir, owner, nonce, since)
  try {
    for (;;) {
      const ahead = waitingOn(dir, nonce)
      if (ahead) {
        if (nowMs() >= deadline) {
          throw new Error(
            `browser-lease: ${owner} waited ${waitMs}ms for the accelerated browser session of ${path.resolve(root)} ` +
            `behind ${ahead.owner} pid ${ahead.pid}, waiting since ${new Date(Number(ahead.ts)).toISOString()}, so no browser was launched`,
          )
        }
        await sleep(POLL_MS)
        continue
      }
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
  } finally {
    dropTicket(dir, nonce)
  }
  const entry = held.get(dir)
  const adopted = entry?.adopted === true
  const timer = adopted ? null : startHeartbeat(dir)
  const release = () => {
    const current = held.get(dir)
    if (!current) return
    held.delete(dir)
    if (current.adopted) return
    clearInterval(timer)
    const record = readOwner(dir)
    if (record && record.pid === process.pid) {
      const tree = refreshedTree(record)
      killBrowser(Number(record.browserPid ?? 0))
      killRecorded(tree)
      try { fs.unlinkSync(ownerFile(dir)) } catch {}
      try { fs.rmSync(profileDir(dir), { recursive: true, force: true }) } catch {}
    }
  }
  process.once('exit', release)
  return {
    dir,
    owner,
    adopted,
    profileDir: profileDir(dir),
    record(extra) {
      const current = readOwner(dir)
      if (current && (current.pid === process.pid || isOurHold(current, dir))) {
        const next = { ...current, ...extra, heartbeatAt: nowMs() }
        next.browserTree = refreshedTree(next)
        writeOwner(dir, next)
      }
    },
    release,
  }
}

export function status({ root = process.cwd() } = {}) {
  const dir = sessionDir(root)
  const record = readOwner(dir)
  if (!record) return { held: false, dir }
  let queued = 0
  let oldest = null
  try {
    for (const name of fs.readdirSync(waitersDir(dir))) {
      if (!name.endsWith('.json')) continue
      let t = null
      try { t = JSON.parse(fs.readFileSync(path.join(waitersDir(dir), name), 'utf8')) } catch { continue }
      if (!t || !pidAlive(t.pid)) continue
      queued++
      if (!oldest || Number(t.ts) < Number(oldest.ts)) oldest = t
    }
  } catch {}
  return {
    held: true,
    dir,
    owner: record.owner,
    pid: record.pid,
    browserPid: record.browserPid ?? null,
    heartbeatAgeMs: nowMs() - Number(record.heartbeatAt ?? 0),
    live: holderIsLive(record, dir, Number(record.ttlMs ?? DEFAULT_TTL_MS)),
    queued,
    oldestWaiter: oldest ? { owner: oldest.owner, pid: oldest.pid, waitingMs: nowMs() - Number(oldest.ts) } : null,
  }
}
