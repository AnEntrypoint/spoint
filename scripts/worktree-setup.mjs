import { existsSync, lstatSync, realpathSync, readFileSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const targetWorktree = resolve(process.argv[2] || process.cwd())
const TORN_CHECK_RETRIES = 5
const TORN_CHECK_DELAY_MS = 2000

function deriveMainRoot() {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: targetWorktree, encoding: 'utf8' }).trim()
    return dirname(resolve(targetWorktree, common))
  } catch (e) {
    const fallback = resolve(fileURLToPath(import.meta.url), '..', '..')
    console.warn(`[worktree-setup] git rev-parse --git-common-dir failed (${e.message}); falling back to script-relative root ${fallback} -- WRONG if this script runs from a worktree copy`)
    return fallback
  }
}

const MAIN_ROOT = deriveMainRoot()

function nodeModulesLooksComplete(nodeModulesDir, mainRoot) {
  const lockArtifact = join(nodeModulesDir, '.package-lock.json')
  if (!existsSync(lockArtifact)) return { ok: false, reason: `${lockArtifact} missing (no completed-install marker)` }
  try {
    JSON.parse(readFileSync(lockArtifact, 'utf8'))
  } catch (e) {
    return { ok: false, reason: `${lockArtifact} exists but failed to parse (${e.message}) -- likely being written right now` }
  }
  let pkg
  try {
    pkg = JSON.parse(readFileSync(join(mainRoot, 'package.json'), 'utf8'))
  } catch (e) {
    return { ok: false, reason: `main package.json unreadable (${e.message})` }
  }
  const declared = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.optionalDependencies || {}) }
  const missing = Object.keys(declared).filter(name => !existsSync(join(nodeModulesDir, ...name.split('/'))))
  const optionalNames = new Set(Object.keys(pkg.optionalDependencies || {}))
  const missingRequired = missing.filter(name => !optionalNames.has(name))
  if (missingRequired.length) return { ok: false, reason: `declared dependencies missing on disk: ${missingRequired.join(', ')}` }
  return { ok: true }
}

async function waitForCompleteNodeModules(nodeModulesDir, mainRoot) {
  let last = { ok: false, reason: 'not checked yet' }
  for (let attempt = 1; attempt <= TORN_CHECK_RETRIES; attempt++) {
    last = nodeModulesLooksComplete(nodeModulesDir, mainRoot)
    if (last.ok) return last
    console.warn(`[worktree-setup] node_modules looks torn/mid-install (attempt ${attempt}/${TORN_CHECK_RETRIES}): ${last.reason}`)
    if (attempt < TORN_CHECK_RETRIES) await new Promise(r => setTimeout(r, TORN_CHECK_DELAY_MS))
  }
  return last
}

function ensurePatchesApplied(patchDepsCwd) {
  const patchScript = join(patchDepsCwd, 'scripts', 'patch-deps.mjs')
  if (!existsSync(patchScript)) {
    console.warn(`[worktree-setup] ${patchScript} not found -- skipping postinstall-patch step`)
    return
  }
  try {
    execFileSync(process.execPath, [patchScript], { cwd: patchDepsCwd, stdio: 'inherit' })
  } catch (e) {
    console.error(`[worktree-setup] patch-deps.mjs failed: ${e?.message || e}`)
    process.exitCode = 1
  }
}

async function main() {
  const mainNodeModules = join(MAIN_ROOT, 'node_modules')
  if (!existsSync(mainNodeModules)) {
    console.error(`[worktree-setup] main checkout has no node_modules at ${mainNodeModules} -- run npm install there first`)
    process.exitCode = 1
    return
  }
  if (resolve(targetWorktree) === resolve(MAIN_ROOT)) {
    console.log(`[worktree-setup] target IS the main checkout (${MAIN_ROOT}); nothing to link`)
    ensurePatchesApplied(MAIN_ROOT)
    return
  }
  const linkPath = join(targetWorktree, 'node_modules')
  if (existsSync(linkPath)) {
    const st = lstatSync(linkPath)
    if (st.isSymbolicLink() || st.isDirectory() && isJunctionTo(linkPath, mainNodeModules)) {
      console.log(`[worktree-setup] node_modules already linked at ${linkPath}`)
      ensurePatchesApplied(MAIN_ROOT)
      return
    }
    if (st.isDirectory()) {
      console.log(`[worktree-setup] ${linkPath} is a worktree-local node_modules (not a link) -- leaving it as-is`)
      ensurePatchesApplied(targetWorktree)
      return
    }
    console.error(`[worktree-setup] ${linkPath} already exists and is not a link to the main checkout -- refusing to overwrite`)
    process.exitCode = 1
    return
  }
  const completeness = await waitForCompleteNodeModules(mainNodeModules, MAIN_ROOT)
  if (!completeness.ok) {
    console.error(`[worktree-setup] main checkout's node_modules still looks torn/mid-install after ${TORN_CHECK_RETRIES} attempts (${completeness.reason}) -- refusing to link a worktree to a known-incomplete shared node_modules. Re-run this script once the concurrent install finishes (or run npm install in ${MAIN_ROOT} yourself), or pass through knowingly by linking manually.`)
    process.exitCode = 1
    return
  }
  if (process.platform === 'win32') {
    execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, mainNodeModules], { stdio: 'inherit' })
  } else {
    execFileSync('ln', ['-s', mainNodeModules, linkPath], { stdio: 'inherit' })
  }
  console.log(`[worktree-setup] linked ${linkPath} -> ${mainNodeModules}`)
  console.log(`[worktree-setup] NOTE: packages/* edits made INSIDE this worktree are not live through this link (junctions resolve to main's packages/) -- edit packages/* in ${MAIN_ROOT}, or npm install here for worktree-local links`)
  ensurePatchesApplied(MAIN_ROOT)
}

function isJunctionTo(linkPath, target) {
  try { return realpathSync(linkPath) === realpathSync(target) } catch { return false }
}

main().catch(e => { console.error(`[worktree-setup] unexpected error: ${e?.stack || e}`); process.exitCode = 1 })
