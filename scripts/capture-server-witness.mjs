#!/usr/bin/env node
// Node-only witness for the shared capture server (PERF-grass-frame-harness-friction-1013). No browser.
// Starts scripts/capture-server.mjs on a scratch port and state file, then proves: it serves the bundle
// with 200 and the expected hash; attach attaches when the server and hash are right; attach refuses
// on a wrong expected hash and when the server is down; a second start refuses instead of double-binding;
// and the listening-process count is 1 while the server runs and 0 after it stops.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expectedBundle, listeningPids, probeServer, readState } from './lib/capture-server.mjs'
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
try {
  rebuildClientBundle()
  const bundle = expectedBundle()
  check('the bundle this checkout built exists', !!bundle.sha256, bundle.fp || 'dist/client/app.js absent')

  const before = listeningPids(PORT)
  check('no listener on the scratch port before the server starts', before.length === 0, `listeners=${before.length}`)

  const noState = cli('capture-attach.mjs')
  check('attach refuses with no server state (no server is started)', noState.code === 3 && noState.line.includes('reason=no-server'), noState.line || `exit ${noState.code}`)

  const started = await startServer()
  child = started.child
  check('the server starts and reports RESULT: STARTED', started.line.startsWith('RESULT: STARTED'), started.line)

  const probe = await probeServer(PORT, { timeoutMs: 120000 })
  check('GET /app.js answers 200 with client-root=bundle', probe.status === 200 && probe.kind === 'bundle', `status=${probe.status} client-root=${probe.kind}`)
  check('the served entry hash equals the bundle this checkout built', probe.sha256 === bundle.sha256, `served=${String(probe.sha256).slice(0, 12)} built=${String(bundle.sha256).slice(0, 12)}`)

  const during = listeningPids(PORT)
  check('exactly one listening process while the server runs, and it is the server', during.length === 1 && during[0] === child.pid, `listeners=${during.join(',')} server=${child.pid}`)

  const state = readState(STATE)
  check('the state file records the port, pid and entry hash', state && state.port === PORT && state.pid === child.pid && state.entrySha256 === bundle.sha256, JSON.stringify({ port: state?.port, pid: state?.pid }))

  const attached = cli('capture-attach.mjs')
  check('attach ATTACHES when the server and hash are right', attached.code === 0 && attached.line.startsWith('RESULT: ATTACHED'), attached.line || `exit ${attached.code}`)

  const wrongHash = cli('capture-attach.mjs', ['--expect-sha256=' + '0'.repeat(64)])
  check('attach REFUSES on a root-hash mismatch', wrongHash.code === 3 && wrongHash.line.includes('reason=root-hash-mismatch'), `code=${wrongHash.code} ${wrongHash.line}`)

  const second = cli('capture-server.mjs', [`--port=${PORT}`])
  check('a second start REFUSES instead of double-binding', second.code === 3 && second.line.includes('reason=already-running'), `code=${second.code} ${second.line}`)
  const afterSecond = listeningPids(PORT)
  check('the refused second start leaves the listener count at one', afterSecond.length === 1 && afterSecond[0] === child.pid, `listeners=${afterSecond.join(',')}`)

  child.kill()
  await exited(child)
  child = null
  const afterStop = listeningPids(PORT)
  check('no listening process after the server stops', afterStop.length === 0, `listeners=${afterStop.length}`)

  const down = cli('capture-attach.mjs')
  check('attach REFUSES when the server is down', down.code === 3 && /reason=(server-down|no-server)/.test(down.line), down.line || `exit ${down.code}`)
} catch (e) {
  fails.push('exception')
  console.log('  [FAIL] exception: ' + ((e && e.stack) || e))
} finally {
  if (child && child.exitCode === null) child.kill()
  try { rmSync(SCRATCH, { recursive: true, force: true }) } catch {}
}

console.log(`RESULT: ${fails.length ? 'FAIL' : 'PASS'} -- capture-server ${fails.length ? fails.length + ' failing check(s)' : total + ' of ' + total + ' check(s) passed'}`)
process.exit(fails.length ? 1 : 0)
