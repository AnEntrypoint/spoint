#!/usr/bin/env node
import { existsSync, statSync, readdirSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const flags = new Set(process.argv.slice(2).filter(a => a.startsWith('--')))
const positional = process.argv.slice(2).filter(a => !a.startsWith('--'))
const IF_STALE = flags.has('--if-stale')
const MINIFY = !flags.has('--no-minify')

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
const CLIENT_EXTS = new Set(['.js', '.mjs', '.css'])
const hashOut = join(outdir, 'app.bundlehash.json')
const SELF_SOURCE = fileURLToPath(import.meta.url)

function collectInputs(dir, rel = '', out = []) {
  let entries
  try { entries = readdirSync(join(dir, rel), { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const child = rel ? join(rel, e.name) : e.name
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) collectInputs(dir, child, out); continue }
    if (!CLIENT_EXTS.has(extname(e.name))) continue
    out.push(child)
  }
  return out
}

function inputsHash() {
  const h = createHash('sha256')
  h.update(readFileSync(SELF_SOURCE))
  for (const rel of collectInputs(join(ROOT, 'client')).sort()) {
    h.update(rel)
    h.update(readFileSync(join(ROOT, 'client', rel)))
  }
  return h.digest('hex')
}

function readStamp() {
  try { return JSON.parse(readFileSync(resolve(ROOT, hashOut), 'utf8')).hash ?? null } catch { return null }
}

const WANT_HASH = inputsHash()
if (flags.has('--check')) {
  const got = readStamp()
  if (got !== WANT_HASH) {
    console.error(`[bundle-client] ${hashOut} is stale: stamped ${got ?? '(none)'} but inputs hash to ${WANT_HASH}`)
    process.exit(1)
  }
  console.log(`[bundle-client] ${hashOut} matches inputs (${WANT_HASH.slice(0, 16)})`)
  process.exit(0)
}

const bundleFresh = IF_STALE && readStamp() === WANT_HASH && isFresh(resolve(ROOT, outfile), join(ROOT, 'client'), CLIENT_EXTS)
if (bundleFresh) {
  console.log(`[bundle-client] ${outfile} is fresh (newer than every client/ source) -- skipping`)
} else {
  let build
  try { ({ build } = await import('esbuild')) } catch (e) {
    if (IF_STALE) { console.warn('[bundle-client] esbuild not installed -- skipping bundle (server serves raw ESM):', e?.message || e); process.exit(0) }
    throw e
  }
  await build({
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
  writeFileSync(resolve(ROOT, hashOut), JSON.stringify({ hash: WANT_HASH, builtAt: new Date().toISOString() }) + '\n')
  console.log('[bundle-client] stamped', hashOut, WANT_HASH.slice(0, 16))
}

const manifestOut = join(outdir, 'apps-manifest.json')
if (IF_STALE && isFresh(resolve(ROOT, manifestOut), join(ROOT, 'apps'), new Set(['.js', '.mjs']))) {
  console.log(`[bundle-client] ${manifestOut} is fresh -- skipping`)
} else {
  mkdirSync(resolve(ROOT, outdir), { recursive: true })
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'bundle-apps-manifest.mjs'), resolve(ROOT, manifestOut), '--all'], { stdio: 'inherit' })
  if (r.status !== 0) console.warn('[bundle-client] apps manifest generation failed (BrowserServer falls back to its live dependency walk)')
}
