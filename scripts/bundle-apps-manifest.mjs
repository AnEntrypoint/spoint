#!/usr/bin/env node
// Edge deploy step 2 (edge-cf-worker-app-bundle-static-source-loadfromstring): build-time app-source
// bundling for src/sdk/WorkerEntry.js's init({apps}) -> AppLoader.loadFromString(name, source, deps) path.
//
// A Cloudflare Worker has NO runtime filesystem at all (not even a virtual one), so AppLoader.js's
// loadAll() (real fs.readdir/fs.watch disk scan, Node-server-only) cannot run there -- but
// loadFromString(name, source, deps) already exists and is exactly the fs-free path WorkerEntry.js uses
// TODAY for singleplayer (see client/BrowserServer.js's connect(), which builds this same {name, source,
// deps} shape at CONNECT time via a live fetch()+URL-resolve walk). This script does the identical
// dependency-resolution walk (same regex, same recursive {spec: source|{source,deps}} shape
// AppLoader.js._rewriteDeps expects) but reads from disk at BUILD time instead of fetching at runtime,
// so an edge Worker's bundle can `import manifest from './apps-manifest.json'` and pass manifest.apps
// straight into WorkerEntry's init({apps}) unchanged -- zero AppLoader.js/WorkerEntry.js changes needed.
//
// Usage: node scripts/bundle-apps-manifest.mjs [outFile] [--apps=a,b,c] [--world=<name>] [--all] [--check]
//   outFile   default: apps-manifest.json (repo-root-relative or absolute)
//   --apps=   explicit comma-separated app name list (skips worldDef/directory resolution entirely)
//   --world=  world module to source app names from (apps/world/<name>.js's entities[].app +
//             placeableApps + trustedApps)
//   --all     scan all ./apps subdirectories and top-level app files (default when neither --apps nor --world is given)
//   --check   validate if existing manifest file matches generated manifest, exit 1 if out of sync
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = import.meta.dirname || dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

function parseArgs(argv) {
  const out = { outFile: 'apps-manifest.json', apps: null, world: null, all: false, check: false }
  for (const a of argv) {
    if (a.startsWith('--apps=')) out.apps = a.slice('--apps='.length).split(',').map(s => s.trim()).filter(Boolean)
    else if (a.startsWith('--world=')) out.world = a.slice('--world='.length)
    else if (a === '--all') out.all = true
    else if (a === '--check') out.check = true
    else if (!a.startsWith('--')) out.outFile = a
  }
  if (!out.apps && !out.world) out.all = true
  return out
}

function log(msg) { console.log(`[bundle-apps-manifest] ${msg}`) }

// Resolves an app name to its entry-point index.js exactly like AppLoader.js's own _resolvePath: a flat
// apps/<name>.js file, or an apps/<name>/index.js folder module -- flat file checked first, matching
// AppLoader.js's own precedence.
function resolveAppEntry(name) {
  const flat = join(ROOT, 'apps', `${name}.js`)
  if (existsSync(flat)) return flat
  const folder = join(ROOT, 'apps', name, 'index.js')
  if (existsSync(folder)) return folder
  return null
}

function resolveAllApps() {
  const appsDir = join(ROOT, 'apps')
  const SKIP = new Set(['world', '_lib', 'maps', 'node_modules', '.git', '.gm'])
  const names = new Set()
  const entries = readdirSync(appsDir, { withFileTypes: true })
  for (const ent of entries) {
    if (ent.name.startsWith('.') || SKIP.has(ent.name)) continue
    if (ent.isDirectory()) {
      if (existsSync(join(appsDir, ent.name, 'index.js'))) {
        names.add(ent.name)
      }
    } else if (ent.isFile() && ent.name.endsWith('.js')) {
      names.add(ent.name.slice(0, -3))
    }
  }
  return [...names].sort()
}

