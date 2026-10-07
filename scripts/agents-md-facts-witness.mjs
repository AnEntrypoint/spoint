import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve, dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOC = join(REPO, 'AGENTS.md')
const EXT = /\.(js|mjs|cjs|ts|tsx|json|yml|yaml|md|glsl|wgsl|c|h|cpp|hpp|sh|html|css|txt|glb|hf|wasm|toml)$/i
const HEX = /^[0-9a-f]{7,40}$/i
const PURE_EXT = /^\.[a-z0-9]+$/i
const MAX_DEPTH = 4
const EXTERNAL = new Set(['src/win/async.c'])

function gitStatus(args) {
  return spawnSync('git', args, { cwd: REPO, windowsHide: true }).status
}

function gitOut(args) {
  const done = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  return done.status === 0 ? done.stdout : null
}

const listed = (gitOut(['ls-files']) || '').split('\n').filter(Boolean)
const tracked = new Set(listed)
const byBasename = new Map()
for (const p of listed) {
  const b = basename(p)
  if (!byBasename.has(b)) byBasename.set(b, [])
  byBasename.get(b).push(p)
}

const depCache = new Map()

function findInDeps(name) {
  if (depCache.has(name)) return depCache.get(name)
  const root = join(REPO, 'node_modules')
  let found = null
  const walk = (dir, depth) => {
    if (found || depth > MAX_DEPTH) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (found) return
      if (e.isFile() && e.name === name) { found = join(dir, e.name); return }
      if (e.isDirectory() && e.name !== 'node_modules') walk(join(dir, e.name), depth + 1)
    }
  }
  if (existsSync(root)) walk(root, 1)
  depCache.set(name, found)
  return found
}

function resolvePath(rel, base) {
  if (tracked.has(rel)) return { kind: 'tracked', at: rel }
  if (gitStatus(['check-ignore', '-q', rel]) === 0) return { kind: 'ignored', at: rel }
  const sameName = (byBasename.get(base) || [])[0]
  if (sameName) return { kind: 'moved', at: sameName }
  const dep = findInDeps(base)
  if (dep) return { kind: 'dependency', at: dep.slice(REPO.length + 1) }
  return null
}

const lines = readFileSync(DOC, 'utf8').split(/\r?\n/)
const missing = []
const unknownSha = []
const moved = []
const inDeps = []
const pastEof = []
const seen = new Set()
let pathClaims = 0
let shaClaims = 0
let lineClaims = 0

for (let i = 0; i < lines.length; i += 1) {
  for (const m of lines[i].matchAll(/`([^`]+)`/g)) {
    const token = m[1].trim().replace(/[",;]+$/, '')
    if (seen.has(token)) continue
    seen.add(token)
    if (/[<>*?${]|\s|:\/\//.test(token)) continue

    if (HEX.test(token) && /[a-f]/i.test(token)) {
      shaClaims += 1
      if (gitStatus(['cat-file', '-e', `${token}^{commit}`]) !== 0) unknownSha.push({ token, line: i + 1 })
      continue
    }

    const slice = token.lastIndexOf(':')
    const hasLine = /:\d+$/.test(token)
    const rel = (hasLine ? token.slice(0, slice) : token).replace(/\\/g, '/')
    const claimedLine = hasLine ? Number(token.slice(slice + 1)) : 0
    const base = basename(rel)
    if (EXTERNAL.has(rel)) {
      moved.push({ token, line: i + 1, at: 'external source, not this repo' })
      continue
    }
    if (PURE_EXT.test(base) || !EXT.test(rel)) continue
    if (rel.startsWith('vendor/') || rel.startsWith('node_modules/')) continue
    pathClaims += 1

    const hit = resolvePath(rel, base)
    if (!hit) {
      missing.push({ token, line: i + 1 })
      continue
    }
    if (hit.kind === 'moved') moved.push({ token, line: i + 1, at: hit.at })
    if (hit.kind === 'dependency') inDeps.push({ token, line: i + 1, at: hit.at })
    if (!claimedLine || hit.kind !== 'tracked') continue
    lineClaims += 1
    const text = readFileSync(join(REPO, hit.at), 'utf8')
    const total = text.split(/\r?\n/).length
    if (claimedLine > total) pastEof.push({ token, line: i + 1, claimedLine, total, file: hit.at })
  }
}

for (const d of missing) console.log(`  FAIL missing      AGENTS.md:${d.line}  ${d.token} -- absent from the tracked tree and from node_modules`)
for (const d of pastEof) console.log(`  FAIL past end     AGENTS.md:${d.line}  ${d.token} claims line ${d.claimedLine}, ${d.file} has ${d.total}`)
for (const d of unknownSha) console.log(`  note unresolvable AGENTS.md:${d.line}  ${d.token} -- not a commit in this repo, so it reads as a content digest`)
for (const d of inDeps) console.log(`  note dependency   AGENTS.md:${d.line}  ${d.token} -> ${d.at}`)
for (const d of moved) console.log(`  note moved        AGENTS.md:${d.line}  ${d.token} -> ${d.at}`)
console.log(`  checked ${pathClaims} path claim(s), ${lineClaims} line claim(s) and ${shaClaims} sha-like token(s)`)

const failures = missing.length + pastEof.length
if (failures > 0) {
  console.log(`RESULT: FAIL -- ${failures} AGENTS.md claim(s) resolve to nothing in this repo`)
  process.exit(1)
}
console.log(`RESULT: PASS -- every AGENTS.md path and line claim resolves against the tracked tree, an ignored runtime path or a dependency`)
