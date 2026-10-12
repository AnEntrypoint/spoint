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

/**
 * Stage 0 of the index: the text a commit from this checkout would write for
 * `rel`. It is what `git commit` records for a path nobody stages by hand, and
 * on a clean checkout it is byte-identical to HEAD.
 */
export function indexText(cwd, rel) {
  const done = gitAt(cwd, ['show', `:${rel}`])
  return done.status === 0 ? done.stdout : null
}

/**
 * True when the work tree and the index both match HEAD, which is what a CI
 * checkout is. Then HEAD *is* the tree under test and needs no second opinion.
 */
export function headIsWorktree(cwd) {
  return gitAt(cwd, ['diff', '--quiet']).status === 0 && gitAt(cwd, ['diff', '--cached', '--quiet']).status === 0
}

/**
 * A rev whose checkout is this work tree's tracked state, or null when no
 * tracked path differs from HEAD. `git stash create` writes objects and touches
 * neither the work tree, the index nor any ref, so it cannot disturb another
 * lane's in-flight edit; the rev it prints is unreferenced, so a caller must
 * use it in the same run.
 *
 * Null means a clean checkout, where HEAD already is the work tree's tracked
 * state: callers fall back to HEAD and behave exactly as they always did there.
 */
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

/**
 * Where "the committed content of a tracked path" comes from, named so no run
 * is silent about it.
 *
 * HEAD is not it in a shared checkout. Lanes publish path-scoped through the
 * GitHub Git API (blobs -> tree -> commit -> PATCH refs/heads/main), which
 * advances remote main and never advances local HEAD, and a local `git commit
 * -- paths` in the same shared work tree can leave a re-baked closure beside
 * the .hf it replaced. Measured 2026-10-12 at local HEAD 5e4b8969 with remote
 * main 135 commits ahead: under scripts/ 45 published blobs are absent from
 * local HEAD and 43 more differ from it, so HEAD is a tree nobody shipped and
 * a gate reading it either fails on a published file or resurrects a fix that
 * is already published.
 *
 * A clean checkout (CI, push and pull_request alike) keeps HEAD. Otherwise the
 * published tree answers, with stage 0 of the index behind it for a path that
 * is tracked but not yet published -- a file that has never shipped is in
 * flight, and the one thing this must not do is drop it silently.
 */
export function committedSource(cwd) {
  if (headIsWorktree(cwd)) {
    return {
      label: 'HEAD (the work tree and the index both match HEAD, so HEAD is the tree under test)',
      text: (rel) => headText(cwd, rel) ?? indexText(cwd, rel),
    }
  }
  const tree = publishedTree(cwd)
  if (tree === null) {
    return {
      label: 'stage 0 of the index (remote main did not answer, so the published tree is unavailable)',
      text: (rel) => indexText(cwd, rel),
    }
  }
  return {
    label: `remote main ${tree.tip.slice(0, 12)}`,
    tip: tree.tip,
    text: (rel) => publishedText(cwd, tree, rel) ?? indexText(cwd, rel),
  }
}
