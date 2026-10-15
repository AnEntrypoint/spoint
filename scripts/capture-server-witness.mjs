#!/usr/bin/env node
// Node-only witness for the shared capture server (PERF-grass-frame-harness-friction-1013). No browser.
// Starts scripts/capture-server.mjs on a scratch port and state file, then proves: it binds 127.0.0.1
// only and a non-loopback connection is refused; it serves the bundle with 200 and the expected hash;
// attach attaches when the server and hash are right; attach refuses on a wrong expected hash and when
// the server is down; a rebuild after boot is refused with a named reason rather than served, and service
// resumes once the bytes are restored; a second start refuses instead of double-binding; and the listener
// count is 1 while the server runs and 0 after it stops.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CAPTURE_HOST, connectTo, expectedBundle, listeners, nonLoopbackAddresses, probeServer, readState } from './lib/capture-server.mjs'
import { rebuildClientBundle } from './lib/served-client-root.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRATCH = mkdtempSync(join(tmpdir(), 'capture-server-witness-'))
const STATE = join(SCRATCH, 'capture-server.json')
const PORT = 20000 + Math.floor(Math.random() * 20000)
const env = { ...process.env, SPOINT_CAPTURE_STATE: STATE, WORLD: 'tps-game' }
const fails = []
let total = 0
const check = (name, ok, detail) => { total++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}: ${detail}`); if (!ok) fails.push(name) }

const cli = (script, extra = []) => {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', script), `--state=${STATE}`, ...extra], { env, encoding: 'utf8', timeout: 120000 })
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('RESULT:')) || ''
  return { code: r.status, line: line.trim() }
}
const startServer = () => new Promise((done, fail) => {
  const child = spawn(process.execPath, [join(ROOT, 'scripts', 'capture-server.mjs'), `--port=${PORT}`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let buf = ''
  const timer = setTimeout(() => fail(new Error('capture server did not report RESULT within 600 s')), 600000)
  child.stdout.on('data', (d) => {
    buf += d
    const m = buf.match(/RESULT: [A-Z]+[^\n]*/)
    if (m) { clearTimeout(timer); done({ child, line: m[0].trim() }) }
  })
  child.stderr.on('data', () => {})
  child.on('exit', (code) => { clearTimeout(timer); fail(new Error(`capture server exited ${code} before RESULT: ${buf.slice(-300)}`)) })
})
const exited = (child) => new Promise((done) => { if (child.exitCode !== null || child.signalCode) return done(); child.once('exit', done) })

let child = null
let bundleFp = null
let original = null
try {
  rebuildClientBundle()
  const bundle = expectedBundle()
  bundleFp = bundle.fp
  check('the bundle this checkout built exists', !!bundle.sha256, bundle.fp || 'dist/client/app.js absent')

  const before = listeners(PORT)
  check('no listener on the scratch port before the server starts', before.length === 0, `listeners=${before.length}`)

  const noState = cli('capture-attach.mjs')
  check('attach refuses with no server state (no server is started)', noState.code === 3 && noState.line.includes('reason=no-server'), noState.line || `exit ${noState.code}`)

  const started = await startServer()
  child = started.child
  check('the server starts and reports RESULT: STARTED', started.line.startsWith('RESULT: STARTED'), started.line)

  const rows = listeners(PORT)
  const nonLoop = nonLoopbackAddresses()
  const refused = []
  for (const addr of nonLoop) refused.push(`${addr}:${await connectTo(addr, PORT, { timeoutMs: 5000 })}`)
  const allRefused = nonLoop.length > 0 && refused.every(r => r.endsWith(':ECONNREFUSED'))
  const LOOPBACK = new Set([CAPTURE_HOST, '::1'])
  const onlyLoopback = rows.length > 0 && rows.every(r => LOOPBACK.has(r.addr)) && rows.some(r => r.addr === CAPTURE_HOST)
  const pids = [...new Set(rows.map(r => r.pid))]
  check('the server listens on 127.0.0.1 only, and a non-loopback connection is refused',
    onlyLoopback && pids.length === 1 && pids[0] === child.pid && allRefused,
    `listen=${rows.map(r => `${r.addr}/pid${r.pid}`).join(',')} (loopback only: ${onlyLoopback}) non-loopback=[${refused.join(' ') || 'none on this box'}]`)

  const probe = await probeServer(PORT, { timeoutMs: 120000 })
  check('GET /app.js answers 200 with client-root=bundle', probe.status === 200 && probe.kind === 'bundle', `status=${probe.status} client-root=${probe.kind}`)
  check('the served entry hash equals the bundle this checkout built', probe.sha256 === bundle.sha256, `served=${String(probe.sha256).slice(0, 12)} built=${String(bundle.sha256).slice(0, 12)}`)

  const during = listeners(PORT)
  const duringPids = [...new Set(during.map(r => r.pid))]
  check('exactly one listening process while the server runs, and it is the server', duringPids.length === 1 && duringPids[0] === child.pid, `listening pids=${duringPids.join(',')} server=${child.pid}`)

  const state = readState(STATE)
  check('the state file records the port, pid and entry hash', state && state.port === PORT && state.pid === child.pid && state.entrySha256 === bundle.sha256, JSON.stringify({ port: state?.port, pid: state?.pid }))

  const attached = cli('capture-attach.mjs')
  check('attach ATTACHES when the server and hash are right', attached.code === 0 && attached.line.startsWith('RESULT: ATTACHED'), attached.line || `exit ${attached.code}`)

  const wrongHash = cli('capture-attach.mjs', ['--expect-sha256=' + '0'.repeat(64)])
  check('attach REFUSES on a root-hash mismatch', wrongHash.code === 3 && wrongHash.line.includes('reason=root-hash-mismatch'), `code=${wrongHash.code} ${wrongHash.line}`)

  // Rebuild after boot. The live bundle entry is changed in place for the duration of the probe and
  // restored byte-for-byte in finally: boot() reads the real dist tree, so a second tree is not an input.
  original = readFileSync(bundleFp)
  writeFileSync(bundleFp, Buffer.concat([original, Buffer.from('\n//capture-pin-witness\n')]))
  const changed = await probeServer(PORT, { timeoutMs: 120000 })
  const changedAttach = cli('capture-attach.mjs')
  writeFileSync(bundleFp, original)
  original = null
  const restored = await probeServer(PORT, { timeoutMs: 120000 })
  check('a rebuild after boot is refused with root-hash-changed, not served; restoring resumes service',
    changed.status === 503 && changed.refusal === 'root-hash-changed' && changed.sha256 === null && changedAttach.code === 3 && changedAttach.line.includes('reason=root-hash-changed') && restored.status === 200 && restored.sha256 === bundle.sha256,
    `during: status=${changed.status} refusal=${changed.refusal} attach=${changedAttach.line || changedAttach.code}; after restore: status=${restored.status}`)

  const second = cli('capture-server.mjs', [`--port=${PORT}`])
  check('a second start REFUSES instead of double-binding', second.code === 3 && second.line.includes('reason=already-running'), `code=${second.code} ${second.line}`)
  const afterSecond = listeners(PORT)
  const afterSecondPids = [...new Set(afterSecond.map(r => r.pid))]
  check('the refused second start leaves the listening process count at one', afterSecondPids.length === 1 && afterSecondPids[0] === child.pid, `listening pids=${afterSecondPids.join(',')}`)

  child.kill()
  await exited(child)
  child = null
  const afterStop = listeners(PORT)
  check('no listening process after the server stops', afterStop.length === 0, `listeners=${afterStop.length}`)

  const down = cli('capture-attach.mjs')
  check('attach REFUSES when the server is down', down.code === 3 && /reason=(server-down|no-server)/.test(down.line), down.line || `exit ${down.code}`)
} catch (e) {
  fails.push('exception')
  console.log('  [FAIL] exception: ' + ((e && e.stack) || e))
} finally {
  if (original && bundleFp) { try { writeFileSync(bundleFp, original) } catch (e) { console.log('  [FAIL] restore bundle: ' + e.message); fails.push('restore') } }
  if (child && child.exitCode === null) child.kill()
  try { rmSync(SCRATCH, { recursive: true, force: true }) } catch {}
}

console.log(`RESULT: ${fails.length ? 'FAIL' : 'PASS'} -- capture-server ${fails.length ? fails.length + ' failing check(s)' : total + ' of ' + total + ' check(s) passed'}`)
process.exit(fails.length ? 1 : 0)
