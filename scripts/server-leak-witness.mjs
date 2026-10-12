#!/usr/bin/env node
// server-leak-witness: a witness that leaves a spoint server running leaks a live
// process holding a port. Measured: after `server.start()` the process holds 358
// active handles and is still alive 20 s after main returned, so a witness with no
// shutdown path never exits at all. Nothing counted that, so the class persisted.
//
// This witness counts live spoint server processes before and after a witness run
// and fails if the run leaves one behind. It has two arms:
//   --arm=clean  the fixture witness registers its server on the shared shutdown
//                path (scripts/lib/witness-server.mjs) and exits because its loop
//                emptied.
//   --arm=leak   the fixture witness has no shutdown path at all -- the shape the
//                ten tracked boot-without-stop witnesses had before the fix. This
//                arm is the mutation proof: the same witness must go red.
//
// It only ever signals the child it spawned itself. It never reaps any other
// process, including the spoint servers other lanes are running.
import { spawn, execFileSync } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const WITNESS_NAME = 'scripts/server-leak-witness.mjs'
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CENSUS_TOKEN = 'SPOINT_SERVER_LEAK_FIXTURE'
const LISTEN_TIMEOUT_MS = 90000
const EXIT_BUDGET_MS = 45000
const STANDALONE_SERVER_RE = /(^|[\s'"/\\])server\.js(\s|$)|src[\\/]sdk[\\/]server\.js/

const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  const eq = hit.indexOf('=')
  return eq < 0 ? 'true' : hit.slice(eq + 1)
}

// ---------------------------------------------------------------- fixture arm

async function serve() {
  const port = Number(flag('port', '0'))
  const storageDir = flag('storage', join(tmpdir(), 'spoint-server-leak-witness-storage'))
  const arm = flag('arm', 'clean')
  mkdirSync(storageDir, { recursive: true })
  const { createServer } = await import('../src/sdk/server.js')
  const server = await createServer({
    port,
    tickRate: 30,
    appsDirs: [],
    staticDirs: [],
    sdkRoot: REPO_ROOT,
    storageDir,
  })
  // The fix, one line: register the booted server so the shared exit path stops
  // it. The leak arm is the mutation -- it drops this line and the shared exit
  // path below, which is exactly what a boot-without-stop witness does.
  if (arm !== 'leak') {
    const { registerWitnessServer } = await import('./lib/witness-server.mjs')
    registerWitnessServer(server, `${WITNESS_NAME} --serve`)
  }
  await server.start()
  console.log(`SERVER-LEAK listening on ${port}`)
  if (arm === 'leak') {
    process.exitCode = 0
    return
  }
  const { exitAfterQuiesce } = await import('./lib/quiesce.mjs')
  const pending = await exitAfterQuiesce(0, 10000)
  console.log(`SERVER-LEAK quiesce pending=${pending}`)
}

// ------------------------------------------------------------------- census

function census() {
  let text = ''
  if (process.platform === 'win32') {
    text = execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { Write-Output ($_.ProcessId.ToString() + ' ' + $_.CommandLine) }"
    ], { encoding: 'utf8', timeout: 60000, windowsHide: true })
  } else {
    text = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 60000 })
  }
  const found = new Map()
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const cmd = m[2]
    if (!/\bnode(\.exe)?\b/i.test(cmd)) continue
    const isStandaloneSpServer = STANDALONE_SERVER_RE.test(cmd)
    const isThisFixture = cmd.includes(CENSUS_TOKEN)
    if (!isStandaloneSpServer && !isThisFixture) continue
    found.set(Number(m[1]), { cmd, isStandaloneSpServer, isThisFixture })
  }
  return found
}

function freePort() {
  return new Promise((ok, fail) => {
    const probe = createNetServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => ok(port))
    })
  })
}

function trackedScriptFiles() {
  const out = execFileSync('git', ['ls-files', 'scripts'], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60000 })
  return out.split(/\r?\n/).filter(f => /\.(mjs|js|cjs)$/.test(f))
}

