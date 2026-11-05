import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOC = join(ROOT, 'AGENTS.md')
const KNOWN_EXT = /\.(?:js|mjs|cjs|json|md|ts|tsx|glsl|wgsl|yml|yaml|txt|html|css|sh)$/
const PATH_CHARS = /^[A-Za-z0-9_.@+\/-]+$/
const URL_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//
const SKIP_PREFIXES = ['node_modules/', 'dist/', 'vendor/']
const PRUNED_DIRS = new Set(['node_modules', '.git', 'dist', 'vendor'])
const SEPARATOR = /^[\s(),;:+=&|/·→>\-~]*$/
const SYMBOL = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/
const COMBINED = /^(\S+\.(?:js|mjs|cjs|json|md|ts|tsx|glsl|wgsl|yml|yaml|txt|html|css|sh))\s+([A-Za-z_$][A-Za-z0-9_$.]*)$/

function git(args) {
  return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
}

const tracked = new Set((git(['ls-files']).stdout || '').split('\n').filter(Boolean))
const ignored = new Map()
function isIgnored(rel) {
  if (ignored.has(rel)) return ignored.get(rel)
  const answer = git(['check-ignore', '-q', rel]).status === 0
  ignored.set(rel, answer)
  return answer
}

const worktreeFiles = []
function collect(dir, rel) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (PRUNED_DIRS.has(entry.name)) continue
    const child = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) collect(join(dir, entry.name), child)
    else if (entry.isFile()) worktreeFiles.push(child)
  }
}
collect(ROOT, '')

const byBasename = new Map()
for (const rel of new Set([...tracked, ...worktreeFiles])) {
  const base = basename(rel)
  if (!byBasename.has(base)) byBasename.set(base, [])
  byBasename.get(base).push(rel)
}

function skipPath(rel) {
  return URL_LIKE.test(rel)
    || SKIP_PREFIXES.some(prefix => rel.startsWith(prefix) || rel.startsWith(`/${prefix}`))
    || rel.includes('node_modules/') || rel.includes('dist/') || rel.includes('vendor/')
}

function isPathToken(token) {
  return PATH_CHARS.test(token) && KNOWN_EXT.test(token) && !skipPath(token)
}

function resolvePath(rel) {
  if (!rel.includes('/')) return byBasename.get(rel) || []
  if (existsSync(join(ROOT, rel))) return [rel]
  if (tracked.has(rel)) return [rel]
  if (isIgnored(rel)) return [rel]
  return []
}

const lines = readFileSync(DOC, 'utf8').split(/\r?\n/)
const pathTokens = new Set()
const claims = []
for (const line of lines) {
  const spans = [...line.matchAll(/`([^`]+)`/g)].map(match => ({
    text: match[1].trim(),
    start: match.index,
    end: match.index + match[0].length,
  }))
  for (const span of spans) {
    if (isPathToken(span.text)) pathTokens.add(span.text)
    const combined = span.text.match(COMBINED)
    if (combined && isPathToken(combined[1]) && SYMBOL.test(combined[2])) {
      claims.push({ path: combined[1], symbol: combined[2] })
    }
  }
  for (let i = 0; i + 1 < spans.length; i += 1) {
    if (!SEPARATOR.test(line.slice(spans[i].end, spans[i + 1].start))) continue
    const left = spans[i].text
    const right = spans[i + 1].text
    if (isPathToken(right) && SYMBOL.test(left) && !isPathToken(left)) claims.push({ path: right, symbol: left })
    if (isPathToken(left) && SYMBOL.test(right) && !isPathToken(right)) claims.push({ path: left, symbol: right })
  }
}

assert.ok(pathTokens.size >= 20, `AGENTS.md yielded only ${pathTokens.size} path claim(s)`)
const missing = [...pathTokens].filter(token => resolvePath(token).length === 0).sort()
assert.equal(missing.length, 0, `AGENTS.md cites path(s) absent from the repo: ${missing.join(', ')}`)

assert.ok(claims.length >= 5, `AGENTS.md yielded only ${claims.length} symbol claim(s)`)
const broken = []
for (const { path, symbol } of claims) {
  const files = resolvePath(path).filter(rel => existsSync(join(ROOT, rel)))
  if (!files.length) {
    broken.push(`${symbol} in ${path}: cited file is unreadable`)
    continue
  }
  if (!files.some(rel => readFileSync(join(ROOT, rel), 'utf8').includes(symbol))) {
    broken.push(`${symbol} in ${path}`)
  }
}
assert.equal(broken.length, 0, `AGENTS.md symbol claim(s) absent from the cited file: ${broken.join('; ')}`)

console.log(`RESULT: PASS ${pathTokens.size} path claim(s) exist, ${claims.length} symbol claim(s) appear in their cited file(s)`)
