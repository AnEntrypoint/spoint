#!/usr/bin/env node
import { existsSync, statSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, extname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const flags = new Set(process.argv.slice(2).filter(a => a.startsWith('--')))
const positional = process.argv.slice(2).filter(a => !a.startsWith('--'))
const IF_STALE = flags.has('--if-stale')
const SKIP_DIRS = new Set(['node_modules', '.git', '.gm', 'dist'])
const GRAPH_EXTS = new Set(['.js', '.mjs'])

const entry = positional[0] || 'src/sdk/WorkerEntry.js'
const outfile = positional[1] || 'dist/src/sdk/WorkerEntry.js'
const BASE = positional[2] || ''
const hashOut = join(dirname(outfile), 'WorkerEntry.bundlehash.json')
const SELF_SOURCE = fileURLToPath(import.meta.url)

function packageSrcDirs() {
  const out = []
  try {
    for (const e of readdirSync(join(ROOT, 'packages'), { withFileTypes: true })) {
      if (e.isDirectory()) out.push(join('packages', e.name, 'src'))
    }
  } catch {}
  return out
}
const GRAPH_DIRS = ['src', ...packageSrcDirs()]

function collectInputs(dir, rel = '', out = []) {
  let entries
  try { entries = readdirSync(join(dir, rel), { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const child = rel ? join(rel, e.name) : e.name
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) collectInputs(join(dir, e.name), child, out); continue }
    if (!GRAPH_EXTS.has(extname(e.name))) continue
    out.push(child)
  }
  return out
}

function relInputs(dirRel) {
  return collectInputs(join(ROOT, dirRel)).map(r => `${dirRel}/${r}`.replace(/\\/g, '/')).sort()
}

function inGraphDirs(rel) {
  return GRAPH_DIRS.some(d => rel === d || rel.startsWith(d + '/'))
}

function hashInputs(recorded) {
  const h = createHash('sha256')
  h.update(readFileSync(SELF_SOURCE))
  for (const dir of GRAPH_DIRS) {
    for (const rel of relInputs(dir)) {
      h.update(rel)
      h.update(readFileSync(join(ROOT, rel)))
    }
  }
  for (const rel of (recorded || []).slice().sort()) {
    if (inGraphDirs(rel)) continue
    const abs = join(ROOT, rel)
    if (!existsSync(abs)) return `missing-input:${rel}`
    h.update(rel)
    h.update(readFileSync(abs))
  }
  return h.digest('hex')
}

function readStamp() {
  try { return JSON.parse(readFileSync(resolve(ROOT, hashOut), 'utf8')) } catch { return null }
}

function newestRecordedMtime(recorded) {
  return (recorded || []).reduce((max, rel) => {
    try { return Math.max(max, statSync(join(ROOT, rel)).mtimeMs) } catch { return max }
  }, 0)
}

const stamp = readStamp()
let WANT_HASH = hashInputs(stamp?.inputs)
if (flags.has('--check')) {
  const got = stamp?.hash ?? null
  if (got !== WANT_HASH) {
    console.error(`[bundle-worker] ${hashOut} is stale: stamped ${got ?? '(none)'} but inputs hash to ${WANT_HASH}`)
    process.exit(1)
  }
  console.log(`[bundle-worker] ${hashOut} matches inputs (${WANT_HASH.slice(0, 16)})`)
  process.exit(0)
}

if (IF_STALE && existsSync(join(ROOT, outfile)) && stamp?.hash === WANT_HASH && statSync(join(ROOT, outfile)).mtimeMs >= newestRecordedMtime(stamp?.inputs)) {
  console.log(`[bundle-worker] ${outfile} is fresh (newer than every bundled input) -- skipping`)
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

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile,
  sourcemap: false,
  legalComments: 'none',
  plugins: [externalPlugin],
  metafile: true,
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
const graphInputs = Object.keys(result?.metafile?.inputs || {})
  .map(p => relative(ROOT, p).replace(/\\/g, '/'))
  .filter(p => p && !p.startsWith('..'))
  .sort()
WANT_HASH = hashInputs(graphInputs)
mkdirSync(dirname(resolve(ROOT, hashOut)), { recursive: true })
writeFileSync(resolve(ROOT, hashOut), JSON.stringify({ hash: WANT_HASH, builtAt: new Date().toISOString(), watchDirs: GRAPH_DIRS, inputs: graphInputs }) + '\n')
console.log(`[bundle-worker] stamped ${hashOut} ${WANT_HASH.slice(0, 16)} (${graphInputs.length} bundled inputs)`)
