#!/usr/bin/env node
// Build-time only: bundle the client main-thread entry (client/app.js and its
// STATIC relative import graph) into one cacheable artifact so production serving
// can send a single minified file instead of ~dozens of separate module requests.
// Follows the exact external/inline split already proven by bundle-worker.mjs.
//
// Left EXTERNAL (never inlined), because inlining would break real runtime behavior:
//  - `/node_modules/...` and `/apps/...` absolute URLs -- third-party packages (three,
//    xstate, mapspinner, jolt-physics) rely on `new URL(asset, import.meta.url)`-style
//    relative resource loading (WASM/workers/GLTF) that requires a real served file
//    location, and /apps/ modules are fetched dynamically per-world at runtime.
//  - `import('/apps/${worldParam}.js')` in app.js -- a runtime-determined path, cannot
//    be statically resolved by a bundler.
//  - AppModuleSystem.js's `import(url)` -- loads arbitrary app module URLs.
//  - BrowserServer.js's `import(url)` where url is a Blob object URL built from
//    fetched source text -- a fully runtime-synthesized module.
//  - client/src/sdk/WorkerEntry.js -- already has its own dedicated bundle
//    (scripts/bundle-worker.mjs) loaded via `new Worker(url, {type:'module'})` in a
//    separate execution context; cannot share a bundle file with the main thread.
// Everything else under client/ that app.js reaches via a relative import (core/,
// hud/, xr/, editor-adjacent client-only helpers) gets inlined.
import { existsSync, statSync, readdirSync, mkdirSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// `--if-stale`: only rebuild when the output is missing or older than the newest file in its input
// tree -- the `prestart` hook (package.json) and the nixpacks build phase run this on every start/
// deploy, so an already-fresh bundle costs one directory walk, not an esbuild pass. Mirrors the
// freshness rule src/sdk/ServerBoot.js buildStaticDirs applies before it will SERVE the bundle, so
// the two never disagree about what "stale" means.
const flags = new Set(process.argv.slice(2).filter(a => a.startsWith('--')))
const positional = process.argv.slice(2).filter(a => !a.startsWith('--'))
const IF_STALE = flags.has('--if-stale')

const SKIP_DIRS = new Set(['node_modules', '.git', '.gm', 'dist', '.glb-cache', '.progressive-cache'])
function newestMtime(dir, exts, out = { max: 0 }) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out.max }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) newestMtime(join(dir, e.name), exts, out); continue }
    if (!exts.has(extname(e.name))) continue
    try { out.max = Math.max(out.max, statSync(join(dir, e.name)).mtimeMs) } catch {}
  }
  return out.max
}
function isFresh(outPath, inputDir, exts) {
  if (!existsSync(outPath)) return false
  return statSync(outPath).mtimeMs >= newestMtime(inputDir, exts)
}

const entry = positional[0] || 'client/app.js'
// Filename MUST be app.js (not app.bundle.js): src/sdk/server.js's buildStaticDirs
// mounts dist/client/ at the same '/' prefix as the raw client/ dir, ahead of it, so
// StaticHandler's per-mount existsSync fallthrough serves this file in place of the
// raw client/app.js only when it exists -- a different filename would never be hit.
// Deliberately NOT content-hashed for the same reason: a hashed filename would never
// match the request the fallthrough intercepts, breaking the zero-index.html-edit
// mechanism entirely. Cache-busting is instead handled by StaticHandler's own
// Cache-Control: no-cache, must-revalidate + mtime-based ETag on .js files (see
// src/sdk/StaticHandler.js) -- every rebuild changes this file's mtime, so the next
// request gets a fresh ETag and revalidates (cheap 304 if unchanged, full fetch if not).
const outfile = positional[1] || 'dist/client/app.js'
const BASE = positional[2] || ''

