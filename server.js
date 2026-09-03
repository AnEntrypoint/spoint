#!/usr/bin/env node
// NODE_MODULES PRECHECK, before any local-module import resolves (deliberately builtins-only up top):
// src/sdk/server.js statically imports a long chain of local modules, several of which (e.g.
// ReloadManager.js -> 'xstate') themselves statically import third-party packages from node_modules.
// ESM resolves and LINKS the entire static-import graph before a single line of module body code runs
// -- so a totally-missing node_modules (a fresh `git worktree add`, never linked/installed) aborts at
// `ERR_MODULE_NOT_FOUND: Cannot find package 'xstate'` from deep inside ReloadManager.js, and
// src/sdk/server.js's own boot()-time assertNodeModulesLinked() guard (see that function's comment)
// NEVER RUNS -- it's dead code for this exact case, since the throw happens during import resolution,
// before boot() is even reachable. Live-reproduced in a genuinely node_modules-less worktree: `node
// server.js` printed a raw unattributed ERR_MODULE_NOT_FOUND stack naming 'xstate' with zero mention
// of node_modules or the actual fix, instead of assertNodeModulesLinked's clear FATAL message.
// Fix: check node_modules HERE, with only node:fs/node:path/node:url (which resolve fine with zero
// node_modules since they're builtins), before dynamically importing './src/sdk/server.js' -- a
// dynamic import()'s rejection is a normal catchable Promise rejection, letting this print the same
// actionable message assertNodeModulesLinked already has for the "exists but torn" case, now covering
// the "doesn't exist / is empty" case too, for every entry path (direct `node server.js`, `npm start`,
// a spawned child process in a test harness) since they all pass through this one file. Checks 'xstate'
// specifically (not just directory existence) because that is the FIRST third-party import to abort
// the graph (via ReloadManager.js, imported early in src/sdk/server.js's own static-import chain) --
// live-reproduced: a node_modules dir that EXISTS but is empty (e.g. a concurrent `npm install`
// mid-run that already mkdir'd the directory) still passes a bare existsSync(node_modules) check yet
// still aborts with the exact same raw ERR_MODULE_NOT_FOUND stack, so existence alone is insufficient.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const SDK_ROOT = dirname(fileURLToPath(import.meta.url))

// AUTO-HEAL, before failing: the harness/CLI layer that runs `git worktree add` for this project lives
// entirely OUTSIDE this repo's source tree (confirmed: grepped every .claude/workflows/*.js and this
// whole checkout for a `worktree-setup`/`git worktree add` invocation -- none exists in-repo, so there
// is no in-repo hook point that fires ON worktree creation; git itself also ships no `worktree`-related
// hook event as of 2.46, confirmed via `git help hooks`), so a fresh worktree can reach this file with
// node_modules never linked regardless of what created it. scripts/worktree-setup.mjs is exactly this
// case's fix and needs zero third-party packages to run (only node:fs/path/child_process/url, same
// builtins-only constraint as this precheck) -- so instead of only erroring, attempt the link FIRST,
// silently, then re-check. Safe unconditionally: worktree-setup.mjs's own deriveMainRoot() + identity
// check already no-ops when run from the main checkout itself (nothing to link to), and its torn-install
// guard already refuses to link against a mid-install main node_modules rather than propagating one.
if (!existsSync(join(SDK_ROOT, 'node_modules')) || !existsSync(join(SDK_ROOT, 'node_modules', 'xstate'))) {
  try {
    execFileSync(process.execPath, [join(SDK_ROOT, 'scripts', 'worktree-setup.mjs'), SDK_ROOT], {
      stdio: 'inherit',
      cwd: SDK_ROOT,
    })
  } catch (e) {
    // worktree-setup.mjs already printed its own actionable reason (torn main node_modules, no link
    // target, etc.) via its own console.error calls (stdio:'inherit' above) -- nothing more to add here,
    // fall through to the existence re-check below, which will report the FATAL if it's still missing.
  }
}

const nodeModulesDir = join(SDK_ROOT, 'node_modules')
if (!existsSync(nodeModulesDir) || !existsSync(join(nodeModulesDir, 'xstate'))) {
  console.error(
    `[boot] FATAL: ${nodeModulesDir} is missing or incomplete (no 'xstate' package found) -- this\n` +
    `  checkout/worktree's node_modules was never linked, or an install is still in progress, and the\n` +
    `  automatic "node scripts/worktree-setup.mjs" attempt above did not resolve it (see its own output\n` +
    `  for the reason). Fix: run "node scripts/worktree-setup.mjs" from this worktree yourself once the\n` +
    `  underlying issue (e.g. main checkout has no node_modules yet, or a concurrent install is torn) is\n` +
    `  resolved, or run "npm install" here directly for a fully worktree-local install.`
  )
  process.exit(1)
}

