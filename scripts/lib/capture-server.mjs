// Shared capture server state (PERF-grass-frame-harness-friction-1013). One long-lived server
// (scripts/capture-server.mjs) serves the built client and records itself here; captures attach to it
// (scripts/capture-attach.mjs) and never start one. Node-only: no browser is launched by this module.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLIENT_ENTRY_SHA_HEADER, CLIENT_ENTRY_URL, CLIENT_ROOT_BUNDLE, CLIENT_ROOT_HEADER, clientRootCandidates, sha256OfFile } from './served-client-root.mjs'

export const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const DEFAULT_CAPTURE_PORT = 8790
export const STATE_PATH = process.env.SPOINT_CAPTURE_STATE || join(SDK_ROOT, '.gm', 'capture-server.json')

export function readState(path = STATE_PATH) {
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return { corrupt: true } }
}

export function removeState(path = STATE_PATH, pid = null) {
  const s = readState(path)
  if (!s || (pid !== null && s.pid !== pid)) return false
  try { unlinkSync(path); return true } catch { return false }
}

// The bundle the served page must run: dist/client/app.js, hashed the same way the server hashes it.
export function expectedBundle(sdkRoot = SDK_ROOT) {
  const fp = clientRootCandidates(sdkRoot)[CLIENT_ROOT_BUNDLE]
  if (!fp) return { fp: null, sha256: null }
  return { fp, sha256: sha256OfFile(fp) }
}

export async function probeServer(port, { timeoutMs = 3000 } = {}) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${CLIENT_ENTRY_URL}`, { cache: 'no-store', headers: { Connection: 'close' }, signal: AbortSignal.timeout(timeoutMs) })
    await res.arrayBuffer()
    return {
      status: res.status,
      kind: res.headers.get(CLIENT_ROOT_HEADER),
      sha256: res.headers.get(CLIENT_ENTRY_SHA_HEADER),
    }
  } catch (e) {
    return { error: (e && (e.cause?.code || e.name || e.message)) || 'unreachable' }
  }
}

export function portAccepts(port, { timeoutMs = 1000 } = {}) {
  return new Promise((done) => {
    const sock = connect({ host: '127.0.0.1', port })
    const finish = (v) => { sock.destroy(); done(v) }
    sock.setTimeout(timeoutMs, () => finish(false))
    sock.once('connect', () => finish(true))
    sock.once('error', () => finish(false))
  })
}

// Distinct pids holding a LISTEN socket on the port. Windows reads Get-NetTCPConnection, darwin lsof,
// linux ss. Throws when the instrument itself is absent: an unmeasured count is never reported as zero.
export function listeningPids(port) {
  if (process.platform === 'win32') {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) { exit 2 }; $c = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue; if ($c) { $c | ForEach-Object { $_.OwningProcess } }; exit 0`],
      { encoding: 'utf8' })
    return [...new Set(out.split(/\s+/).filter(s => /^\d+$/.test(s)).map(Number))]
  }
  if (process.platform === 'darwin') {
    let out = ''
    try { out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }) } catch (e) { if (e.status !== 1) throw e }
    return [...new Set(out.split(/\s+/).filter(s => /^\d+$/.test(s)).map(Number))]
  }
  const out = execFileSync('ss', ['-Hltnp', `sport = :${port}`], { encoding: 'utf8' })
  return [...new Set([...out.matchAll(/pid=(\d+)/g)].map(m => Number(m[1])))]
}

// Attach check. Never starts a server. Refuses with a named reason; attaches only when the server is up,
// serves client-root=bundle, and its served entry hashes to the bundle this checkout built.
export async function attachCapture({ statePath = STATE_PATH, port = null, expectSha256 = null, sdkRoot = SDK_ROOT } = {}) {
  const state = readState(statePath)
  const usePort = port ?? state?.port ?? null
  if (!state) return { ok: false, reason: 'no-server', detail: `no ${statePath}; start one with node scripts/capture-server.mjs` }
  if (state.corrupt) return { ok: false, reason: 'no-server', detail: `${statePath} is unreadable` }
  const bundle = expectedBundle(sdkRoot)
  if (!bundle.sha256) return { ok: false, reason: 'no-bundle', detail: 'dist/client/app.js is absent; run npm run build:client' }
  const want = expectSha256 || bundle.sha256
  const probe = await probeServer(usePort, { timeoutMs: 60000 })
  if (probe.error) return { ok: false, reason: 'server-down', detail: `port ${usePort} (state pid ${state.pid}): ${probe.error}` }
  if (probe.status !== 200) return { ok: false, reason: 'server-down', detail: `GET ${CLIENT_ENTRY_URL} answered ${probe.status}` }
  if (probe.kind !== CLIENT_ROOT_BUNDLE) return { ok: false, reason: 'root-kind-mismatch', detail: `served client-root=${probe.kind}, required ${CLIENT_ROOT_BUNDLE}` }
  if (probe.sha256 !== want) return { ok: false, reason: 'root-hash-mismatch', detail: `served sha ${String(probe.sha256).slice(0, 12)} != expected ${want.slice(0, 12)}` }
  return { ok: true, reason: 'attached', url: `http://localhost:${usePort}/`, port: usePort, pid: state.pid, sha256: probe.sha256 }
}
