import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

const MAX_BUFFER = 64 * 1024 * 1024
const REPO = process.env.SPOINT_REPO || 'AnEntrypoint/spoint'
const CACHE_DIR = join('.gm', 'tmp', 'published-tree')

export function gitAt(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER, windowsHide: true })
}

function ghAt(cwd, path, accept) {
  const args = ['api', path]
  if (accept) args.push('-H', `Accept: ${accept}`)
  return spawnSync('gh', args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER, windowsHide: true })
}

function headText(cwd, rel) {
  const done = gitAt(cwd, ['show', `HEAD:${rel}`])
  return done.status === 0 ? done.stdout : null
}

export function indexText(cwd, rel) {
  const done = gitAt(cwd, ['show', `:${rel}`])
  return done.status === 0 ? done.stdout : null
}

export function headIsWorktree(cwd) {
  return gitAt(cwd, ['diff', '--quiet']).status === 0 && gitAt(cwd, ['diff', '--cached', '--quiet']).status === 0
}

export function worktreeStateRev(cwd) {
  const done = gitAt(cwd, ['stash', 'create'])
  if (done.status !== 0) return null
  const sha = (done.stdout || '').trim()
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null
}

function publishedTree(cwd) {
  const ref = ghAt(cwd, `/repos/${REPO}/git/ref/heads/main`)
  if (ref.status !== 0) return null
  let tip
  try { tip = JSON.parse(ref.stdout).object.sha } catch { return null }
  const cachePath = join(cwd, CACHE_DIR, `tree-${tip}.json`)
  let entries
  if (existsSync(cachePath)) {
    try { entries = JSON.parse(readFileSync(cachePath, 'utf8')) } catch { entries = null }
  }
  if (entries === null || entries === undefined) {
    const listing = ghAt(cwd, `/repos/${REPO}/git/trees/${tip}?recursive=1`)
    if (listing.status !== 0) return null
    try { entries = JSON.parse(listing.stdout).tree } catch { return null }
    if (entries === null || entries === undefined) return null
    mkdirSync(dirname(cachePath), { recursive: true })
    writeFileSync(cachePath, JSON.stringify(entries), 'utf8')
  }
  const blobs = new Map()
  for (const entry of entries) if (entry.type === 'blob') blobs.set(entry.path, entry.sha)
  return { tip, blobs }
}

function publishedText(cwd, tree, rel) {
  const sha = tree.blobs.get(rel)
  if (sha === undefined) return null
  const local = gitAt(cwd, ['cat-file', 'blob', sha])
  if (local.status === 0) return local.stdout
  const cachePath = join(cwd, CACHE_DIR, `blob-${sha}`)
  if (existsSync(cachePath)) return readFileSync(cachePath, 'utf8')
  const got = ghAt(cwd, `/repos/${REPO}/git/blobs/${sha}`, 'application/vnd.github.raw')
  if (got.status !== 0) return null
  mkdirSync(dirname(cachePath), { recursive: true })
  writeFileSync(cachePath, got.stdout, 'utf8')
  return got.stdout
}

export function committedSource(cwd) {
  if (headIsWorktree(cwd)) {
    return batchedSource(cwd, 'HEAD (the work tree and the index both match HEAD, so HEAD is the tree under test)',
      (rel) => `HEAD:${rel}`, (rel) => headText(cwd, rel) ?? indexText(cwd, rel))
  }
  const tree = publishedTree(cwd)
  if (tree === null) {
    return batchedSource(cwd, 'stage 0 of the index (remote main did not answer, so the published tree is unavailable)',
      (rel) => `:${rel}`, (rel) => indexText(cwd, rel))
  }
  return batchedSource(cwd, `remote main ${tree.tip.slice(0, 12)}`,
    (rel) => tree.blobs.get(rel) ?? null, (rel) => publishedText(cwd, tree, rel) ?? indexText(cwd, rel), tree.tip)
}

export function catFileBatch(cwd, names) {
  const out = new Map()
  if (names.length === 0) return out
  const done = spawnSync('git', ['cat-file', '--batch'], { cwd, input: `${names.join('\n')}\n`, maxBuffer: MAX_BUFFER, windowsHide: true })
  if (done.status !== 0) return out
  const buf = done.stdout
  let pos = 0
  for (const name of names) {
    const nl = buf.indexOf(0x0a, pos)
    if (nl < 0) break
    const last = buf.toString('utf8', pos, nl).split(' ').pop()
    pos = nl + 1
    if (last === 'missing' || last === 'ambiguous') { out.set(name, null); continue }
    const size = Number(last)
    out.set(name, buf.toString('utf8', pos, pos + size))
    pos += size + 1
  }
  return out
}

function batchedSource(cwd, label, nameOf, fallback, tip) {
  const prefetched = new Map()
  const source = {
    label,
    prefetch(rels) {
      const named = []
      for (const rel of rels) {
        const name = nameOf(rel)
        if (name) named.push([rel, name])
      }
      const got = catFileBatch(cwd, named.map(([, name]) => name))
      for (const [rel, name] of named) {
        const text = got.get(name)
        if (typeof text === 'string') prefetched.set(rel, text)
      }
    },
    text: (rel) => (prefetched.has(rel) ? prefetched.get(rel) : fallback(rel)),
  }
  if (tip !== undefined) source.tip = tip
  return source
}
