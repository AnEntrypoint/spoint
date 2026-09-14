#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const SDK_ROOT = dirname(fileURLToPath(import.meta.url))
const nodeModulesDir = join(SDK_ROOT, 'node_modules')
const FIRST_THIRD_PARTY_IMPORT = 'xstate'
const isNodeModulesLinked = () => existsSync(nodeModulesDir) && existsSync(join(nodeModulesDir, FIRST_THIRD_PARTY_IMPORT))

if (!isNodeModulesLinked()) {
  try {
    execFileSync(process.execPath, [join(SDK_ROOT, 'scripts', 'worktree-setup.mjs'), SDK_ROOT], {
      stdio: 'inherit',
      cwd: SDK_ROOT,
    })
  } catch (e) {
  }
}

if (!isNodeModulesLinked()) {
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

const PATCH_DEPS_R183_MARKER = 'spoint patch] three r183'
try {
  const instancedMeshIndex = join(nodeModulesDir, '@three.ez', 'instanced-mesh', 'build', 'index.js')
  if (existsSync(instancedMeshIndex) && !readFileSync(instancedMeshIndex, 'utf8').includes(PATCH_DEPS_R183_MARKER)) {
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
    if (!readFileSync(instancedMeshIndex, 'utf8').includes(PATCH_DEPS_R183_MARKER)) {
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
if (cmd === 'create-app') {
  await import('./bin/create-app.js')
} else if (cmd === 'scaffold') {
  await scaffold()
} else {
  await scaffold()
  try {
    await boot()
  } catch (err) {
    const errorAlreadyPrintedActionably = err && (err.spointSingleInstance || err.code === 'EADDRINUSE' || err.spointNodeModulesMissing)
    if (errorAlreadyPrintedActionably) process.exit(1)
    throw err
  }
}