// PATCH-DEPS VERIFICATION (packages-octahedral-impostor-ez-js-renderatlascells-terrainocclu):
// `npm install`'s "postinstall": "node scripts/patch-deps.mjs" step patches
// node_modules/@three.ez/instanced-mesh's built bundle to declare `instanceIndex` before a
// custom/depth material's injected uniforms block references it (see patch-deps.mjs's own header
// comment: on three r183 a custom/depth material does not always include
// <batching_pars_vertex>, the chunk the lib normally appends that declaration onto). npm silently
// SKIPS postinstall scripts whenever the environment/user has `ignore-scripts=true` set (`npm
// config get ignore-scripts`) -- live-reproduced this exact silent-skip in a fresh worktree install
// this session. Without the patch, every InstancedMesh2-based system (Vegetation/Rocks/Grass, and
// any custom/depth material built on top, e.g. the terrain occlusion box program sharing a GL
// context with a broken program) gets a shader compile failure every frame -> a broken/unlinked GL
// program -> `useProgram: program not valid` + cascading `GL_INVALID_OPERATION` on WHATEVER draw
// call happens to run next on the same context, since a stale unpolled GL error can surface on an
// unrelated draw call's next getError() poll. This previously misdirected root-cause investigation
// toward TerrainOcclusion.js/octahedral-impostor-ez.js's renderAtlasCells (both innocent -- live
// re-verified clean with the patch correctly applied) instead of the real cause here. Loud WARNING
// (not fatal: the game still mostly runs, just with a visible perf/GL-error-flood regression) so a
// future missing-patch install is immediately self-diagnosing instead of looking like a rendering bug.
try {
  const instancedMeshIndex = join(nodeModulesDir, '@three.ez', 'instanced-mesh', 'build', 'index.js')
  if (existsSync(instancedMeshIndex) && !readFileSync(instancedMeshIndex, 'utf8').includes('spoint patch] three r183')) {
    console.warn(
      `[boot] WARNING: ${instancedMeshIndex} is missing the required "three r183 instanceIndex decl"\n` +
      `  patch from scripts/patch-deps.mjs. This usually means npm's postinstall script was skipped\n` +
      `  (check "npm config get ignore-scripts" -- true silently skips postinstall). Without this patch,\n` +
      `  InstancedMesh2-based systems (vegetation/rocks/grass) get a shader compile failure every frame,\n` +
      `  which floods the GL context with cascading errors that can surface on unrelated draw calls.\n` +
      `  Auto-healing now by running scripts/patch-deps.mjs directly (same fix "npm install" would have\n` +
      `  applied via postinstall) so this boot serves the patched bundle instead of repeating the same\n` +
      `  manual fix every reboot in an environment with ignore-scripts set.`
    )
    execFileSync(process.execPath, [join(SDK_ROOT, 'scripts', 'patch-deps.mjs')], { stdio: 'inherit', cwd: SDK_ROOT })
    if (!readFileSync(instancedMeshIndex, 'utf8').includes('spoint patch] three r183')) {
      console.error(
        `[boot] FATAL: ran scripts/patch-deps.mjs but ${instancedMeshIndex} still does not carry the\n` +
        `  "three r183 instanceIndex decl" patch marker -- the auto-heal did not resolve it. Run\n` +
        `  "node scripts/patch-deps.mjs" manually and inspect its own output for the real cause.`
      )
      process.exit(1)
    }
  }
} catch (e) {
  console.error(`[boot] FATAL: patch-deps auto-heal itself failed: ${e && e.message || e}`)
  process.exit(1)
}

const { boot } = await import('./src/sdk/server.js')
const { scaffold } = await import('./src/sdk/scaffold.js')

const cmd = process.argv[2]
// `spoint create-app <name> --template <t>` (agentic-game-making-pipeline): forward to bin/create-app.js
// which itself strips the leading 'create-app' token from argv before parsing. Import-only -- that
// module self-executes the CLI and exits on its own failure paths.
if (cmd === 'create-app') {
  await import('./bin/create-app.js')
} else if (cmd === 'scaffold') {
  await scaffold()
} else {
  await scaffold()
  try {
    await boot()
  } catch (err) {
    // ServerAPI already printed the actionable single-instance message; skip the raw EADDRINUSE stack.
    if (err && (err.spointSingleInstance || err.code === 'EADDRINUSE')) process.exit(1)
    // assertNodeModulesLinked already printed the actionable fix (run scripts/worktree-setup.mjs);
    // skip the raw stack trace, same as the single-instance case above. Kept as defense-in-depth: the
    // precheck above covers "missing entirely", assertNodeModulesLinked still covers a node_modules
    // that exists but got rm -rf'd/moved between this precheck and boot() actually running.
    if (err && err.spointNodeModulesMissing) process.exit(1)
    throw err
  }
}
