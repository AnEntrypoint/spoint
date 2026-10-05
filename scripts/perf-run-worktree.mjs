#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, lstatSync, realpathSync, symlinkSync, copyFileSync, rmdirSync, unlinkSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const commitArg = argv.find((a) => a.startsWith('--commit='))
const keep = argv.includes('--keep-worktree')
const buildOnly = argv.includes('--build-only')
const passthrough = argv.filter((a) => !a.startsWith('--commit=') && a !== '--keep-worktree' && a !== '--build-only')
if (!commitArg) {
  console.error('usage: node scripts/perf-run-worktree.mjs --commit=<sha> [--build-only] [--keep-worktree] <perf-run.mjs args>')
  process.exit(2)
}

const git = (args, cwd = ROOT) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`)
  return r.stdout.trim()
}
const sha16 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16)

const commit = git(['rev-parse', '--verify', commitArg.slice('--commit='.length) + '^{commit}'])
const WORKTREE_BASE = resolve(process.env.SPOINT_PERF_WORKTREE_BASE || join(dirname(ROOT), '.spoint-perf-worktrees'))
mkdirSync(WORKTREE_BASE, { recursive: true })
const wt = join(WORKTREE_BASE, `spoint-wt-${commit.slice(0, 10)}-${process.pid}`)
const links = []
const copies = []

function linkDir(target, at) { symlinkSync(target, at, 'junction'); links.push(at) }

function mirrorNodeModules(srcDir, dstDir) {
  mkdirSync(dstDir, { recursive: true })
  for (const name of readdirSync(srcDir)) {
    const src = join(srcDir, name)
    const dst = join(dstDir, name)
    const st = lstatSync(src)
    if (name.startsWith('@') && st.isDirectory() && !st.isSymbolicLink()) { mirrorNodeModules(src, dst); continue }
    if (st.isSymbolicLink()) {
      const real = realpathSync(src)
      const rel = relative(ROOT, real)
      const inRepo = !rel.startsWith('..') && !rel.includes(':')
      const wtTarget = inRepo ? join(wt, rel) : real
      linkDir(existsSync(wtTarget) ? wtTarget : real, dst)
      continue
    }
    if (st.isDirectory()) { linkDir(src, dst); continue }
    copyFileSync(src, dst); copies.push(dst)
  }
}

function removeWorktree() {
  for (const p of links.reverse()) { try { rmdirSync(p) } catch (e) { console.error('[worktree] could not unlink junction ' + p + ': ' + e.message) } }
  for (const p of copies) { try { unlinkSync(p) } catch (_) {} }
  const nm = join(wt, 'node_modules')
  if (existsSync(nm)) rmSync(nm, { recursive: true, force: true })
  git(['worktree', 'remove', '--force', wt])
  console.log('[worktree] removed ' + wt)
}

let exitCode = 1
try {
  git(['worktree', 'add', '--detach', wt, commit])
  console.log(`[worktree] ${wt} at ${commit}`)
  mirrorNodeModules(join(ROOT, 'node_modules'), join(wt, 'node_modules'))
  for (const pkg of readdirSync(join(ROOT, 'packages'))) {
    const nested = join(ROOT, 'packages', pkg, 'node_modules')
    if (existsSync(nested) && existsSync(join(wt, 'packages', pkg)) && !existsSync(join(wt, 'packages', pkg, 'node_modules'))) linkDir(nested, join(wt, 'packages', pkg, 'node_modules'))
  }
  for (const step of [['scripts/bundle-client.mjs'], ['scripts/bundle-worker.mjs']]) {
    const r = spawnSync(process.execPath, step, { cwd: wt, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`${step[0]} failed in worktree: ${(r.stderr || r.stdout || '').trim().slice(-800)}`)
  }
  const meta = {
    commit,
    worktree: wt,
    statusPorcelain: git(['status', '--porcelain'], wt),
    clientBundleSha: sha16(join(wt, 'dist', 'client', 'app.js')),
    workerBundleSha: sha16(join(wt, 'dist', 'src', 'sdk', 'WorkerEntry.js')),
    builtAt: new Date().toISOString(),
  }
  console.log('[worktree] ' + JSON.stringify(meta))
  if (meta.statusPorcelain !== '') throw new Error('worktree is not clean after build:\n' + meta.statusPorcelain)
  const metaPath = join(tmpdir(), `spoint-wt-meta-${process.pid}.json`)
  writeFileSync(metaPath, JSON.stringify(meta))
  if (buildOnly) exitCode = 0
  else {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'perf-run.mjs'), ...passthrough, '--serve-root=' + wt, '--worktree-meta=' + metaPath], { stdio: 'inherit' })
    exitCode = r.status == null ? 1 : r.status
  }
  try { unlinkSync(metaPath) } catch (_) {}
} catch (e) {
  console.error('[worktree] ' + e.message)
} finally {
  if (keep) console.log('[worktree] kept ' + wt)
  else if (existsSync(wt)) { try { removeWorktree() } catch (e) { console.error('[worktree] removal failed: ' + e.message) } }
}
process.exit(exitCode)
