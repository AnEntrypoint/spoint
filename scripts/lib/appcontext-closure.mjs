import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { posix } from 'node:path'

export const SOURCE_REL = 'src/apps/AppContext.js'
export const GENERATED_REL = 'client/editor/sdk-typings.generated.d.ts'
export const DIGEST_LINE = '// source digest: '
export const MAX_BUFFER = 256 * 1024 * 1024

export function normalizeEol(text) {
  return text.replace(/\r\n/g, '\n')
}

export function importSpecifiers(text) {
  const specs = []
  const patterns = [
    /\bfrom\s*['"]([^'"\n]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /(?:^|[\n;{}])\s*import\s*['"]([^'"\n]+)['"]/g
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(text))) specs.push(m[1])
  }
  return specs
}

export function resolveClosureMember(has, fromRel, spec) {
  if (!spec.startsWith('.')) return null
  const base = posix.normalize(posix.join(posix.dirname(fromRel), spec))
  for (const candidate of [base, base + '.js', base + '.mjs', posix.join(base, 'index.js')]) {
    if (has(candidate)) return candidate
  }
  return null
}

export function makeIndex({ has, read, preload }) {
  const cache = new Map()
  const load = async (rel) => {
    if (cache.has(rel)) return cache.get(rel)
    const text = await read(rel)
    cache.set(rel, text)
    return text
  }
  let members = null
  return {
    async members() {
      if (members !== null) return members
      const seen = new Set()
      let frontier = [SOURCE_REL]
      for (;;) {
        if (preload) await preload(frontier.filter(rel => !cache.has(rel)))
        const next = []
        for (const rel of frontier) {
          if (seen.has(rel)) continue
          seen.add(rel)
          const text = await load(rel)
          if (text === null || text === undefined) continue
          for (const spec of importSpecifiers(text)) {
            const member = resolveClosureMember(has, rel, spec)
            if (member !== null && !seen.has(member)) next.push(member)
          }
        }
        if (next.length === 0) break
        frontier = next
      }
      members = [...seen].sort()
      return members
    },
    async digest() {
      const outer = createHash('sha256')
      for (const rel of await this.members()) {
        const text = await load(rel)
        if (text === null || text === undefined) continue
        const inner = createHash('sha256').update(normalizeEol(text), 'utf8').digest('hex')
        outer.update(rel + '\u0000' + inner + '\n')
      }
      return outer.digest('hex')
    }
  }
}

export function catFileBatch(shas, cwd = process.cwd()) {
  const out = execFileSync('git', ['cat-file', '--batch'], {
    cwd,
    input: Buffer.from(shas.join('\n') + '\n', 'utf8'),
    maxBuffer: MAX_BUFFER
  })
  const got = new Map()
  let off = 0
  while (off < out.length) {
    const nl = out.indexOf(0x0a, off)
    if (nl < 0) break
    const header = out.slice(off, nl).toString('utf8').split(' ')
    off = nl + 1
    if (header.length < 3) continue
    const size = Number(header[2])
    if (!Number.isFinite(size) || size < 0) break
    got.set(header[0], out.slice(off, off + size).toString('utf8'))
    off += size + 1
  }
  return got
}

export function indexSource(cwd = process.cwd()) {
  const shas = new Map()
  for (const line of execFileSync('git', ['ls-files', '--stage'], { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER }).split('\n')) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const meta = line.slice(0, tab).trim().split(/\s+/)
    if (meta.length < 2) continue
    shas.set(line.slice(tab + 1), meta[1])
  }
  const contents = new Map()
  const load = (want) => {
    const got = catFileBatch(want, cwd)
    for (const sha of want) contents.set(sha, got.has(sha) ? got.get(sha) : null)
  }
  const has = (rel) => shas.has(rel)
  const read = (rel) => {
    const sha = shas.get(rel)
    if (sha === undefined) return null
    if (!contents.has(sha)) load([sha])
    return contents.get(sha)
  }
  const preload = (rels) => {
    const want = []
    for (const rel of rels) {
      const sha = shas.get(rel)
      if (sha !== undefined && !contents.has(sha)) want.push(sha)
    }
    if (want.length) load([...new Set(want)])
  }
  return makeIndex({ has, read, preload })
}

export function recordedDigest(text) {
  const m = text.match(/\/\/ source digest: ([0-9a-f]{64})/)
  return m === null ? null : m[1]
}
