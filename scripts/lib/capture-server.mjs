// Shared capture server state (PERF-grass-frame-harness-friction-1013). One long-lived server
// (scripts/capture-server.mjs) serves the built client and records itself here; captures attach to it
// (scripts/capture-attach.mjs) and never start one. Node-only: no browser is launched by this module.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLIENT_ENTRY_SHA_HEADER, CLIENT_ENTRY_URL, CLIENT_ROOT_BUNDLE, CLIENT_ROOT_HEADER, clientRootCandidates, sha256OfFile } from './served-client-root.mjs'

export const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const DEFAULT_CAPTURE_PORT = 8790
export const CAPTURE_HOST = '127.0.0.1'
export const REFUSAL_HEADER = 'X-Spoint-Capture-Refusal'
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

// Request guard for the pinned root. Every request re-reads the bundle entry and compares it with the
// hash pinned at boot; a mismatch answers 503 with a named reason instead of serving the new bytes.
// The hash is memoised on (mtime, size), so an unchanged entry costs one stat per request.
export function makeRootGuard({ file, pinnedSha256 }) {
  let memo = { mtimeMs: -1, size: -1, sha: null }
  const currentSha = () => {
    const st = statSync(file)
    if (st.mtimeMs !== memo.mtimeMs || st.size !== memo.size) {
      memo = { mtimeMs: st.mtimeMs, size: st.size, sha: createHash('sha256').update(readFileSync(file)).digest('hex') }
    }
    return memo.sha
  }
  return function rootGuard(req, res) {
    let now = null
    try { now = currentSha() } catch { now = null }
    if (now === pinnedSha256) return false
    const reason = now === null ? 'root-missing' : 'root-hash-changed'
    res.writeHead(503, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'close',
      [REFUSAL_HEADER]: reason,
      'X-Spoint-Pinned-Sha256': pinnedSha256,
      'X-Spoint-Served-Sha256': now || 'none',
    })
    res.end(`capture-server refused: ${reason} pinned=${pinnedSha256.slice(0, 12)} now=${now ? now.slice(0, 12) : 'none'}\n`)
    return true
  }
}

export async function probeServer(port, { timeoutMs = 3000, host = CAPTURE_HOST } = {}) {
  try {
    const res = await fetch(`http://${host}:${port}${CLIENT_ENTRY_URL}`, { cache: 'no-store', headers: { Connection: 'close' }, signal: AbortSignal.timeout(timeoutMs) })
    await res.arrayBuffer()
    return {
      status: res.status,
      kind: res.headers.get(CLIENT_ROOT_HEADER),
      sha256: res.headers.get(CLIENT_ENTRY_SHA_HEADER),
      refusal: res.headers.get(REFUSAL_HEADER),
    }
  } catch (e) {
    return { error: (e && (e.cause?.code || e.name || e.message)) || 'unreachable' }
  }
}

export function portAccepts(port, { host = CAPTURE_HOST, timeoutMs = 1000 } = {}) {
  return new Promise((done) => {
    const sock = connect({ host, port })
    const finish = (v) => { sock.destroy(); done(v) }
    sock.setTimeout(timeoutMs, () => finish(false))
    sock.once('connect', () => finish(true))
    sock.once('error', () => finish(false))
  })
}

// Non-loopback IPv4 addresses of this machine; a connection to one of them is a non-loopback peer.
export function nonLoopbackAddresses() {
  return Object.values(networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address)
}

// Connect attempt to host:port. Resolves to 'connected', 'timeout', or the error code (e.g. ECONNREFUSED).
export function connectTo(host, port, { timeoutMs = 2000 } = {}) {
  return new Promise((done) => {
    const sock = connect({ host, port })
    const finish = (v) => { sock.destroy(); done(v) }
    sock.setTimeout(timeoutMs, () => finish('timeout'))
    sock.once('connect', () => finish('connected'))
    sock.once('error', (e) => finish(e.code || 'error'))
  })
}

// Listening sockets on the port as {pid, addr}. Windows reads Get-NetTCPConnection, darwin lsof, linux ss.
// Throws when the instrument itself is absent: an unmeasured listener is never reported as zero.
export function listeners(port) {
  if (process.platform === 'win32') {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) { exit 2 }; $c = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue; if ($c) { $c | ForEach-Object { "$($_.OwningProcess) $($_.LocalAddress)" } }; exit 0`],
      { encoding: 'utf8' })
    return out.split(/\r?\n/).map(l => l.trim().split(/\s+/)).filter(p => /^\d+$/.test(p[0] || '')).map(p => ({ pid: Number(p[0]), addr: p[1] }))
  }
  if (process.platform === 'darwin') {
    let out = ''
    try { out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }) } catch (e) { if (e.status !== 1) throw e }
    return out.split(/\r?\n/).slice(1).filter(Boolean).map(l => { const f = l.trim().split(/\s+/); const name = f[8] || ''; return { pid: Number(f[1]), addr: name.slice(0, name.lastIndexOf(':')).replace(/[[\]]/g, '') } })
  }
  const out = execFileSync('ss', ['-Hltnp', `sport = :${port}`], { encoding: 'utf8' })
  return out.split(/\r?\n/).filter(Boolean).map(l => {
    const f = l.trim().split(/\s+/); const pid = (l.match(/pid=(\d+)/) || [])[1]
    return { pid: Number(pid), addr: f[3].slice(0, f[3].lastIndexOf(':')).replace(/[[\]]/g, '') }
  })
}

// Attach check. Never starts a server. Refuses with a named reason; attaches only when the server is up,
// serves client-root=bundle, and its served entry hashes to the bundle this checkout built.
export async function attachCapture({ statePath = STATE_PATH, port = null, expectSha256 = null, sdkRoot = SDK_ROOT } = {}) {
  const state = readState(statePath)
  if (!state) return { ok: false, reason: 'no-server', detail: `no ${statePath}; start one with node scripts/capture-server.mjs` }
  if (state.corrupt) return { ok: false, reason: 'no-server', detail: `${statePath} is unreadable` }
  const usePort = port ?? state.port
  const bundle = expectedBundle(sdkRoot)
  if (!bundle.sha256) return { ok: false, reason: 'no-bundle', detail: 'dist/client/app.js is absent; run npm run build:client' }
  const want = expectSha256 || bundle.sha256
  const probe = await probeServer(usePort, { timeoutMs: 60000 })
  if (probe.error) return { ok: false, reason: 'server-down', detail: `port ${usePort} (state pid ${state.pid}): ${probe.error}` }
  if (probe.refusal) return { ok: false, reason: probe.refusal, detail: `the server (pid ${state.pid}) refused: pinned ${String(state.entrySha256).slice(0, 12)}, the bundle on disk has changed since boot` }
  if (probe.status !== 200) return { ok: false, reason: 'server-down', detail: `GET ${CLIENT_ENTRY_URL} answered ${probe.status}` }
  if (probe.kind !== CLIENT_ROOT_BUNDLE) return { ok: false, reason: 'root-kind-mismatch', detail: `served client-root=${probe.kind}, required ${CLIENT_ROOT_BUNDLE}` }
  if (probe.sha256 !== want) return { ok: false, reason: 'root-hash-mismatch', detail: `served sha ${String(probe.sha256).slice(0, 12)} != expected ${want.slice(0, 12)}` }
  return { ok: true, reason: 'attached', url: `http://${CAPTURE_HOST}:${usePort}/`, port: usePort, pid: state.pid, sha256: probe.sha256 }
}
