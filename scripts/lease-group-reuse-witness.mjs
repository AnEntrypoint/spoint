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
const alive = (pid) => state(pid) !== 'gone' && state(pid) !== 'Z'
const unrelatedSrc = "const {spawn}=require('child_process');const c=spawn('sleep',['600'],{stdio:'ignore'});process.stdout.write(c.pid+'\\n');setTimeout(()=>process.exit(0),120000)"

const run = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-group-reuse-'))
  process.env.SPOINT_BROWSER_LEASE_DIR = path.join(dir, 'lease')
  let leader = null
  let member = null
  try {
    const lease = await acquire({ root: dir, owner: 'lease-group-reuse-witness', waitMs: 10000 })
    leader = spawn(process.execPath, ['-e', unrelatedSrc], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] })
    member = await new Promise((resolve) => leader.stdout.once('data', (d) => resolve(Number(String(d).trim()))))
    await sleep(200)
    const f = fields(leader.pid)
    check(f !== null && Number(f[2]) === leader.pid, 'unrelated leader ' + leader.pid + ' leads group ' + leader.pid + ' with member ' + member)
    const realStart = f[19]
    const staleStart = String(Number(realStart) - 1000)
    lease.record({ browserPid: leader.pid, browserPgid: leader.pid, browserStart: staleStart })
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'lease', 'owner.json'), 'utf8'))
    const recorded = rec.browserTree.map((e) => e.pid)
    check(!recorded.includes(leader.pid) && !recorded.includes(member), 'nothing from group ' + leader.pid + ' is recorded: leader start ' + realStart + ' differs from the recorded ' + staleStart)
    lease.release()
    await sleep(500)
    check(alive(leader.pid) && alive(member), 'nothing is killed at release: leader ' + state(leader.pid) + ', member ' + state(member))
  } catch (err) {
    check(false, 'run failed: ' + (err && err.message ? err.message : String(err)))
  } finally {
    for (const pid of [member, leader ? leader.pid : null]) {
      if (pid !== null && alive(pid)) process.kill(pid, 'SIGKILL')
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

if (process.platform !== 'linux') {
  console.log('RESULT: FAIL group reuse witness reads /proc, so it runs on Linux only')
  process.exit(1)
}
await run()
console.log(failures.length === 0
  ? 'RESULT: PASS group reuse: a group number whose leader start differs from the recorded start is neither recorded nor killed'
  : 'RESULT: FAIL group reuse: ' + failures.length + ' check(s) failed')
process.exit(failures.length === 0 ? 0 : 1)