const _bareToAbs = {
  'xstate': `${BASE}/node_modules/xstate/dist/xstate.esm.js`,
  'msgpackr': `${BASE}/node_modules/msgpackr/index.js`,
  // NOT /node_modules/ -- this package isn't installed locally, index.html's own
  // importmap resolves it straight to the jsdelivr GitHub CDN (see client/index.html).
  // Tracks the design repo's main branch directly (no npm publish exists for this
  // package), in lockstep with client/index.html and client/landing/index.html.
  // Pinned to a specific version/commit, not @latest/@main (perf-unpinned-cdns-off-boot-path):
  // an unpinned CDN reference can silently change spoint's boot bundle on ANY push to the design
  // repo, with no corresponding spoint commit -- keep this in lockstep with client/index.html's
  // matching pins when bumping either.
  'anentrypoint-design': 'https://unpkg.com/anentrypoint-design@1.0.34/dist/247420.js',
  // game-editor-kit: same CDN-delivered-kit class as anentrypoint-design (client/index.html's
  // importmap maps it to the design repo's game-editor-kit component set on jsdelivr) -- external,
  // never bundled, matching the GUI-kit architecture rule that all GUI components live in the
  // AnEntrypoint/design repo. Pinned to a specific commit SHA, not @main, for the same reason.
  'game-editor-kit': 'https://cdn.jsdelivr.net/gh/AnEntrypoint/design@70550868836df5d3c8cd3c85570090ff571edde0/src/components/game-editor-kit/index.js',
  'three-mesh-bvh': `${BASE}/vendor/three-mesh-bvh.module.js`,
  // streaming-gltf's model-pool/draco-loader/occlusion-query-tier live under
  // packages/streaming-gltf/src/ and use `new URL('./sibling.js', import.meta.url)`
  // (e.g. model-pool.js's lod-worker.js Worker construction) to resolve sibling files
  // relative to THEIR OWN real served location -- inlining them into app.js would
  // rewrite import.meta.url to app.js's own URL and break that resolution (a real
  // worker-loading break the bundling task explicitly needs to avoid), so these stay
  // external + served from their real /node_modules/ path exactly like the raw ESM dev flow.
  'streaming-gltf/model-pool': `${BASE}/node_modules/streaming-gltf/src/model-pool.js`,
  'streaming-gltf/draco-loader': `${BASE}/node_modules/streaming-gltf/src/draco-loader.js`,
  'streaming-gltf/occlusion-query-tier': `${BASE}/node_modules/streaming-gltf/src/occlusion-query-tier.js`,
  // octahedral-impostor-ez[-tier]: same reasoning as model-pool/draco-loader above (own
  // `new URL(..., import.meta.url)`-relative asset resolution) -- added when bundle-client.mjs
  // was found to hard-fail on these two specifiers (client/core/VegImpostorTier.js,
  // client/core/Vegetation.js) while wiring the bundle-size perf-gate (a real pre-existing gap,
  // this subpath was added to streaming-gltf after the model-pool/draco-loader/occlusion-query
  // entries above were written and this allowlist was never extended to match).
  'streaming-gltf/octahedral-impostor-ez': `${BASE}/node_modules/streaming-gltf/src/octahedral-impostor-ez.js`,
  'streaming-gltf/octahedral-impostor-ez-tier': `${BASE}/node_modules/streaming-gltf/src/octahedral-impostor-ez-tier.js`,
  'streaming-gltf': `${BASE}/node_modules/streaming-gltf/index.js`,
  // wireweave / nostr-tools: dynamic `import('wireweave')` (client/hud/Chat.js, VoiceIndicator.js,
  // WireweaveBridge.js) and `import('nostr-tools')` (client/ServerBrowser.js) -- both importmap
  // specifiers (client/index.html) that esbuild otherwise hard-fails on ("Could not resolve"),
  // live-witnessed as the reason `node scripts/bundle-client.mjs` had never produced a bundle.
  // Same absolute served paths the importmap remaps them to; external so wireweave's own
  // src/ graph (and its injected nostr-tools peer, see AGENTS.md) load exactly as in raw ESM.
  'wireweave': `${BASE}/node_modules/wireweave/src/index.js`,
  'nostr-tools': `${BASE}/vendor/nostr-tools.mjs`
}
const externalPlugin = {
  name: 'spoint-client-external',
  setup(b) {
    // Already-absolute runtime URLs (dev root or deployed base) -- leave external.
    b.onResolve({ filter: /^\/(spoint\/)?(node_modules|src|apps|data|vendor)\// }, args => ({ path: args.path, external: true }))
    // Bare importmap-bypass deps -> rewrite to the absolute served path, external.
    b.onResolve({ filter: /^(xstate|msgpackr|anentrypoint-design|game-editor-kit|three-mesh-bvh|wireweave|nostr-tools|streaming-gltf(\/model-pool|\/draco-loader|\/occlusion-query-tier|\/octahedral-impostor-ez(-tier)?)?)$/ }, args => ({ path: _bareToAbs[args.path] || args.path, external: true }))
    // three / mapspinner / jolt-physics: any specifier form -- external (own asset resolution).
    b.onResolve({ filter: /^(three|mapspinner|jolt-physics)(\/|$)/ }, args => ({ path: args.path, external: true }))
    // node: builtins reached only via node-guarded dead branches in isomorphic modules.
    b.onResolve({ filter: /^node:/ }, args => ({ path: args.path, external: true }))
    b.onResolve({ filter: /^(fs|path|crypto|url|os|util|stream|events|worker_threads)$/ }, args => ({ path: args.path, external: true }))
  }
}

const outdir = outfile.replace(/\/[^/]+$/, '')
const CLIENT_EXTS = new Set(['.js', '.mjs', '.css'])
const bundleFresh = IF_STALE && isFresh(join(ROOT, outfile), join(ROOT, 'client'), CLIENT_EXTS)
if (bundleFresh) {
  console.log(`[bundle-client] ${outfile} is fresh (newer than every client/ source) -- skipping`)
} else {
  // esbuild is a devDependency: a production install (`npm ci --omit=dev`) without it must still
  // boot -- the server falls through to raw ESM (ServerBoot.js) -- so under --if-stale a missing
  // bundler is a logged skip, never a failed start. An explicit build (no flag) still fails loud.
  let build
  try { ({ build } = await import('esbuild')) } catch (e) {
    if (IF_STALE) { console.warn('[bundle-client] esbuild not installed -- skipping bundle (server serves raw ESM):', e?.message || e); process.exit(0) }
    throw e
  }
  await build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    splitting: true,
    outdir,
    sourcemap: false,
    legalComments: 'none',
    plugins: [externalPlugin],
    logLevel: 'info',
    define: {
      'SPOINT_FEATURE_EDITOR': 'true',
      'SPOINT_FEATURE_VRM': 'true',
      'SPOINT_FEATURE_ANALYTICS': 'false',
      'SPOINT_FEATURE_TELEMETRY': 'false',
      'SPOINT_FEATURE_WEBTRANSPORT': 'false'
    }
  })
  console.log('[bundle-client] wrote', outdir)
}

// Build-time app-source manifest next to the bundle (scripts/bundle-apps-manifest.mjs --all): the
// singleplayer/host BrowserServer fetches it as ONE request in place of its live ~65-fetch dependency
// walk over /apps/* (see client/BrowserServer.js connect()). Served by the same dist/client mount as
// the bundle; ServerBoot.js unlinks it at boot if apps/ has been edited since, so it can never mask a
// live app edit. Same --if-stale rule, keyed on the apps/ tree.
const manifestOut = join(outdir, 'apps-manifest.json')
if (IF_STALE && isFresh(join(ROOT, manifestOut), join(ROOT, 'apps'), new Set(['.js', '.mjs']))) {
  console.log(`[bundle-client] ${manifestOut} is fresh -- skipping`)
} else {
  mkdirSync(join(ROOT, outdir), { recursive: true })
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'bundle-apps-manifest.mjs'), join(ROOT, manifestOut), '--all'], { stdio: 'inherit' })
  if (r.status !== 0) console.warn('[bundle-client] apps manifest generation failed (BrowserServer falls back to its live dependency walk)')
}
