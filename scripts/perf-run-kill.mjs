import { readFileSync, existsSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const pidFile = resolve(process.argv[2] || '')
if (!process.argv[2] || !existsSync(pidFile)) {
  console.error('usage: node scripts/perf-run-kill.mjs data/perf-run/<label>.pids.json')
  process.exit(2)
}
const rec = JSON.parse(readFileSync(pidFile, 'utf8'))
const recorded = [rec.chromePid, rec.nodePid].filter((p) => Number.isInteger(p) && p > 0 && p !== process.pid)
for (const pid of recorded) {
  const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' })
  console.log(`taskkill /PID ${pid} /T /F -> ${(r.stdout || r.stderr || '').trim().split('\n')[0]}`)
}
if (rec.profileDir && rec.profileDir.includes('spoint-cdp-') && existsSync(rec.profileDir)) {
  rmSync(rec.profileDir, { recursive: true, force: true })
  console.log('removed ' + rec.profileDir)
}
