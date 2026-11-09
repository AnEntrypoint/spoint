import { spawn } from 'node:child_process'
import { browserTreeNow, psProcessTable } from './lib/browser-lease.mjs'

const CHILDREN = 9
const SCANS = 200
const PS_READS = 50
const failures = []
const check = (ok, text) => {
  console.log((ok ? 'check: ok ' : 'check: FAIL ') + text)
  if (!ok) failures.push(text)
}
const pct = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
const summary = (times) => {
  const s = times.slice().sort((a, b) => a - b)
  return 'p50 ' + pct(s, 0.5).toFixed(3) + ' ms, p95 ' + pct(s, 0.95).toFixed(3) + ' ms over ' + s.length + ' reads'
}
const rootSrc = "const {spawn}=require('child_process');const kids=[];for(let i=0;i<" + CHILDREN + ";i++){const c=spawn('sleep',['600'],{detached:true,stdio:'ignore'});c.unref();kids.push(c.pid)}process.stdout.write(JSON.stringify(kids)+'\\n');setTimeout(()=>process.exit(0),60000)"

const root = spawn(process.execPath, ['-e', rootSrc], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] })
let kids = []
try {
  kids = await new Promise((resolve, reject) => {
    root.stdout.once('data', (d) => {
      try {
        resolve(JSON.parse(String(d)))
      } catch (err) {
        reject(err)
      }
    })
    root.once('exit', () => reject(new Error('root exited before reporting its children')))
  })
  const expected = [root.pid, ...kids]
  const recorded = browserTreeNow(root.pid).map((e) => e.pid)
  check(expected.every((p) => recorded.includes(p)) && recorded.length === expected.length, 'tree scan finds the root and its ' + CHILDREN + ' children (found ' + recorded.length + ' of ' + expected.length + ')')
  const scan = []
  for (let i = 0; i < SCANS; i++) {
    const t = performance.now()
    browserTreeNow(root.pid)
    scan.push(performance.now() - t)
  }
  const read = []
  for (let i = 0; i < PS_READS; i++) {
    const t = performance.now()
    psProcessTable()
    read.push(performance.now() - t)
  }
  console.log('browserTreeNow (/proc walk): ' + summary(scan))
  console.log('psProcessTable (ps -Ao pid=,ppid=,lstart=): ' + summary(read))
} catch (err) {
  check(false, 'measurement failed: ' + (err && err.message ? err.message : String(err)))
} finally {
  for (const pid of [root.pid, ...kids]) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
}
console.log(failures.length === 0
  ? 'RESULT: PASS lease scan cost measured on a tree of ' + (CHILDREN + 1) + ' processes'
  : 'RESULT: FAIL lease scan cost: ' + failures.length + ' check(s) failed')
process.exit(failures.length === 0 ? 0 : 1)
