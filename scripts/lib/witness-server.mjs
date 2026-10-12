// Witness-side server lifecycle: one registry, one exit path.
//
// A spoint server that is started and never stopped keeps the node event loop
// alive forever (measured: 358 active handles after `server.start()`, process
// still alive 20 s after main returned), so a witness that boots one and then
// merely falls off the end of main leaks a live process holding a port. Ten
// tracked witnesses boot a server and have no stop site; they survive only
// because they reach a `process.exit()`, which skips `stop()` entirely -- and
// `process.exit()` with handles mid-close is the uv_async_send assert case.
//
// The same class exists one process OUT: `node server.js` -- the repo-root
// entry that boots src/sdk/server.js and serves the client index.html a browser
// witness drives -- started by hand and never stopped. Measured 2026-10-12:
// three of them on :3001, :3002 and :8090, each with ZERO established TCP
// connections, each started by a lane that had since finished. Two were spawned
// through Git-for-Windows `nohup.exe`, whose own parent was already dead, and
// the third hung off a claude.exe stdio MCP that had gone quiet 617 minutes
// earlier. Nothing in the tree owned any of them, so nothing could stop them.
//
// `nohup` is what makes that unfixable in principle: it detaches the server
// from the witness's process group, so a guard that only ever calls
// `process.exit()` in the witness process cannot reach a server it detached.
// `spawnStandaloneServer()` is the answer: it starts that process INSIDE the
// witness that needs it, un-detached, and registers the child here, so a leak
// of this class is unrepresentable instead of merely discouraged.
//
// The registry deliberately does NOT reap servers it does not own. A repo-local
// pid registry would be shared by every lane on the box, and reaping from it is
// exactly what scripts/server-leak-witness.mjs refuses to do ("it never reaps
// any other process, including the spoint servers other lanes are running").
// `standaloneServerRegistry()` is therefore write-and-report only: it records a
// pid so the lane that owns retirement can see it, and `spawnStandaloneServer`
// removes its own row when it stops. Nothing here kills a pid it did not spawn.
//
// The fix is this registry, not a try/finally per witness: register the server
// at the boot site (one line) and the process-exit hook stops it. Witnesses that
// route their exit through scripts/lib/quiesce.mjs get the stop before the
// handle drain, so they exit because the loop emptied rather than by force.
//
// Registering also arms scripts/lib/verdict-exit-guard.mjs, so a witness that
// forgets `armVerdictExitGuard()` still leaves through a bounded hard exit once
// its verdict is out instead of idling forever. It does NOT fabricate a FAIL:
// the loud red on post-verdict silence stays opt-in, for witnesses that ask for
// it by calling the guard themselves.
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// Static on purpose. An earlier cut armed the guard through a fire-and-forget
// `import()`, which races the witness: one live run booted a server, printed its
// verdict and then sat for 650 s because the arm had not landed when the verdict
// went out. Function declarations hoist across the cycle
// (verdict-exit-guard.mjs imports this module back), so a static import resolves
// at load and the arm is synchronous.
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

// TerminateProcess kills one pid, not a tree, and `node server.js` is a spawn
// root: without the tree kill a grandchild would keep the port bound after the
// witness that started it is gone.
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

// A witness that registers a server has already told us it intends to exit, so
// it gets the hard-exit bound for free. The verdict guard's fail-loud arm (post-
// verdict silence is a red RESULT) stays opt-in: only a witness that calls
// armVerdictExitGuard() itself has asked to be judged on that.
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

// A child process this witness spawned -- a `node server.js` or any other
// helper -- holds the parent's event loop open for as long as it lives, so an
// unregistered child is both a leaked handle and a leaked process.
export function registerWitnessChild(proc, label = 'child') {
  if (!proc || typeof proc !== 'object') return proc
  installExitHook()
  tracked.push({ proc, label, stopped: false })
  armGuardFromRegister(String(label))
  return proc
}

// ------------------------------------------------------- pid registry (report)

// Write-and-report only. Rows are keyed by pid so the lane that owns retirement
// can see what this repo started; nothing in this module kills a row it did not
// spawn, because a repo-local registry is shared by every lane on the box.
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

// ---------------------------------------------------------- standalone server

export async function isPortServing(port, host = '127.0.0.1') {
  try {
    const r = await fetch(`http://${host}:${port}/`, { method: 'HEAD' })
    return r.ok || r.status === 200
  } catch {
    return false
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * Starts the repo-root `node server.js` inside this process and registers the
 * child, so the server cannot outlive the witness that needs it.
 *
 * Never detached, never through a shell and never through `nohup`: detaching is
 * precisely what put servers on :3001/:3002/:8090 beyond the reach of every
 * exit guard in the tree.
 */
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

/**
 * The server a browser witness needs, without making the caller own a process.
 * A server already listening on `port` is used and NOT owned -- it belongs to
 * whoever started it, and this module never stops a process it did not spawn.
 */
export async function ensureStandaloneServer(opts = {}) {
  const { port = 0 } = opts
  if (await isPortServing(port)) return { up: true, owned: false, port, proc: null }
  const spawned = await spawnStandaloneServer(opts)
  return { up: true, owned: true, port: spawned.port, proc: spawned.proc, label: spawned.label }
}
