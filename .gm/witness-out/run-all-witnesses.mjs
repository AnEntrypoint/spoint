import { readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const files = readdirSync('scripts').filter(name => /-witness\.mjs$/.test(name)).sort()
const failed = []
let passed = 0
for (const file of files) {
  try {
    const out = execFileSync(process.execPath, ['scripts/' + file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 })
    if (!out.includes('RESULT: PASS')) failed.push({ file, reason: 'no RESULT: PASS', tail: out.trim().slice(-200) })
    else passed++
  } catch (err) {
    failed.push({ file, reason: 'exit ' + err.status, tail: String(err.stdout ?? err.stderr ?? err.message).trim().slice(-300) })
  }
}
console.log(JSON.stringify({ total: files.length, passed, failed }, null, 2))
process.exit(failed.length ? 1 : 0)
