import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GIT_MAX_BUFFER = 64 * 1024 * 1024

function git(args) {
  return spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, windowsHide: true })
}

function normalizedHash(text) {
  if (text === null) return null
  return createHash('sha1').update(text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 12)
}

function contentAtHead(rel) {
  const run = git(['show', `HEAD:${rel}`])
  return run.status === 0 ? run.stdout : null
}

function contentInWorktree(rel) {
  const absolute = join(REPO_ROOT, rel)
  if (!existsSync(absolute)) return null
  return readFileSync(absolute, 'utf8')
}

function isTracked(rel) {
  const run = git(['ls-files', '--error-unmatch', rel])
  return run.status === 0
}

function main() {
  const paths = process.argv.slice(2).filter(a => !a.startsWith('-'))
  if (paths.length === 0) {
    console.error('head-vs-worktree: pass at least one repo-relative path')
    process.exit(2)
  }
  const rows = []
  for (const rel of paths) {
    const tracked = isTracked(rel)
    const headText = contentAtHead(rel)
    const workText = contentInWorktree(rel)
    const headHash = normalizedHash(headText)
    const workHash = normalizedHash(workText)
    rows.push({
      rel,
      tracked,
      headHash,
      workHash,
      presentInHead: headText !== null,
      presentInWorktree: workText !== null,
      differsFromHead: headText !== null && workText !== null && headHash !== workHash,
    })
  }
  for (const r of rows) {
    const state = !r.tracked ? 'untracked'
      : !r.presentInHead ? 'not in HEAD'
        : !r.presentInWorktree ? 'missing from worktree'
          : r.differsFromHead ? 'DIRTY vs HEAD' : 'matches HEAD'
    console.log(`${r.rel}\n  ${state}  head=${r.headHash ?? '(absent)'}  worktree=${r.workHash ?? '(absent)'}`)
  }
  const dirty = rows.filter(r => r.differsFromHead)
  const untracked = rows.filter(r => !r.tracked)
  const verdict = dirty.length === 0 && untracked.length === 0
    ? `HEAD is clean: all ${rows.length} file(s) match HEAD byte-for-byte`
    : `${dirty.length} file(s) differ from HEAD and ${untracked.length} file(s) are untracked -- any gate failure over these is in-flight, not committed`
  console.log(`head-vs-worktree: ${verdict}`)
  if (dirty.length > 0) console.log(`head-vs-worktree: differing: ${dirty.map(r => r.rel).join(', ')}`)
}

main()
