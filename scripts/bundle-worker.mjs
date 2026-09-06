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
import { existsSync, statSync, readdirSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// `--if-stale` / freshness walk: same contract as bundle-client.mjs (see its comment) -- rebuild only
// when the output is missing or older than the newest file under src/ (the tree this bundle inlines),
// matching the rule src/sdk/ServerBoot.js buildStaticDirs applies before serving it.
const flags = new Set(process.argv.slice(2).filter(a => a.startsWith('--')))
const positional = process.argv.slice(2).filter(a => !a.startsWith('--'))
const IF_STALE = flags.has('--if-stale')
const SKIP_DIRS = new Set(['node_modules', '.git', '.gm', 'dist'])
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

const entry = positional[0] || 'src/sdk/WorkerEntry.js'
// Default output name is WorkerEntry.js (not .bundle.js) under dist/src/sdk/ so ServerBoot.js's
// dist/src mount (listed ahead of the raw src/ mount at the same '/src/' prefix) serves it at the
// exact URL client/BrowserServer.js already spawns the Worker from -- no client-side URL switch, and
// `new URL(..., import.meta.url)` inside the worker resolves identically to the raw file.
const outfile = positional[1] || 'dist/src/sdk/WorkerEntry.js'
// Deployed base for absolute runtime specifiers; '' for a local/dev bundle that
// the dev StaticHandler serves from the SDK root.
const BASE = positional[2] || ''

if (IF_STALE && existsSync(join(ROOT, outfile)) && statSync(join(ROOT, outfile)).mtimeMs >= newestMtime(join(ROOT, 'src'), new Set(['.js', '.mjs']))) {
  console.log(`[bundle-worker] ${outfile} is fresh (newer than every src/ source) -- skipping`)
  process.exit(0)
}
let build
try { ({ build } = await import('esbuild')) } catch (e) {
  if (IF_STALE) { console.warn('[bundle-worker] esbuild not installed -- skipping bundle (server serves the raw ESM worker):', e?.message || e); process.exit(0) }
  throw e
}

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
