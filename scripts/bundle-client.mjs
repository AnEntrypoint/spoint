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
import { build } from 'esbuild'

const entry = process.argv[2] || 'client/app.js'
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
const outfile = process.argv[3] || 'dist/client/app.js'
const BASE = process.argv[4] || ''

const _bareToAbs = {
  'xstate': `${BASE}/node_modules/xstate/dist/xstate.esm.js`,
  'msgpackr': `${BASE}/node_modules/msgpackr/index.js`,
  // NOT /node_modules/ -- this package isn't installed locally, index.html's own
  // importmap resolves it straight to the jsdelivr GitHub CDN (see client/index.html).
  // Tracks the design repo's main branch directly (no npm publish exists for this
  // package), in lockstep with client/index.html and client/landing/index.html.
  'anentrypoint-design': 'https://unpkg.com/anentrypoint-design@latest/dist/247420.js',
  // game-editor-kit: same CDN-delivered-kit class as anentrypoint-design (client/index.html's
  // importmap maps it to the design repo's game-editor-kit component set on jsdelivr) -- external,
  // never bundled, matching the GUI-kit architecture rule that all GUI components live in the
  // AnEntrypoint/design repo.
  'game-editor-kit': 'https://cdn.jsdelivr.net/gh/AnEntrypoint/design@main/src/components/game-editor-kit/index.js',
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
  'streaming-gltf': `${BASE}/node_modules/streaming-gltf/index.js`
}
const externalPlugin = {
  name: 'spoint-client-external',
  setup(b) {
    // Already-absolute runtime URLs (dev root or deployed base) -- leave external.
    b.onResolve({ filter: /^\/(spoint\/)?(node_modules|src|apps|data|vendor)\// }, args => ({ path: args.path, external: true }))
    // Bare importmap-bypass deps -> rewrite to the absolute served path, external.
    b.onResolve({ filter: /^(xstate|msgpackr|anentrypoint-design|game-editor-kit|three-mesh-bvh|streaming-gltf(\/model-pool|\/draco-loader|\/occlusion-query-tier|\/octahedral-impostor-ez(-tier)?)?)$/ }, args => ({ path: _bareToAbs[args.path] || args.path, external: true }))
    // three / mapspinner / jolt-physics: any specifier form -- external (own asset resolution).
    b.onResolve({ filter: /^(three|mapspinner|jolt-physics)(\/|$)/ }, args => ({ path: args.path, external: true }))
    // node: builtins reached only via node-guarded dead branches in isomorphic modules.
    b.onResolve({ filter: /^node:/ }, args => ({ path: args.path, external: true }))
    b.onResolve({ filter: /^(fs|path|crypto|url|os|util|stream|events|worker_threads)$/ }, args => ({ path: args.path, external: true }))
  }
}

await build({
  entryPoints: [entry],
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile,
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
console.log('[bundle-client] wrote', outfile)
