import { spawn, spawnSync } from 'node:child_process'
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

const pidMax = () => Number(fs.readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim())
const pidSample = () => spawnSync('true', [], { stdio: 'ignore' }).pid

const measurePidRate = async () => {
  const max = pidMax()
  const windows = []
  for (let i = 0; i < 2; i += 1) {
    const p0 = pidSample()
    const t0 = Date.now()
    await sleep(2000)
    const p1 = pidSample()
    const seconds = (Date.now() - t0) / 1000
    const delta = (p1 - p0 + max) % max
    windows.push({ delta, seconds, perSecond: delta / seconds })
  }
  const perSecond = windows.reduce((sum, w) => sum + w.perSecond, 0) / windows.length
  return { max, windows, perSecond, wrapHours: max / perSecond / 3600 }
}

const JOIN_LAUNCH = [
  '$|=1;',
  'my $x=fork; if(!$x){ my $lead=getppid(); select(undef,undef,undef,1.0); my $j=fork; if(!$j){ setpgrp(0,0); setpgrp(0,$lead); print "$$\\n"; exec "sleep","602" } sleep 600; }',
  'select(undef,undef,undef,0.5); exit 0;',
].join(' ')

const joinerScenario = async (root) => {
  const dir = path.join(root, 'joiner')
  process.env.SPOINT_BROWSER_LEASE_DIR = path.join(dir, 'lease')
  const spec = leasedSpawnArgv('perl', ['-e', JOIN_LAUNCH])
  const lease = await acquire({ root: dir, owner: 'lease-leader-exit-joiner', waitMs: 10000 })
  let launcher = null
  let joiner = null
  let member = null
  try {
    launcher = spawn(spec.command, spec.args, { detached: true, stdio: ['ignore', 'pipe', 'inherit'] })
    const start = startOf(launcher.pid)
    const pid = await new Promise((resolve, reject) => {
      let buf = ''
      const timer = setTimeout(() => reject(new Error('joiner did not report its pid')), 8000)
      launcher.stdout.on('data', (d) => {
        const lines = (buf + String(d)).split('\n')
        buf = lines.pop()
        for (const line of lines) if (/^\d+$/.test(line.trim())) { clearTimeout(timer); resolve(Number(line)) }
      })
    })
    joiner = pid
    const exitedFirst = await new Promise((resolve) => {
      const t0 = Date.now()
      const poll = () => {
        if (dead(launcher.pid)) return resolve(true)
        if (Date.now() - t0 > 4000) return resolve(false)
        setTimeout(poll, 50)
      }
      poll()
    })
    check(exitedFirst, 'leader ' + launcher.pid + ' has exited before the joiner is scanned (state ' + state(launcher.pid) + ')')
    const joinedGroup = fields(joiner) ? Number(fields(joiner)[2]) : -1
    check(joinedGroup === launcher.pid, 'joiner ' + joiner + ' sits in the group of the exited leader ' + launcher.pid + ' (pgid ' + joinedGroup + ')')
    lease.record({ browserPid: launcher.pid, browserPgid: launcher.pid, browserStart: start })
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'lease', 'owner.json'), 'utf8'))
    const admitted = rec.browserTree.some((e) => e.pid === joiner)
    console.log('measure: joiner ' + joiner + ' recorded after its leader exited: ' + admitted)
    check(admitted, 'joiner ' + joiner + ' is recorded by group admission once its leader has exited (the limit)')
    lease.release()
    const t0 = Date.now()
    while (!dead(joiner) && Date.now() - t0 < 3000) await sleep(50)
    console.log('measure: joiner ' + joiner + ' stopped at release: ' + dead(joiner) + ' (state ' + state(joiner) + ')')
    check(dead(joiner), 'joiner ' + joiner + ' is stopped at release (the same record that admitted it)')
  } finally {
    for (const pid of [joiner, member]) if (pid !== null && !dead(pid)) { try { process.kill(pid, 'SIGKILL') } catch {} }
    if (launcher !== null && launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL')
    try { lease.release() } catch {}
  }
}

if (process.platform !== 'linux') {
  console.log('RESULT: FAIL leader-exit witness reads /proc and pid_max, so it runs on Linux only')
  process.exit(1)
}
const rate = await measurePidRate()
console.log('measure: pid_max ' + rate.max + ', pid allocation ' + rate.windows.map((w) => w.delta + ' in ' + w.seconds.toFixed(2) + ' s').join(', ') + ', mean ' + rate.perSecond.toFixed(1) + ' per second')
console.log('measure: the pid counter wraps back to a given number after about ' + rate.wrapHours.toFixed(2) + ' h at this rate')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-leader-exit-'))
try {
  await joinerScenario(root)
} catch (err) {
  check(false, 'run failed: ' + (err && err.message ? err.message : String(err)))
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
console.log(failures.length === 0
  ? 'RESULT: PASS leader-exit limit: a process that joins the group after its leader exited is recorded and stopped at release; a re-formed group needs the pid counter to wrap (pid_max ' + rate.max + ', about ' + rate.wrapHours.toFixed(2) + ' h at ' + rate.perSecond.toFixed(1) + ' pids per second)'
  : 'RESULT: FAIL leader-exit limit: ' + failures.length + ' check(s) failed')
process.exit(failures.length === 0 ? 0 : 1)
