import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acquire } from './lib/browser-lease.mjs'

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
const launcherSrc = "const {spawn}=require('child_process');const c=spawn('sleep',['600'],{detached:true,stdio:'ignore'});c.unref();process.stdout.write(c.pid+'\\n');setTimeout(()=>process.exit(0),4000)"

const run = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-orphan-'))
  process.env.SPOINT_BROWSER_LEASE_DIR = path.join(dir, 'lease')
  let orphan = null
  let launcher = null
  try {
    const lease = await acquire({ root: dir, owner: 'lease-orphan-witness', waitMs: 10000 })
    launcher = spawn(process.execPath, ['-e', launcherSrc], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] })
    orphan = await new Promise((resolve) => launcher.stdout.once('data', (d) => resolve(Number(String(d).trim()))))
    lease.record({ browserPid: launcher.pid })
    await sleep(300)
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'lease', 'owner.json'), 'utf8'))
    check(rec.browserTree.some((e) => e.pid === orphan), 'orphan ' + orphan + ' is recorded in browserTree while launcher ' + launcher.pid + ' is alive')
    await new Promise((resolve) => launcher.once('exit', resolve))
    const f = fields(orphan)
    check(f !== null && Number(f[1]) !== launcher.pid, 'orphan is reparented after its launcher exits (ppid ' + (f ? f[1] : 'gone') + ')')
    check(f !== null && Number(f[2]) !== launcher.pid, 'orphan leads its own process group (pgid ' + (f ? f[2] : 'gone') + '), outside the launcher group')
    lease.release()
    const t0 = Date.now()
    while (!dead(orphan) && Date.now() - t0 < 3000) await sleep(50)
    check(dead(orphan), 'orphan is stopped by its recorded pid at release (state ' + state(orphan) + ')')
  } catch (err) {
    check(false, 'run failed: ' + (err && err.message ? err.message : String(err)))
  } finally {
    if (orphan !== null && !dead(orphan)) process.kill(orphan, 'SIGKILL')
    if (launcher !== null && launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL')
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

if (process.platform !== 'linux') {
  console.log('RESULT: FAIL orphan witness reads /proc, so it runs on Linux only')
  process.exit(1)
}
await run()
console.log(failures.length === 0
  ? 'RESULT: PASS orphan stopped by recorded pid: launcher exited, its detached child was recorded and stopped at release'
  : 'RESULT: FAIL orphan stopped by recorded pid: ' + failures.length + ' check(s) failed')
process.exit(failures.length === 0 ? 0 : 1)
