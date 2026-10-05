import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const [name, dir] = process.argv.slice(2)
if (!name || !dir) { console.error('usage: node scripts/tsl-parity/grab.mjs <name> <dir>'); process.exit(2) }

const readText = f => { const t = fs.readFileSync(f, 'utf8'); return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t }
const outDir = path.resolve('.gm/exec-spool/out')
const files = fs.readdirSync(outDir)
  .filter(f => f.startsWith('cdp') && f.endsWith('.json'))
  .map(f => ({ f, t: fs.statSync(path.join(outDir, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)
if (!files.length) { console.error('no cdp out-file in ' + outDir); process.exit(2) }

const src = path.join(outDir, files[0].f)
const j = JSON.parse(readText(src))
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(j))

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..')
const headFile = path.join(dir, 'head.json')
let headNow = null
try { headNow = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim() } catch { headNow = null }
if (headNow) {
  const prev = fs.existsSync(headFile) ? JSON.parse(readText(headFile)) : { heads: [], artifacts: [] }
  fs.writeFileSync(headFile, JSON.stringify({ heads: [...new Set([].concat(prev.heads || [], headNow))], artifacts: [...new Set([].concat(prev.artifacts || [], name))], lastAt: new Date().toISOString() }, null, 1))
}

const d = j.data || j
const r = d.result !== undefined ? d.result : d
const results = Array.isArray(r) ? r : (r.results || [])
const lines = []
let maxBlocked = 0
for (const item of results) {
  if (item && item.result && typeof item.result.value === 'string') {
    try {
      const v = JSON.parse(item.result.value)
      if (v) { lines.push(JSON.stringify(v).slice(0, 600)); if (Number(v.blocked) > maxBlocked) maxBlocked = Number(v.blocked) }
    } catch { lines.push('RAW ' + item.result.value.slice(0, 200)) }
  } else if (item && item.data) lines.push('[png ' + String(item.data).length + ' b64 chars]')
  else if (item && item.error) lines.push('ERR ' + JSON.stringify(item.error).slice(0, 250))
}
console.log('saved ' + name + ' <- ' + files[0].f + '  ok=' + (j.ok !== false) + '  items=' + results.length + '  bytes=' + fs.statSync(src).size + (headNow ? '  head=' + headNow.slice(0, 8) : ''))
if (d.error) console.log('DISPATCH_ERROR ' + JSON.stringify(d.error).slice(0, 400))
if (maxBlocked > 0) console.log('ABORT: blockedInput=' + maxBlocked + ' in ' + name + ' -- re-navigate and re-boot, do not capture through contaminated input')
console.log('---')
console.log(lines.join('\n'))
