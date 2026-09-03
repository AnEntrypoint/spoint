#!/usr/bin/env node
// Build-time only: bundle the WorkerEntry static SDK import graph into one
// cacheable artifact so the deployed gh-pages module Worker loads a single file
// instead of fetching ~20 dependency-ordered modules over the network (per-file
// RTT dominates cold gh-pages boot). Dynamic imports the worker resolves itself
// at runtime stay EXTERNAL: the Jolt browser build (jolt-physics.wasm.js, whose
// `new URL(...wasm, import.meta.url)` must resolve relative to a real served URL,
// not the bundle) and anything imported by an absolute `/node_modules/` or `/src/`
// specifier. Node-only branches (jolt-physics/wasm-compat, node: builtins) are
// also external so the browser bundle never pulls them.
import { build } from 'esbuild'

const entry = process.argv[2] || 'src/sdk/WorkerEntry.js'
const outfile = process.argv[3] || 'dist/src/sdk/WorkerEntry.bundle.js'
// Deployed base for absolute runtime specifiers; '' for a local/dev bundle that
// the dev StaticHandler serves from the SDK root.
const BASE = process.argv[4] || ''

// INLINE the relative SDK module graph; keep as runtime-external only what the
// worker must fetch itself: the absolute /[base/]node_modules + /src + /apps URLs,
// the Jolt builds (their `new URL(...wasm)` must resolve to a served URL), the bare
// importmap-bypass deps (rewritten here to absolute so no post-bundle sed is
// needed), and the node:*/draco branches that are process.versions?.node-dead in
// the browser. Run this BEFORE the gh-pages path-patch step so the relative SDK
// imports still resolve to disk and actually inline.
const _bareToAbs = {
  'xstate': `${BASE}/node_modules/xstate/dist/xstate.esm.js`,
  'msgpackr': `${BASE}/node_modules/msgpackr/index.js`,
  'jolt-physics/wasm-compat': `${BASE}/node_modules/jolt-physics/dist/jolt-physics.wasm-compat.js`
}
const externalPlugin = {
  name: 'spoint-external',
  setup(b) {
    // Already-absolute runtime URLs (dev root or deployed base) — leave external.
    b.onResolve({ filter: /^\/(spoint\/)?(node_modules|src|apps)\// }, args => ({ path: args.path, external: true }))
    // Bare importmap-bypass deps -> rewrite to the absolute served path, external.
    b.onResolve({ filter: /^(xstate|msgpackr|jolt-physics\/wasm-compat)$/ }, args => ({ path: _bareToAbs[args.path] || args.path, external: true }))
    // Any other jolt-physics specifier (the browser streaming build is referenced by
    // an absolute path the first rule already caught) — external.
    b.onResolve({ filter: /jolt-physics/ }, args => ({ path: args.path, external: true }))
    // node: builtins + bare node builtins reached only via node-guarded dead branches.
    b.onResolve({ filter: /^node:/ }, args => ({ path: args.path, external: true }))
    b.onResolve({ filter: /^(fs|path|crypto|url|os|util|stream|events|worker_threads)$/ }, args => ({ path: args.path, external: true }))
    // Node-only draco (bake-time, node-guarded) imports fs/path — external.
    b.onResolve({ filter: /draco3dgltf|draco3d/ }, args => ({ path: args.path, external: true }))
    // Node-only sharp (GLBKtx2.js's lazy `import('sharp')`, bake-time/node-guarded, never runs
    // in the browser worker) transitively requires detect-libc -> child_process; that reaches
    // esbuild's static dynamic-import resolution regardless of the runtime guard, so it must be
    // externalized explicitly like draco above rather than left to fail deep in a sub-dependency.
    b.onResolve({ filter: /^sharp$/ }, args => ({ path: args.path, external: true }))
    // Node-only @gltf-transform/* (GLBDraco.js's top-level import of GLBTransformer.js's
    // bake-time Draco-strip/meshopt-compress helpers, plus GLBVrmPassthrough.js's top-level
    // `import { Extension } from '@gltf-transform/core'`) is a real Node-only devDep never
    // invoked in the browser worker, but reached statically once src/static/ is present in
    // dist/ — external like draco/sharp above rather than left to fail unresolved.
    b.onResolve({ filter: /^@gltf-transform\// }, args => ({ path: args.path, external: true }))
    // Node-only mapspinner bare specifiers (TerrainPhysics.js's `_isNode ? 'mapspinner/height-cpu' : ...`
    // and `... 'mapspinner/patch-baker' : ...` branches) — the browser half of that ternary is an
    // already-absolute /node_modules/ URL the first rule catches, but esbuild's static import-graph
    // walk still resolves the Node-only bare specifier too; external like the other bake-time deps.
    b.onResolve({ filter: /^mapspinner\/(height-cpu|patch-baker)$/ }, args => ({ path: args.path, external: true }))
    // Node-only streaming-gltf/bake (ProgressiveBake.js's bake-time `await import('streaming-gltf/bake')`,
    // never invoked in the browser worker) — external, same class as the other bake-time subpaths above.
    b.onResolve({ filter: /^streaming-gltf\/bake$/ }, args => ({ path: args.path, external: true }))
    // Node-only meshoptimizer (GLBDraco.js's bake-time `await import('meshoptimizer')` calls) — external,
    // same class as sharp/draco3d/@gltf-transform above.
    b.onResolve({ filter: /^meshoptimizer$/ }, args => ({ path: args.path, external: true }))
  }
}

await build({
  entryPoints: [entry],
  bundle: true,
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
console.log('[bundle-worker] wrote', outfile)
