#!/usr/bin/env node
import { existsSync, statSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { bundleInputHash, clientHashSpec, fileSha256 } from '../src/sdk/bundleFreshness.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const flags = new Set(process.argv.slice(2).filter(a => a.startsWith('--')))
const positional = process.argv.slice(2).filter(a => !a.startsWith('--'))
const IF_STALE = flags.has('--if-stale')
const MINIFY = !flags.has('--no-minify')

const entry = positional[0] || 'client/app.js'
const outfile = positional[1] || 'dist/client/app.js'
const BASE = positional[2] || ''

const _bareToAbs = {
  'xstate': `${BASE}/node_modules/xstate/dist/xstate.esm.js`,
  'msgpackr': `${BASE}/node_modules/msgpackr/index.js`,
  'anentrypoint-design': 'https://unpkg.com/anentrypoint-design@1.0.34/dist/247420.js',
  'game-editor-kit': 'https://cdn.jsdelivr.net/gh/AnEntrypoint/design@08cfcc69e01d49d4c722a154a1ba0ac891792fdd/src/components/game-editor-kit/index.js',
  'three-mesh-bvh': `${BASE}/vendor/three-mesh-bvh.module.js`,
  'streaming-gltf/model-pool': `${BASE}/node_modules/streaming-gltf/src/model-pool.js`,
  'streaming-gltf/draco-loader': `${BASE}/node_modules/streaming-gltf/src/draco-loader.js`,
  'streaming-gltf/occlusion-query-tier': `${BASE}/node_modules/streaming-gltf/src/occlusion-query-tier.js`,
  'streaming-gltf/octahedral-impostor-ez': `${BASE}/node_modules/streaming-gltf/src/octahedral-impostor-ez.js`,
  'streaming-gltf/octahedral-impostor-ez-tier': `${BASE}/node_modules/streaming-gltf/src/octahedral-impostor-ez-tier.js`,
  'streaming-gltf/octahedral-impostor-display-tsl': `${BASE}/node_modules/streaming-gltf/src/octahedral-impostor-display-tsl.js`,
  'streaming-gltf': `${BASE}/node_modules/streaming-gltf/index.js`,
  'wireweave': `${BASE}/node_modules/wireweave/src/index.js`,
  'nostr-tools': `${BASE}/vendor/nostr-tools.mjs`
}
const externalPlugin = {
  name: 'spoint-client-external',
  setup(b) {
    b.onResolve({ filter: /^\/(spoint\/)?(node_modules|src|apps|data|vendor)\// }, args => ({ path: args.path, external: true }))
    b.onResolve({ filter: /^(xstate|msgpackr|anentrypoint-design|game-editor-kit|three-mesh-bvh|wireweave|nostr-tools|streaming-gltf(\/model-pool|\/draco-loader|\/occlusion-query-tier|\/octahedral-impostor-ez(-tier)?|\/octahedral-impostor-display-tsl)?)$/ }, args => ({ path: _bareToAbs[args.path] || args.path, external: true }))
    b.onResolve({ filter: /^(three|mapspinner|jolt-physics)(\/|$)/ }, args => ({ path: args.path, external: true }))
    b.onResolve({ filter: /^node:/ }, args => ({ path: args.path, external: true }))
    b.onResolve({ filter: /^(fs|path|crypto|url|os|util|stream|events|worker_threads)$/ }, args => ({ path: args.path, external: true }))
  }
}

const outdir = dirname(outfile)
const hashOut = join(outdir, 'app.bundlehash.json')
const HASH_SPEC = clientHashSpec()

function hashInputs(recorded) {
  return bundleInputHash(ROOT, HASH_SPEC, recorded)
}

function readStamp() {
  try { return JSON.parse(readFileSync(resolve(ROOT, hashOut), 'utf8')) } catch { return null }
}

const stamp = readStamp()
let WANT_HASH = hashInputs(stamp?.inputs)
if (flags.has('--check')) {
  const got = stamp?.hash ?? null
  if (got !== WANT_HASH) {
    console.error(`[bundle-client] ${hashOut} is stale: stamped ${got ?? '(none)'} but inputs hash to ${WANT_HASH}`)
    process.exit(1)
  }
  console.log(`[bundle-client] ${hashOut} matches inputs (${WANT_HASH.slice(0, 16)})`)
  process.exit(0)
}

const artifactPath = resolve(ROOT, outfile)
const artifactMatchesStamp = existsSync(artifactPath) && typeof stamp?.outputSha === 'string' && stamp.outputSha === fileSha256(artifactPath)
const bundleFresh = IF_STALE && artifactMatchesStamp && stamp?.hash === WANT_HASH
if (bundleFresh) {
  console.log(`[bundle-client] ${outfile} is fresh (stamp matches the current inputs and artifact) -- skipping`)
} else {
  let build
  try { ({ build } = await import('esbuild')) } catch (e) {
    if (IF_STALE) { console.warn('[bundle-client] esbuild not installed -- skipping bundle (server serves raw ESM):', e?.message || e); process.exit(0) }
    throw e
  }
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    minify: MINIFY,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    splitting: true,
    outdir,
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
  console.log('[bundle-client] wrote', outdir)
  mkdirSync(resolve(ROOT, outdir), { recursive: true })
  const graphInputs = Object.keys(result?.metafile?.inputs || {})
    .map(p => relative(ROOT, p).replace(/\\/g, '/'))
    .filter(p => p && !p.startsWith('..'))
    .sort()
  WANT_HASH = hashInputs(graphInputs)
  const outputSha = fileSha256(artifactPath)
  writeFileSync(resolve(ROOT, hashOut), JSON.stringify({ hash: WANT_HASH, builtAt: new Date().toISOString(), outputSha, outputBytes: statSync(artifactPath).size, inputs: graphInputs }) + '\n')
  console.log(`[bundle-client] stamped ${hashOut} ${WANT_HASH.slice(0, 16)} (${graphInputs.length} bundled inputs, artifact ${outputSha.slice(0, 16)})`)
}

const manifestOut = join(outdir, 'apps-manifest.json')
mkdirSync(resolve(ROOT, outdir), { recursive: true })
const manifestBuild = spawnSync(process.execPath, [join(ROOT, 'scripts', 'bundle-apps-manifest.mjs'), resolve(ROOT, manifestOut), '--all', '--if-changed'], { stdio: 'inherit' })
if (manifestBuild.status !== 0) console.warn('[bundle-client] apps manifest generation failed (BrowserServer falls back to its live dependency walk)')
