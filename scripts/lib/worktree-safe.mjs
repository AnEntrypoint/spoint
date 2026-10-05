import { readdirSync, lstatSync, existsSync, rmdirSync, unlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const SKIP_TOP_LEVEL = new Set(['.git'])

export function findLinks(root) {
  const links = []
  const walk = (dir, depth) => {
    for (const name of readdirSync(dir)) {
      if (depth === 0 && SKIP_TOP_LEVEL.has(name)) continue
      const full = join(dir, name)
      const st = lstatSync(full)
      if (st.isSymbolicLink()) { links.push(full); continue }
      if (st.isDirectory()) walk(full, depth + 1)
    }
  }
  walk(root, 0)
  return links
}

export function entryCount(dir) {
  try { return readdirSync(dir).length } catch (_) { return -1 }
}

function mainDeletions(repo) {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })
  return new Set(r.stdout.split('\n').filter((l) => /^.?D /.test(l) || /^D /.test(l)))
}

export function removeWorktreeSafely({ repo, worktree }) {
  const before = mainDeletions(repo)
  const links = findLinks(worktree)
  const targets = links.map((link) => {
    let real = null
    try { real = realpathSync(link) } catch (_) {}
    return { link, real, count: real ? entryCount(real) : null }
  })
  for (const t of targets) {
    const st = lstatSync(t.link)
    if (!st.isSymbolicLink()) throw new Error('refusing: not a link at removal time: ' + t.link)
    try { unlinkSync(t.link) } catch (_) { rmdirSync(t.link) }
  }
  for (const t of targets) {
    if (existsSync(t.link)) throw new Error('refusing: link still present after removal: ' + t.link)
  }
  const remaining = findLinks(worktree)
  if (remaining.length) throw new Error('refusing to delete worktree, links remain: ' + remaining.join(', '))
  for (const t of targets) {
    if (t.real && entryCount(t.real) !== t.count) throw new Error(`junction target entry count changed for ${t.real}: ${t.count} -> ${entryCount(t.real)}`)
  }
  const r = spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: repo, encoding: 'utf8' })
  if (r.status !== 0) throw new Error('git worktree remove failed: ' + (r.stderr || r.stdout).trim())
  for (const t of targets) {
    if (t.real && entryCount(t.real) !== t.count) throw new Error(`junction target entry count changed after worktree removal for ${t.real}: ${t.count} -> ${entryCount(t.real)}`)
  }
  const after = mainDeletions(repo)
  const newDeletions = [...after].filter((l) => !before.has(l))
  if (newDeletions.length) throw new Error('main tree gained deletions: ' + newDeletions.slice(0, 5).join(' | '))
  return { removedLinks: links.length, targetsChecked: targets.length, worktreeExists: existsSync(worktree) }
}
