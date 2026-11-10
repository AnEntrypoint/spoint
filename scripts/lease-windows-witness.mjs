import { spawn } from 'node:child_process'
import { killOwnedBrowser, psProcessTable, startOf } from './lib/browser-lease.mjs'

if (process.platform !== 'win32') {
  console.log(`RESULT: BLOCKED windows lease witness: this host is ${process.platform}, not win32. Run it on a Windows host from the repo root with: node scripts/lease-windows-witness.mjs`)
  process.exit(2)
}

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
  if (!ok) failures.push(name)
}
const rowOf = (table, pid) => (table ? table.find((row) => row.pid === pid) : undefined)
const once = (stream, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no output within ${ms} ms`)), ms)
  stream.once('data', (buf) => { clearTimeout(timer); resolve(String(buf)) })
})
const HOLD = 'setInterval(() => {}, 1000)'
const treeSource = `const { spawn } = require('node:child_process'); const g = spawn(process.execPath, ['-e', ${JSON.stringify(HOLD)}], { stdio: 'ignore', windowsHide: true }); console.log(g.pid); ${HOLD}`

const table = psProcessTable()
check('the process table reads on win32 and lists this process', Boolean(rowOf(table, process.pid)), table ? `rows ${table.length}` : 'psProcessTable returned null')

const parent = spawn(process.execPath, ['-e', treeSource], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
const grandchildPid = Number((await once(parent.stdout, 10000)).trim())
const parentStart = startOf(parent.pid)
const beforeKill = psProcessTable()
check('the spawned parent and its grandchild are both in the table before the kill', Boolean(rowOf(beforeKill, parent.pid)) && Boolean(rowOf(beforeKill, grandchildPid)), `parent ${parent.pid} grandchild ${grandchildPid}`)
check('the grandchild is a child of the parent', rowOf(beforeKill, grandchildPid)?.ppid === parent.pid, `ppid ${rowOf(beforeKill, grandchildPid)?.ppid}`)

const decoy = spawn(process.execPath, ['-e', HOLD], { stdio: 'ignore', windowsHide: true })
killOwnedBrowser({ browserPid: decoy.pid, browserStart: 'not-the-start-time' })
check('a recorded start time that does not match leaves the process running', Boolean(rowOf(psProcessTable(), decoy.pid)))

killOwnedBrowser({ browserPid: parent.pid, browserStart: parentStart })
const afterKill = psProcessTable()
check('killOwnedBrowser with the recorded start stops the parent through taskkill /T /F', Boolean(afterKill) && !rowOf(afterKill, parent.pid), `parent ${parent.pid}`)
check('killOwnedBrowser stops the grandchild in the same tree', Boolean(afterKill) && !rowOf(afterKill, grandchildPid), `grandchild ${grandchildPid}`)

decoy.kill()
parent.kill()

if (failures.length) {
  console.log(`RESULT: FAIL ${failures.length} check(s): ${failures.join('; ')}`)
  process.exit(1)
}
console.log(`RESULT: PASS windows lease: taskkill /T /F stopped the recorded parent (${parent.pid}) and its grandchild (${grandchildPid}); a mismatched start left its decoy (${decoy.pid}) running`)
process.exit(0)
