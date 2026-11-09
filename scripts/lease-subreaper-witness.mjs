import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acquire, leasedSpawnArgv, startOf } from './lib/browser-lease.mjs'

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const failures = []
const check = (ok, text) => {
  console.log((ok ? 'check: ok ' : 'check: FAIL ') + text)
  if (!ok) failures.push(text)
}
const fields = (pid) => {
  try {
    const s = fs.readFileSync('/proc/' + pid + '/stat', 'utf8')
    return s.slice(s.lastIndexOf(')') + 2).split(' ')
  } catch {
    return null
  }
}
const state = (pid) => (fields(pid) ? fields(pid)[0] : 'gone')
const dead = (pid) => state(pid) === 'gone' || state(pid) === 'Z'
const LAUNCH = [
  '$|=1;',
  'my $a=fork; if(!$a){ my $b=fork; if(!$b){ setsid(); print "$$\\n"; exec "sleep","600" } select(undef,undef,undef,0.5); exit 0 }',
  'my $c=fork; if(!$c){ my $d=fork; if(!$d){ setpgrp(0,0); print "$$\\n"; exec "sleep","601" } select(undef,undef,undef,0.5); exit 0 }',
  'waitpid($a,0); waitpid($c,0); sleep 120;',
].join(' ')

const readPids = (child, count) => new Promise((resolve, reject) => {
  const found = []
  let buf = ''
  const timer = setTimeout(() => reject(new Error('launcher printed ' + found.length + ' of ' + count + ' pids')), 6000)
  child.stdout.on('data', (d) => {
    const lines = (buf + String(d)).split('\n')
    buf = lines.pop()
    for (const line of lines) if (/^\d+$/.test(line.trim())) found.push(Number(line))
    if (found.length >= count) {
      clearTimeout(timer)
      resolve(found.slice(0, count))
    }
  })
  child.on('error', (err) => { clearTimeout(timer); reject(err) })
})

const scenario = async (root, name, wrapped) => {
  const dir = path.join(root, name)
  process.env.SPOINT_BROWSER_LEASE_DIR = path.join(dir, 'lease')
  const spec = wrapped ? leasedSpawnArgv('perl', ['-e', LAUNCH]) : { command: 'perl', args: ['-e', LAUNCH] }
  const lease = await acquire({ root: dir, owner: 'lease-subreaper-' + name, waitMs: 10000 })
  const started = []
  let launcher = null
  try {
    launcher = spawn(spec.command, spec.args, { detached: true, stdio: ['ignore', 'pipe', 'inherit'] })
    const pids = await readPids(launcher, 2)
    started.push(...pids)
    const start = startOf(launcher.pid)
    await sleep(900)
    lease.record({ browserPid: launcher.pid, browserPgid: launcher.pid, browserStart: start })
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'lease', 'owner.json'), 'utf8'))
    const inTree = (pid) => rec.browserTree.some((e) => e.pid === pid)
    const labels = ['setsid', 'setpgid']
    pids.forEach((pid, i) => {
      const parent = fields(pid) ? Number(fields(pid)[1]) : -1
      if (wrapped) {
        check(inTree(pid) && parent === launcher.pid, name + ': ' + labels[i] + ' orphan ' + pid + ' is recorded through the subreaper (ppid ' + parent + ', launcher ' + launcher.pid + ')')
      } else {
        check(!inTree(pid) && parent !== launcher.pid, name + ': ' + labels[i] + ' orphan ' + pid + ' is not recorded without a subreaper (ppid ' + parent + ')')
      }
    })
    lease.release()
    if (wrapped) {
      for (const pid of pids) {
        const t0 = Date.now()
        while (!dead(pid) && Date.now() - t0 < 3000) await sleep(50)
        check(dead(pid), name + ': orphan ' + pid + ' is stopped at release (state ' + state(pid) + ')')
      }
    }
  } finally {
    for (const pid of started) if (!dead(pid)) { try { process.kill(pid, 'SIGKILL') } catch {} }
    if (launcher !== null && launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL')
    try { lease.release() } catch {}
  }
}

if (process.platform !== 'linux') {
  console.log('RESULT: FAIL subreaper witness reads /proc, so it runs on Linux only')
  process.exit(1)
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-subreaper-'))
try {
  await scenario(root, 'wrapped', true)
  await scenario(root, 'plain', false)
} catch (err) {
  check(false, 'run failed: ' + (err && err.message ? err.message : String(err)))
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
console.log(failures.length === 0
  ? 'RESULT: PASS subreaper: setsid and setpgid orphans are recorded and stopped at release under the perl subreaper, and missed without it'
  : 'RESULT: FAIL subreaper: ' + failures.length + ' check(s) failed')
process.exit(failures.length === 0 ? 0 : 1)
