import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launch } from './lib/cdp-browser.mjs'

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const failures = []
const check = (ok, text) => {
  console.log((ok ? 'check: ok ' : 'check: FAIL ') + text)
  if (!ok) failures.push(text)
}
const alive = (pid) => {
  if (process.platform === 'linux') {
    try {
      return !/\) Z /.test(fs.readFileSync('/proc/' + pid + '/stat', 'utf8'))
    } catch {
      return false
    }
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const liveGroup = (pgid) => {
  if (process.platform !== 'linux') return []
  const out = []
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const f = fs.readFileSync('/proc/' + name + '/stat', 'utf8')
      const parts = f.slice(f.lastIndexOf(')') + 2).split(' ')
      if (parts[0] !== 'Z' && Number(parts[2]) === pgid) out.push(Number(name))
    } catch {}
  }
  return out
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-chromium-'))
process.env.SPOINT_BROWSER_LEASE_DIR = path.join(dir, 'lease')
let browser = null
try {
  browser = await launch({ owner: 'lease-chromium-witness' })
  await sleep(3000)
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'lease', 'owner.json'), 'utf8'))
  const pids = rec.browserTree.map((e) => e.pid)
  check(rec.browserPgid === rec.browserPid, 'browserPgid ' + rec.browserPgid + ' is the browser pid ' + rec.browserPid + ', recorded at spawn')
  check(typeof rec.browserStart === 'string' && rec.browserStart.length > 0, 'browserStart recorded at spawn for the browser leader')
  check(pids.length >= 2, 'browser tree recorded ' + pids.length + ' process(es) under browser pid ' + rec.browserPid)
  if (process.platform === 'linux') {
    const groupNow = liveGroup(rec.browserPid)
    const unrecorded = groupNow.filter((p) => !pids.includes(p))
    check(groupNow.length >= 2 && unrecorded.length === 0, 'every live member of browser group ' + rec.browserPid + ' (' + groupNow.length + ') is recorded before close; unrecorded: ' + (unrecorded.join(',') || 'none'))
  }
  await browser.close()
  browser = null
  const t0 = Date.now()
  while (pids.some(alive) && Date.now() - t0 < 5000) await sleep(100)
  const left = pids.filter(alive)
  check(left.length === 0, 'after close no recorded process is alive' + (left.length ? ' (left: ' + left.join(',') + ')' : ''))
} catch (err) {
  check(false, 'launch or close failed: ' + (err && err.message ? err.message : String(err)))
} finally {
  if (browser) await browser.close().catch(() => {})
  fs.rmSync(dir, { recursive: true, force: true })
}
console.log(failures.length === 0
  ? 'RESULT: PASS headful chromium lease: recorded browser processes alive before close and stopped after close'
  : 'RESULT: FAIL headful chromium lease: ' + failures.length + ' check(s) failed')
process.exit(failures.length === 0 ? 0 : 1)
