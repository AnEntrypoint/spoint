import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
  const [k, ...v] = a.slice(2).split('=')
  return [k, v.join('=')]
}))

if (args.parse !== '0' && !process.execArgv.includes('--experimental-vm-modules')) {
  const relaunched = spawnSync(process.execPath, ['--experimental-vm-modules', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' })
  process.exit(relaunched.status == null ? 1 : relaunched.status)
}

const dir = path.resolve(args.dir || '')
const base = (args.base || 'http://localhost:3100').replace(/\/+$/, '')
const repo = path.resolve(args.repo || process.cwd())
const snapshotPath = path.join(dir, 'snapshot.json')
if (!fs.existsSync(snapshotPath)) {
  console.error('no snapshot.json in ' + dir + ' -- run scripts/pinned-snapshot.mjs first')
  process.exit(2)
}
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
const files = (args.files ? args.files.split(',') : snapshot.auditFiles).filter(Boolean)

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')
const normalize = buf => Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')

function urlFor(rel) {
  const pinned = ['packages/mapspinner', 'packages/streaming-gltf']
  for (const p of pinned) {
    if (rel.startsWith(p + '/')) return '/node_modules/' + p.slice('packages/'.length) + '/' + rel.slice(p.length + 1)
  }
  if (rel.startsWith('client/')) return '/' + rel.slice('client'.length + 1)
  return '/' + rel
}

const rows = []
let failedRequests = 0
for (const rel of files) {
  const url = base + urlFor(rel)
  let res
  try {
    res = await fetch(url)
  } catch (e) {
    failedRequests++
    rows.push({ file: rel, url, error: String(e.message || e) })
    continue
  }
  const served = Buffer.from(await res.arrayBuffer())
  const snapshotFile = path.join(dir, rel)
  const liveFile = path.join(repo, rel)
  const snapHash = fs.existsSync(snapshotFile) ? sha256(normalize(fs.readFileSync(snapshotFile))) : null
  const liveHash = fs.existsSync(liveFile) ? sha256(normalize(fs.readFileSync(liveFile))) : null
  const servedHash = sha256(normalize(served))
  let parse = null
  if (rel.endsWith('.js')) {
    const { SourceTextModule } = await import('node:vm')
    try {
      new SourceTextModule(served.toString('utf8'), { identifier: rel })
      parse = { parsed: true }
    } catch (e) {
      parse = { parsed: false, error: String(e && e.message || e).slice(0, 200) }
    }
  }
  rows.push({
    file: rel,
    url,
    status: res.status,
    bytes: served.length,
    served: servedHash,
    snapshot: snapHash,
    live: liveHash,
    parse,
    servedMatchesSnapshot: snapHash != null && snapHash === servedHash,
    servedDiffersFromLiveTree: liveHash != null && liveHash !== servedHash
  })
}

const indexRes = await fetch(base + '/')
const indexHtml = await indexRes.text()
const headerProbe = {
  coop: indexRes.headers.get('cross-origin-opener-policy'),
  coep: indexRes.headers.get('cross-origin-embedder-policy'),
  contentType: indexRes.headers.get('content-type')
}

const out = {
  base,
  sha: snapshot.sha,
  dir,
  checked: rows.length,
  failedRequests,
  servedMatchesSnapshot: rows.every(r => r.servedMatchesSnapshot),
  mismatched: rows.filter(r => !r.servedMatchesSnapshot).map(r => r.file),
  servedFromLiveTree: rows.filter(r => r.servedDiffersFromLiveTree === false).map(r => r.file),
  parsed: rows.filter(r => r.parse).length,
  unparsed: rows.filter(r => r.parse && !r.parse.parsed).map(r => ({ file: r.file, error: r.parse.error })),
  headerProbe,
  importMapMentionsPinnedMapspinner: indexHtml.includes('/node_modules/mapspinner/'),
  rows
}
console.log(JSON.stringify(out, null, 1))
process.exit(out.servedMatchesSnapshot && failedRequests === 0 ? 0 : 1)
