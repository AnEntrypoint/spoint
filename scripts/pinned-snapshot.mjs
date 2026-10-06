import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'

const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
  const [k, ...v] = a.slice(2).split('=')
  return [k, v.join('=')]
}))

const repo = path.resolve(args.repo || process.cwd())
const sha = execFileSync('git', ['rev-parse', args.sha || 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
const shortSha = sha.slice(0, 12)
const dir = path.resolve(args.out || path.join(repo, '.gm', 'pinned'), shortSha)
const pinnedPackages = (args.pinned || 'mapspinner,streaming-gltf').split(',').filter(Boolean)
const walkGlobs = (args.audit || 'packages/mapspinner/src,client/app.js,src/sdk/StaticHandler.js').split(',').filter(Boolean)

if (!args.force && fs.existsSync(path.join(dir, 'server.js'))) {
  console.log(JSON.stringify({ reused: dir, sha, reason: 'snapshot already extracted' }, null, 1))
  process.exit(0)
}

fs.rmSync(dir, { recursive: true, force: true })
fs.mkdirSync(dir, { recursive: true })

const archived = spawnSync('git', ['archive', '--format=tar', sha], { cwd: repo, maxBuffer: 1 << 30 })
if (archived.status !== 0) {
  console.error('git archive failed: ' + String(archived.stderr).trim())
  process.exit(1)
}
const extracted = spawnSync('tar', ['-xf', '-'], { cwd: dir, input: archived.stdout, maxBuffer: 1 << 30 })
if (extracted.status !== 0) {
  console.error('tar extract failed: ' + String(extracted.stderr).trim())
  process.exit(1)
}

const liveNodeModules = path.join(repo, 'node_modules')
const snapshotNodeModules = path.join(dir, 'node_modules')
fs.mkdirSync(snapshotNodeModules, { recursive: true })
const linked = []
const redirected = []
for (const entry of fs.readdirSync(liveNodeModules, { withFileTypes: true })) {
  if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
  const target = pinnedPackages.includes(entry.name)
    ? path.join(dir, 'packages', entry.name)
    : path.join(liveNodeModules, entry.name)
  if (!fs.existsSync(target)) {
    console.error('node_modules target missing: ' + target)
    process.exit(1)
  }
  fs.symlinkSync(target, path.join(snapshotNodeModules, entry.name), 'junction')
  ;(pinnedPackages.includes(entry.name) ? redirected : linked).push(entry.name)
}

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')
const normalize = buf => Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')

function expand(base) {
  const abs = path.join(dir, base)
  if (!fs.existsSync(abs)) return []
  if (fs.statSync(abs).isFile()) return [base]
  const out = []
  const stack = [base]
  while (stack.length) {
    const rel = stack.pop()
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel + '/' + e.name
      if (e.isDirectory()) stack.push(child)
      else out.push(child)
    }
  }
  return out.sort()
}

const audit = []
for (const glob of walkGlobs) {
  for (const rel of expand(glob)) {
    const snapshotBuf = fs.readFileSync(path.join(dir, rel))
    const gitPath = rel.split(path.sep).join('/')
    let gitSha = null
    try {
      gitSha = sha256(normalize(execFileSync('git', ['show', sha + ':' + gitPath], { cwd: repo, maxBuffer: 1 << 28 })))
    } catch (e) {
      gitSha = null
    }
    const liveFile = path.join(repo, rel)
    audit.push({
      file: gitPath,
      snapshot: sha256(normalize(snapshotBuf)),
      committed: gitSha,
      live: fs.existsSync(liveFile) ? sha256(normalize(fs.readFileSync(liveFile))) : null,
      matchesCommitted: gitSha != null && gitSha === sha256(normalize(snapshotBuf))
    })
  }
}

const staleWorktreeFiles = []
const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).split('\n')
for (const line of porcelain) {
  const rel = line.slice(3).trim().replace(/"/g, '')
  if (!rel) continue
  if (line.startsWith('??') && fs.existsSync(path.join(dir, rel.split(path.sep).join('/')))) staleWorktreeFiles.push(rel)
}

const report = {
  sha,
  dir,
  builtAt: new Date().toISOString(),
  nodeModules: { linked: linked.length, redirected, fromSnapshotPackages: redirected.map(n => path.join(dir, 'packages', n)) },
  audit: {
    files: audit.length,
    mismatchedAgainstCommit: audit.filter(a => !a.matchesCommitted).map(a => a.file),
    differsFromLiveTree: audit.filter(a => a.live !== null && a.live !== a.snapshot).map(a => a.file),
    untrackedLeakedIntoSnapshot: staleWorktreeFiles
  },
  files: Object.fromEntries(audit.map(a => [a.file, { snapshot: a.snapshot, committed: a.committed, live: a.live }])),
  auditFiles: audit.map(a => a.file)
}

fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify(report, null, 1))
console.log(JSON.stringify(report, null, 1))
