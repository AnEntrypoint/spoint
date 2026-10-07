#!/usr/bin/env node
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleInputHash, fileSha256, workerHashSpec } from '../src/sdk/bundleFreshness.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const flags = new Set(process.argv.slice(2).filter(a => a.startsWith('--')))
const positional = process.argv.slice(2).filter(a => !a.startsWith('--'))
const IF_STALE = flags.has('--if-stale')

const entry = positional[0] || 'src/sdk/WorkerEntry.js'
const outfile = positional[1] || 'dist/src/sdk/WorkerEntry.js'
const BASE = positional[2] || ''
const hashOut = join(dirname(outfile), 'WorkerEntry.bundlehash.json')
const HASH_SPEC = workerHashSpec(ROOT)

function hashInputs(recorded) {
  return bundleInputHash(ROOT, HASH_SPEC, recorded)
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

const artifactPath = resolve(ROOT, outfile)
const artifactMatchesStamp = existsSync(artifactPath) && typeof stamp?.outputSha === 'string' && stamp.outputSha === fileSha256(artifactPath)
if (IF_STALE && artifactMatchesStamp && stamp?.hash === WANT_HASH && statSync(artifactPath).mtimeMs >= newestRecordedMtime(stamp?.inputs)) {
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
const outputSha = fileSha256(artifactPath)
mkdirSync(dirname(resolve(ROOT, hashOut)), { recursive: true })
writeFileSync(resolve(ROOT, hashOut), JSON.stringify({ hash: WANT_HASH, builtAt: new Date().toISOString(), outputSha, outputBytes: statSync(artifactPath).size, watchDirs: HASH_SPEC.contentDirs.map(d => d.dir), inputs: graphInputs }) + '\n')
console.log(`[bundle-worker] stamped ${hashOut} ${WANT_HASH.slice(0, 16)} (${graphInputs.length} bundled inputs, artifact ${outputSha.slice(0, 16)})`)