// A tracked scripts/*.mjs that boots a spoint server must own a shutdown path:
// registering on the shared helper, stopping the server, or a directory stopAll.
const BOOT_RE = /\b(?:const\s+\w+\s*=\s*)?await\s+(createServer|boot)\s*\(/
const STOP_RE = /\b(?:registerWitnessServer|stopWitnessServers|stopAll)\s*\(|\b(?:server|api|srv|deps|live|room|roomServer|router|host|orch|dir|s)\s*(?:\?\.|\.)\s*stop\s*\(/

function bootWithoutStop() {
  const out = []
  for (const rel of trackedScriptFiles()) {
    const abs = join(REPO_ROOT, rel)
    if (!existsSync(abs)) continue
    const src = readFileSync(abs, 'utf8')
    if (!/src[\\/]sdk[\\/]server\.js/.test(src)) continue
    const boots = src.split(/\r?\n/).filter(l => BOOT_RE.test(l) && !/^\s*(\/\/|\*)/.test(l))
    if (boots.length === 0) continue
    if (STOP_RE.test(src)) continue
    out.push({ file: rel, boots: boots.length })
  }
  return out
}

// --------------------------------------------------------------------- main

async function run() {
  const arm = flag('arm', 'clean')
  const checks = []
  const record = (label, ok, detail = '') => {
    checks.push({ label, ok: ok === true, detail: String(detail) })
  }

  const before = census()
  const standaloneBefore = [...before.values()].filter(v => v.isStandaloneSpServer).length
  console.log(`server-leak census: ${before.size} live spoint server process(es), of which ${standaloneBefore} standalone server.js`)

  const port = await freePort()
  const storageDir = join(tmpdir(), 'spoint-server-leak-witness-storage')
  rmSync(storageDir, { recursive: true, force: true })
  const child = spawn(process.execPath, [
    WITNESS_NAME, '--serve',
    `--arm=${arm}`,
    `--port=${port}`,
    `--storage=${storageDir}`,
    `--census-token=${CENSUS_TOKEN}`,
  ], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', c => { stdout += c })
  child.stderr.on('data', c => { stderr += c })
  const exited = new Promise(ok => {
    child.once('exit', (code, signal) => ok({ code, signal }))
    child.once('error', err => ok({ code: null, signal: null, error: err.message }))
  })

  const deadline = Date.now() + LISTEN_TIMEOUT_MS
  while (Date.now() < deadline && !/SERVER-LEAK listening on/.test(stdout)) {
    await new Promise(r => setTimeout(r, 50))
  }
  const listening = /SERVER-LEAK listening on (\d+)/.exec(stdout)
  record('the fixture witness booted a server and reported its port', listening !== null, listening ? listening[0] : `stdout=${JSON.stringify(stdout.slice(0, 200))}`)
  if (!listening) {
    record('the fixture witness left no server process behind', false, 'the fixture never booted, so the census arm did not run')
    return { checks, child, before, after: before, stdout, stderr, arm, standaloneBefore }
  }

  const during = census()
  const newPids = [...during.keys()].filter(p => !before.has(p))
  record('the census counts the booted fixture as a live spoint server process', newPids.includes(child.pid), `new_pids=[${newPids.join(',')}] child_pid=${child.pid}`)

  const exit = await Promise.race([
    exited,
    new Promise(ok => setTimeout(() => ok(null), EXIT_BUDGET_MS)),
  ])
  record('the fixture witness exited on its own, without being signalled', exit !== null, exit === null ? `still running after ${EXIT_BUDGET_MS} ms: pid=${child.pid} stdout=${JSON.stringify(stdout.slice(-200))}` : `code=${exit.code} signal=${exit.signal}`)

  const after = census()
  let left = [...after.keys()].filter(p => !before.has(p))
  if (exit === null) {
    // The fixture is our own child and is holding a port: stop it so this run does
    // not itself leave the leak it just detected. It never exited on its own, so
    // the run has already failed -- the leftover check below records that rather
    // than quietly passing on the kill we just did.
    child.kill('SIGKILL')
    await Promise.race([exited, new Promise(r => setTimeout(r, 5000))])
    const settled = census()
    left = [...settled.keys()].filter(p => !before.has(p))
    record('the fixture witness left no spoint server process behind', false, `pid=${child.pid} never exited and had to be signalled; after that, leftover_pids=[${left.join(',')}]. A witness with no shutdown path keeps the port bound forever, so this is the leak class`)
    return { checks, child, before, after: settled, stdout, stderr, arm, standaloneBefore, exit }
  }
  record('the fixture witness left no spoint server process behind', left.length === 0, `leftover_pids=[${left.join(',')}]${left.length ? ' (it exited but its server outlived it)' : ''}`)
  return { checks, child, before, after, stdout, stderr, arm, standaloneBefore, exit }
}

async function parent() {
  const arm = flag('arm', 'clean')
  const staticArm = flag('arm', 'clean') === 'leak' ? [] : bootWithoutStop()
  const r = await run()
  for (const o of staticArm) r.checks.push({ label: `tracked witness ${o.file} owns a shutdown path for its ${o.boots} spoint server boot site(s)`, ok: false, detail: 'boots a spoint server and neither registers it on scripts/lib/witness-server.mjs nor stops it' })
  const failed = r.checks.filter(c => !c.ok)
  for (const c of r.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.label}${c.detail ? ` :: ${c.detail}` : ''}`)
  console.log(`MEASURED server-leak: arm=${arm} checks=${r.checks.length} failed=${failed.length} boot_without_stop=${staticArm.length} standalone_spoint_servers_live=${r.standaloneBefore}`)
  console.log(`RESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'}`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

if (argv.includes('--serve')) await serve()
else await parent()
