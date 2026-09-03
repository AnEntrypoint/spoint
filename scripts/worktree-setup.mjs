// Every fresh `git worktree add` has no node_modules of its own -- client assets (three.js, webjsx,
// app.js's importmap-resolved deps) 404 completely silently (no thrown error, window.__app just never
// initializes) until node_modules is linked back to the main checkout. This creates that link.
// Windows: a directory junction (mklink /J, no admin/symlink-privilege required, unlike /D or /H).
// POSIX: a plain symlink (ln -s).
//
// MAIN_ROOT is derived from `git rev-parse --git-common-dir` (the main checkout's .git), NOT from this
// script's own file location: git worktrees carry a copy of every tracked file including this script,
// so import.meta.url resolves to WHICHEVER copy is executing -- run from inside a worktree, the old
// script thought the worktree WAS main, found no node_modules there, and refused with a misleading
// error (hit independently by two agents, 2026-07-07).
//
// WORKSPACE CAVEAT: node_modules/mapspinner + node_modules/streaming-gltf are junctions into the MAIN
// checkout's packages/ (npm workspaces). Through this whole-node_modules link, a worktree session that
// edits ITS OWN packages/<name>/ files will NOT see them served/imported -- the junction chain resolves
// to main's packages. Edit packages/* in the main checkout, or run a full `npm install` inside the
// worktree to get worktree-local links. The server's boot identity banner prints the resolved real
// paths so a mismatch is self-announcing.
//
// TORN-INSTALL GUARD: a concurrent session running `npm install` (or an interrupted one) against
// this SAME shared main-checkout node_modules can leave it existsSync()-true but genuinely
// incomplete for a real window -- observed live as a declared package.json dependency (e.g.
// @dgreenheck/ez-tree) resolving to nothing on disk mid-session, with node_modules' own mtime
// moving during the gap (single-writer contention on one shared directory across concurrent
// worktree sessions, not a bug in any one session's own code -- see AGENTS.md's
// main-node-modules-missing-ez-tree-package-intermittent history). Since every worktree links to
// this ONE directory via a junction/symlink (never copies), linking DURING a torn window propagates
// the torn state into every worktree that links afterward, even if the write finishes moments later.
// Before linking, verify node_modules looks genuinely complete and retry with bounded backoff
// instead of proceeding into a known-bad snapshot.
//
// POSTINSTALL-PATCH GAP: this environment's npm config carries ignore-scripts=true (confirmed live via
// `npm config list -l` showing "ignore-scripts = true ; overridden by env", NPM_CONFIG_IGNORE_SCRIPTS=true
// set at the Windows User environment-variable level -- outside this repo's control, likely a deliberate
// security policy against arbitrary postinstall execution from third-party packages, not something to
// silently unset). That setting makes a plain `npm install` skip package.json's own
// `"postinstall": "node scripts/patch-deps.mjs"` with ZERO warning or error -- node_modules looks
// complete (right package count, no npm error) but is silently unpatched, which previously cost a real
// investigation session chasing phantom GL bugs before the missing patches were found (see AGENTS.md's
// npm-ignore-scripts-silently-skips-postinstall-patch-deps-env-gap history). Fix: this script always
// invokes patch-deps.mjs itself as a plain `node` call at the end of main() -- NOT through npm, so
// ignore-scripts cannot suppress it -- against whichever node_modules directory ends up in play
// (worktree-local after a real `npm install` here, or the main checkout's shared directory reached via
// the junction/symlink this script creates). Idempotent (patch-deps.mjs's own marker-gated no-op), so
// running it redundantly on an already-patched tree is always safe.
//
// Run: node scripts/worktree-setup.mjs [worktreePath]   (worktreePath defaults to cwd)

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
    // --git-common-dir is <main>/.git (absolute, or relative to cwd); its parent is the main checkout.
    return dirname(resolve(targetWorktree, common))
  } catch (e) {
    const fallback = resolve(fileURLToPath(import.meta.url), '..', '..')
    console.warn(`[worktree-setup] git rev-parse --git-common-dir failed (${e.message}); falling back to script-relative root ${fallback} -- WRONG if this script runs from a worktree copy`)
    return fallback
  }
}

const MAIN_ROOT = deriveMainRoot()

// Real, cheap completeness signals for "is mainNodeModules a finished install right now":
// (1) node_modules/.package-lock.json is npm's OWN on-disk record of what it actually installed,
//     written near the END of a successful `npm install` -- its absence (or an unparseable one)
//     while node_modules itself already exists is a strong mid-install/torn signal, distinct from a
//     legitimate `rm -rf node_modules` (which removes the whole directory, already caught above).
// (2) every top-level dependency/devDependency/optionalDependency declared in package.json actually
//     resolves to a directory on disk -- package.json is small (tens of entries), so checking ALL of
//     them (not just a sample) is a handful of existsSync() calls, cheap enough to always do.
// Neither check is a full `npm ls`-grade correctness proof (a package could exist on disk but be
// itself partially-written mid-copy), but both are real signals an interrupted/concurrent install
// leaves behind, and checking them costs microseconds vs. propagating a torn link into a worktree.
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
  // optionalDependencies (e.g. sharp) are allowed to be legitimately absent (platform-specific/best-effort,
  // see AGENTS.md's sharp optionalDependency history) -- only a missing REQUIRED dep counts as torn.
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

// Always invoked as a plain `node` call (never `npm run`/`npm install`), so the environment's
// NPM_CONFIG_IGNORE_SCRIPTS=true (or any ignore-scripts source) cannot suppress it -- see the
// POSTINSTALL-PATCH GAP note at the top of this file. patchDepsCwd is whichever directory actually
// OWNS scripts/patch-deps.mjs and the node_modules it patches (the worktree itself when it has a
// worktree-local install, otherwise MAIN_ROOT since that's what the link points at).
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
    // A real directory that is NOT a link to main -- this is a worktree-local install (e.g. a fresh
    // `npm install` run directly inside the worktree, which this script's own header comment already
    // documents as the escape hatch for packages/* edits). patch-deps.mjs must run against THIS
    // worktree's own node_modules/scripts, not main's, since that's what actually gets served.
    if (st.isDirectory()) {
      console.log(`[worktree-setup] ${linkPath} is a worktree-local node_modules (not a link) -- leaving it as-is`)
      ensurePatchesApplied(targetWorktree)
      return
    }
    console.error(`[worktree-setup] ${linkPath} already exists and is not a link to the main checkout -- refusing to overwrite`)
    process.exitCode = 1
    return
  }
  // Only worth the torn-install retry/backoff wait when we're actually about to CREATE a new link
  // (an already-linked worktree above already returned; a pre-existing non-link path already errored).
  // RESIDUAL RACE (pre-existing, this wait widens the window but doesn't create it): two
  // worktree-setup.mjs invocations for the SAME new worktree path racing here can both pass the
  // existsSync(linkPath) check above and both reach mklink/ln -s below; the loser's execFileSync
  // throws (verified live: a second `mklink /J` against an already-created target fails loudly with
  // "Cannot create a file when that file already exists", exit 1, no silent corruption) and
  // propagates via this file's own main().catch() -- a real failure, not a false success, so this is
  // a liveness gap (the loser has to re-run) rather than a correctness one. Not fixed here: a real
  // fix needs a lockfile/mutex around the whole check-then-link sequence, which is more machinery
  // than this task's node_modules-completeness scope justified; two sessions creating the SAME new
  // worktree at the same instant is also a narrower, rarer trigger than the concurrent-install
  // contention this guard exists for.
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
