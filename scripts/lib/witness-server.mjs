import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { armVerdictExitGuard } from './verdict-exit-guard.mjs'

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const STANDALONE_SERVER_ENTRY = join(REPO_ROOT, 'server.js')
export const STANDALONE_SERVER_REGISTRY = join(REPO_ROOT, '.gm', 'standalone-servers.json')
export const CHILD_STOP_GRACE_MS = 3000
export const STANDALONE_READY_TIMEOUT_MS = 180000
export const REGISTER_HARD_EXIT_MS = 60000

const tracked = []
let exitHookInstalled = false
let guardArmedByRegister = false

const alive = proc => !!proc && proc.exitCode === null && proc.signalCode === null && !proc.killed

function killTreeSync(proc) {
  if (process.platform !== 'win32') return
  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore', windowsHide: true })
  } catch (_) {}
}

function killProcSync(proc, hard) {
  if (!alive(proc)) return
  try { proc.kill(hard ? 'SIGKILL' : 'SIGTERM') } catch (_) {}
  if (hard) killTreeSync(proc)
}

async function stopChild(entry) {
  const proc = entry.proc
  if (!alive(proc)) return
  killProcSync(proc, false)
  const deadline = Date.now() + CHILD_STOP_GRACE_MS
  while (alive(proc) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
  if (alive(proc)) killProcSync(proc, true)
}

function stopEntry(entry) {
  if (entry.stopped) return null
  entry.stopped = true
  if (entry.proc) { killProcSync(entry.proc, false); dropRegistryRow(entry); return null }
  if (typeof entry.server?.stop !== 'function') return null
  return entry.server.stop()
}

async function stopEntryAsync(entry) {
  if (entry.stopped) return null
  entry.stopped = true
  if (entry.proc) { await stopChild(entry); dropRegistryRow(entry); return null }
  if (typeof entry.server?.stop !== 'function') return null
  return await entry.server.stop()
}

export function stopWitnessServersSync() {
  const result = { stopped: [], failed: [] }
  for (let i = tracked.length - 1; i >= 0; i--) {
    const entry = tracked[i]
    if (entry.stopped) continue
    try {
      stopEntry(entry)
      result.stopped.push(entry.label)
    } catch (error) {
      result.failed.push({ label: entry.label, message: error?.message || String(error) })
    }
  }
  return result
}

export async function stopWitnessServers() {
  const result = { stopped: [], failed: [] }
  for (let i = tracked.length - 1; i >= 0; i--) {
    const entry = tracked[i]
    if (entry.stopped) continue
    try {
      await stopEntryAsync(entry)
      result.stopped.push(entry.label)
    } catch (error) {
      result.failed.push({ label: entry.label, message: error?.message || String(error) })
    }
  }
  return result
}

function installExitHook() {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => { stopWitnessServersSync() })
}

export function witnessServerCount() {
  return tracked.filter(e => !e.stopped).length
}

function armGuardFromRegister(label) {
  if (guardArmedByRegister) return
  guardArmedByRegister = true
  armVerdictExitGuard({ label, quietMs: 0, hardExitMs: REGISTER_HARD_EXIT_MS })
}

export function registerWitnessServer(server, label = 'server') {
  if (!server || typeof server !== 'object') return server
  installExitHook()
  tracked.push({ server, label, stopped: false })
  armGuardFromRegister(String(label))
  return server
}

export function registerWitnessDeps(deps, label = 'server-deps') {
  if (!deps || typeof deps !== 'object') return deps
  installExitHook()
  tracked.push({
    label,
    stopped: false,
    server: {
      stop() {
        deps.tickSystem?.stop?.()
        deps.reloadManager?.destroy?.()
        deps.connections?.destroy?.()
        deps.sessions?.destroyAll?.()
      }
    }
  })
  armGuardFromRegister(String(label))
  return deps
}

export function registerWitnessChild(proc, label = 'child') {
  if (!proc || typeof proc !== 'object') return proc
  installExitHook()
  tracked.push({ proc, label, stopped: false })
  armGuardFromRegister(String(label))
  return proc
}