// Mirrors client/BrowserServer.js's _resolveRelativeDeps exactly: same regex (relative from/import
// specifiers only -- bare specifiers like 'three' are intentionally left unresolved, same as the live
// runtime path, since those resolve via the Worker's own node_modules bridge / import map, not via
// loadFromString's deps rewrite), same recursive {spec: source|{source,deps}} output shape
// AppLoader.js._rewriteDeps consumes, same seen-map cycle/dedup guard -- but resolves specifiers against
// the real filesystem instead of fetch(), since this runs at build time with real disk access.
function resolveRelativeDeps(source, baseFileUrl, seen) {
  const re = /(?:from|import)\s*['"](\.[^'"]+)['"]/g
  const out = {}
  let m
  while ((m = re.exec(source)) !== null) {
    const spec = m[1]
    if (out[spec] !== undefined) continue
    const u = new URL(spec, baseFileUrl)
    const filePath = fileURLToPath(u)
    if (seen.has(u.href)) { out[spec] = seen.get(u.href).source; continue }
    if (!existsSync(filePath)) { out[spec] = null; continue }
    const src = readFileSync(filePath, 'utf8')
    const entry = { source: src, deps: {} }
    seen.set(u.href, entry)
    entry.deps = resolveRelativeDeps(src, u, seen)
    out[spec] = { source: src, deps: entry.deps }
  }
  return out
}

function bundleApp(name) {
  const entry = resolveAppEntry(name)
  if (!entry) { log(`WARNING: app "${name}" not found under apps/ (checked apps/${name}.js and apps/${name}/index.js) -- skipped`); return null }
  const source = readFileSync(entry, 'utf8')
  const baseUrl = pathToFileURL(entry)
  const deps = resolveRelativeDeps(source, baseUrl, new Map())
  return { name, source, deps }
}

async function resolveAppNamesFromWorld(worldName) {
  const worldFile = join(ROOT, 'apps/world', `${worldName}.js`)
  if (!existsSync(worldFile)) throw new Error(`world module not found: ${worldFile}`)
  const mod = await import(pathToFileURL(worldFile).href)
  const worldDef = mod.default || mod
  // Same three fields + de-dupe as client/BrowserServer.js's connect(): entities[].app,
  // placeableApps, trustedApps.
  return [...new Set([
    ...((worldDef.entities || []).map(e => e.app).filter(Boolean)),
    ...((worldDef.placeableApps || [])),
    ...((worldDef.trustedApps || []))
  ])]
}

async function main() {
  const argv = process.argv.slice(2)
  const { outFile, apps: explicitApps, world, all, check } = parseArgs(argv)
  const OUT = resolve(ROOT, outFile)

  let appNames
  if (explicitApps) appNames = explicitApps
  else if (world) appNames = await resolveAppNamesFromWorld(world)
  else appNames = resolveAllApps()

  log(`resolving ${appNames.length} app(s)${explicitApps ? ' (explicit --apps list)' : world ? ` from apps/world/${world}.js` : ' (all ./apps directories)'}: ${appNames.join(', ')}`)

  const apps = appNames.map(bundleApp).filter(Boolean)
  const failedCount = appNames.length - apps.length
  if (failedCount) log(`WARNING: ${failedCount} app(s) failed to resolve and were omitted from the manifest`)

  const manifest = { apps }
  const jsonString = JSON.stringify(manifest, null, 2)
  const bytes = Buffer.byteLength(jsonString)

  if (check) {
    if (!existsSync(OUT)) {
      console.error(`[bundle-apps-manifest] ERROR: ${outFile} does not exist. Run 'npm run bundle-apps-manifest' to generate it.`)
      process.exit(1)
    }
    const existing = readFileSync(OUT, 'utf8')
    let existingJson
    try { existingJson = JSON.stringify(JSON.parse(existing), null, 2) } catch { existingJson = '' }
    if (existingJson !== jsonString) {
      console.error(`[bundle-apps-manifest] ERROR: ${outFile} is out of sync with ./apps. Run 'npm run bundle-apps-manifest' to update it.`)
      process.exit(1)
    }
    log(`OK: ${outFile} is in sync (${apps.length} apps)`)
    return
  }

  writeFileSync(OUT, jsonString)
  log(`wrote ${apps.length} app(s) -> ${outFile} (${bytes} bytes)`)
  if (!apps.length) { console.error('[bundle-apps-manifest] ERROR: zero apps resolved -- aborting with non-zero exit'); process.exit(1) }
}

main().catch(err => { console.error('[bundle-apps-manifest] FAILED:', err); process.exit(1) })

