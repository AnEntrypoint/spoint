#!/usr/bin/env node
import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, statSync, readdirSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = import.meta.dirname || dirname(fileURLToPath(import.meta.url))
const SDK_ROOT = join(__dirname, '..')
const PROJECT = process.cwd()

function findPackageDir(pkg) {
  for (const startDir of [SDK_ROOT, PROJECT]) {
    let dir = startDir
    for (let i = 0; i < 12; i++) {
      const candidate = join(dir, 'node_modules', pkg)
      if (existsSync(candidate)) return candidate
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return null
}

const EXCLUDE_RE = /(^|[\\/])\.glb-cache([\\/]|$)|\.test\.js$|(^|[\\/])\.git([\\/]|$)/
const cpFilter = (src) => !EXCLUDE_RE.test(src)
const MIN_INLINED_WORKER_BUNDLE_BYTES = 51200

function parseArgs(argv) {
  const out = { outDir: 'dist-static', base: '' }
  for (const a of argv) {
    if (a.startsWith('--base=')) out.base = a.slice('--base='.length).replace(/\/$/, '')
    else if (!a.startsWith('--')) out.outDir = a
  }
  return out
}

function showHelp() {
  console.log(`
Usage: spoint static-export [outDir] [--base=/subpath]
       node scripts/static-export.mjs [outDir] [--base=/subpath]

Builds a fully static, singleplayer-only export of this spoint game into outDir (default
dist-static/) -- no server process needed at runtime, just any static file host. Use --base
when the host serves the site under a subpath (e.g. GitHub Pages project sites: --base=/my-repo).
Leave --base empty for itch.io (uploaded as a zip, served at its own root) or a custom domain.

Output is ready to zip for itch.io's HTML5 upload, or push directly as a GitHub Pages branch.
The exported page opens at index.html?singleplayer&world=<default world> automatically.
`)
}

function rel(p) { return relative(PROJECT, p) || '.' }

function log(msg) { console.log(`[static-export] ${msg}`) }

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help')) { showHelp(); process.exit(0) }
  const { outDir: outDirArg, base } = parseArgs(argv)
  const OUT = resolve(PROJECT, outDirArg)

  log(`SDK_ROOT=${SDK_ROOT}`)
  log(`PROJECT=${PROJECT}`)
  log(`OUT=${OUT}${base ? ` (base=${base})` : ''}`)

  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  mkdirSync(join(OUT, 'src'), { recursive: true })
  mkdirSync(join(OUT, 'node_modules'), { recursive: true })
  mkdirSync(join(OUT, 'apps'), { recursive: true })

  log('building client bundle...')
  execFileSync(process.execPath, [join(SDK_ROOT, 'scripts/bundle-client.mjs'), join(SDK_ROOT, 'client/app.js'), join(OUT, 'app.js'), ''], { stdio: 'inherit', cwd: SDK_ROOT })

  for (const f of ['index.html', 'style.css', 'manifest.json', 'service-worker.js', 'favicon.svg']) {
    const src = join(SDK_ROOT, 'client', f)
    if (existsSync(src)) cpSync(src, join(OUT, f))
  }
  if (existsSync(join(SDK_ROOT, 'client/vendor'))) cpSync(join(SDK_ROOT, 'client/vendor'), join(OUT, 'vendor'), { recursive: true, filter: cpFilter })

  const SRC_DIRS = ['client', 'protocol', 'shared', 'sdk', 'connection', 'debug', 'netcode', 'physics', 'apps', 'stage', 'storage', 'transport', 'spatial', 'terrain']
  for (const d of SRC_DIRS) {
    const s = join(SDK_ROOT, 'src', d)
    if (existsSync(s)) cpSync(s, join(OUT, 'src', d), { recursive: true, filter: cpFilter })
  }
  for (const f of ['math.js', 'index.client.js']) {
    const s = join(SDK_ROOT, 'src', f)
    if (existsSync(s)) cpSync(s, join(OUT, 'src', f))
  }

  const sdkLib = join(SDK_ROOT, 'apps/_lib')
  if (existsSync(sdkLib)) cpSync(sdkLib, join(OUT, 'apps/_lib'), { recursive: true, filter: cpFilter })
  const projApps = resolve(PROJECT, 'apps')
  const appsSrc = existsSync(projApps) ? projApps : join(SDK_ROOT, 'apps')
  cpSync(appsSrc, join(OUT, 'apps'), { recursive: true, filter: cpFilter })
  log(`apps/ copied from ${rel(appsSrc)}${existsSync(sdkLib) ? ' (+ engine apps/_lib)' : ''}`)

  const appFiles = []
  ;(function walk(dir, prefix) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      const relP = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(full, relP)
      else if (entry.name.endsWith('.js')) appFiles.push(relP)
    }
  })(join(OUT, 'apps'), '')
  writeFileSync(join(OUT, 'apps/apps-fs-manifest.json'), JSON.stringify({ files: appFiles.sort() }))

  log('bundling WorkerEntry module graph...')
  const workerBundleTmp = join(OUT, 'src/sdk/WorkerEntry.bundle.js')
  execFileSync(process.execPath, [join(SDK_ROOT, 'scripts/bundle-worker.mjs'), join(OUT, 'src/sdk/WorkerEntry.js'), workerBundleTmp, ''], { stdio: 'inherit', cwd: SDK_ROOT })
  const bundledBytes = statSync(workerBundleTmp).size
  writeFileSync(join(OUT, 'src/sdk/WorkerEntry.js'), readFileSync(workerBundleTmp))
  rmSync(workerBundleTmp)
  if (bundledBytes < MIN_INLINED_WORKER_BUNDLE_BYTES) {
    console.error(`[static-export] ERROR: WorkerEntry bundle is only ${bundledBytes} bytes (<50KB) -- the SDK graph did not inline. Aborting export.`)
    process.exit(1)
  }
  log(`WorkerEntry bundled -> ${bundledBytes} bytes`)

  const PACKAGES = ['three', '@pixiv/three-vrm', 'webjsx', 'msgpackr', 'meshoptimizer', 'jolt-physics', 'xstate',
    '@dgreenheck/ez-tree', '@three.ez/instanced-mesh', 'bvh.js', 'mapspinner', 'streaming-gltf']
  let missingPkgs = []
  for (const pkg of PACKAGES) {
    const src = findPackageDir(pkg)
    if (!src) { missingPkgs.push(pkg); continue }
    const dest = join(OUT, 'node_modules', pkg)
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(src, dest, { recursive: true, dereference: true, filter: cpFilter })
  }
  if (missingPkgs.length) log(`WARNING: could not locate node_modules for: ${missingPkgs.join(', ')} -- export will 404 on these at runtime`)
  for (const nested of ['streaming-gltf/node_modules', 'mapspinner/node_modules']) {
    const p = join(OUT, 'node_modules', nested)
    if (existsSync(p)) rmSync(p, { recursive: true, force: true })
  }

  if (base) {
    log(`patching absolute paths for base "${base}"...`)
    patchBase(OUT, base)
  }

  log(`done -- static export at ${rel(OUT)}/`)
  log(`Open ${OUT}/index.html via any static file server (it auto-redirects to ?singleplayer&world=<default>), or zip ${rel(OUT)}/ for itch.io.`)
}

function patchBase(dir, base) {
  const files = []
  ;(function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(js|mjs|html|json)$/.test(entry.name)) files.push(full)
    }
  })(dir)
  for (const f of files) {
    let content = readFileSync(f, 'utf8')
    const before = content
    const htmlAttrAlt = /\.html$/.test(f) ? '|href="\\/|src="\\/' : ''
    const re = new RegExp(`(["'\`])\\/node_modules\\/|(["'\`])\\/src\\/|(["'\`])\\/apps\\/|(["'\`])\\/vendor\\/|(["'\`])\\/data\\/${htmlAttrAlt}`, 'g')
    content = content.replace(re, (m) => {
      if (m.startsWith('href="')) return `href="${base}/`
      if (m.startsWith('src="')) return `src="${base}/`
      const quote = m[0]
      const seg = m.slice(1)
      return `${quote}${base}${seg}`
    })
    if (content !== before) writeFileSync(f, content)
  }
}

main().catch(err => { console.error('[static-export] FAILED:', err); process.exit(1) })
