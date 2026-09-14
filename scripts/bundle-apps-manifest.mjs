#!/usr/bin/env node
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