export function standaloneServerRegistry() {
  try {
    return JSON.parse(readFileSync(STANDALONE_SERVER_REGISTRY, 'utf8'))
  } catch (_) {
    return { rows: [] }
  }
}

function writeRegistry(reg) {
  try {
    mkdirSync(dirname(STANDALONE_SERVER_REGISTRY), { recursive: true })
    writeFileSync(STANDALONE_SERVER_REGISTRY, JSON.stringify(reg, null, 2))
  } catch (_) {}
}

function addRegistryRow(row) {
  const reg = standaloneServerRegistry()
  reg.rows = (reg.rows || []).filter(r => r.pid !== row.pid)
  reg.rows.push(row)
  writeRegistry(reg)
  return row
}

function dropRegistryRow(entry) {
  if (!entry?.registryPid) return
  const reg = standaloneServerRegistry()
  reg.rows = (reg.rows || []).filter(r => r.pid !== entry.registryPid)
  writeRegistry(reg)
  if (reg.rows.length === 0) rmSync(STANDALONE_SERVER_REGISTRY, { force: true })
}


export async function isPortServing(port, host = '127.0.0.1') {
  try {
    const r = await fetch(`http://${host}:${port}/`, { method: 'HEAD' })
    return r.ok || r.status === 200
  } catch {
    return false
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

export async function spawnStandaloneServer(opts = {}) {
  const {
    port = 0,
    cwd = REPO_ROOT,
    env = {},
    label = `node server.js :${port}`,
    readyTimeoutMs = STANDALONE_READY_TIMEOUT_MS,
    args = [],
  } = opts
  if (!Number.isInteger(port) || port <= 0) throw new Error(`spawnStandaloneServer: port must be a positive integer, got ${port}`)
  const childEnv = { ...process.env, PORT: String(port), ...env }
  const proc = spawn(process.execPath, [STANDALONE_SERVER_ENTRY, ...args], {
    cwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: false,
  })
  let output = ''
  const cap = s => { output += s; if (output.length > 8192) output = output.slice(-8192) }
  proc.stdout?.setEncoding('utf8')
  proc.stderr?.setEncoding('utf8')
  proc.stdout?.on('data', cap)
  proc.stderr?.on('data', cap)

  let exitInfo = null
  proc.once('exit', (code, signal) => { exitInfo = { code, signal } })

  const deadline = Date.now() + readyTimeoutMs
  while (Date.now() < deadline) {
    if (exitInfo !== null) break
    if (await isPortServing(port)) break
    await sleep(200)
  }
  const up = await isPortServing(port)
  if (!up) {
    killProcSync(proc, true)
    const why = exitInfo === null
      ? `it never answered http://127.0.0.1:${port}/ within ${readyTimeoutMs} ms`
      : `it exited early (code=${exitInfo.code} signal=${exitInfo.signal})`
    throw new Error(`spawnStandaloneServer: ${label} never came up -- ${why}\n${output.slice(-2000)}`)
  }

  const row = addRegistryRow({
    pid: proc.pid,
    port,
    label,
    ownerPid: process.pid,
    session: process.env.SESSION_ID || process.env.GM_SESSION_ID || null,
    entry: STANDALONE_SERVER_ENTRY,
    startedAt: new Date().toISOString(),
  })
  const entry = { proc, label, stopped: false, registryPid: row.pid }
  installExitHook()
  tracked.push(entry)
  armGuardFromRegister(String(label))
  return { proc, port, url: `http://127.0.0.1:${port}/`, label, owned: true }
}

export async function ensureStandaloneServer(opts = {}) {
  const { port = 0 } = opts
  if (await isPortServing(port)) return { up: true, owned: false, port, proc: null }
  const spawned = await spawnStandaloneServer(opts)
  return { up: true, owned: true, port: spawned.port, proc: spawned.proc, label: spawned.label }
}
