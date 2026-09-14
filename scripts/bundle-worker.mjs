#!/usr/bin/env node
import { existsSync, statSync, readdirSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
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
const outfile = positional[1] || 'dist/src/sdk/WorkerEntry.js'
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

const _bareToAbs = {
  'xstate': `${BASE}/node_modules/xstate/dist/xstate.esm.js`,
  'msgpackr': `${BASE}/node_modules/msgpackr/index.js`,
  'jolt-physics/wasm-compat': `${BASE}/node_modules/jolt-physics/dist/jolt-physics.wasm-compat.js`
}
const externalPlugin = {
  name: 'spoint-external',
  setup(b) {
    b.onResolve({ filter: /^\/(spoint\/)?(node_modules|src|apps)\// }, args => ({ path: args.path, external: true }))
    b.onResolve({ filter: /^(xstate|msgpackr|jolt-physics\/wasm-compat)$/ }, args => ({ path: _bareToAbs[args.path] || args.path, external: true }))
    b.onResolve({ filter: /jolt-physics/ }, args => ({ path: args.path, external: true }))
    b.onResolve({ filter: /^node:/ }, args => ({ path: args.path, external: true }))
    b.onResolve({ filter: /^(fs|path|crypto|url|os|util|stream|events|worker_threads)$/ }, args => ({ path: args.path, external: true }))
    b.onResolve({ filter: /draco3dgltf|draco3d/ }, args => ({ path: args.path, external: true }))
    b.onResolve({ filter: /^sharp$/ }, args => ({ path: args.path, external: true }))
    b.onResolve({ filter: /^@gltf-transform\// }, args => ({ path: args.path, external: true }))
    b.onResolve({ filter: /^mapspinner\/(height-cpu|patch-baker)$/ }, args => ({ path: args.path, external: true }))
    b.onResolve({ filter: /^streaming-gltf\/bake$/ }, args => ({ path: args.path, external: true }))
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
