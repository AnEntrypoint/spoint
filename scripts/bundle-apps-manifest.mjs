#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expandWorldPresets } from '../src/shared/worldPresets.js'
import { localSpecifiers } from '../src/apps/appImports.js'
import { findWorldFile, worldRoots } from '../src/sdk/WorldLocator.js'

const __dirname = import.meta.dirname || dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

function parseArgs(argv) {
  const out = { outFile: 'client/apps-manifest.json', apps: null, world: null, all: false, check: false, ifChanged: false }
  for (const a of argv) {
    if (a.startsWith('--apps=')) out.apps = a.slice('--apps='.length).split(',').map(s => s.trim()).filter(Boolean)
    else if (a.startsWith('--world=')) out.world = a.slice('--world='.length)
    else if (a === '--all') out.all = true
    else if (a === '--check') out.check = true
    else if (a === '--if-changed') out.ifChanged = true
    else if (!a.startsWith('--')) out.outFile = a
  }
  if (!out.apps && !out.world) out.all = true
  return out
}

function log(msg) { console.log(`[bundle-apps-manifest] ${msg}`) }

const APP_DIRS = [join(ROOT, 'apps'), join(ROOT, 'src', 'stdlib-apps')]

function resolveAppEntry(name) {
  for (const dir of APP_DIRS) {
    const flat = join(dir, `${name}.js`)
    if (existsSync(flat)) return flat
    const folder = join(dir, name, 'index.js')
    if (existsSync(folder)) return folder
  }
  return null
}

function resolveAllApps() {
  const SKIP = new Set(['world', '_lib', 'maps', 'node_modules', '.git', '.gm'])
  const names = new Set()
  for (const appsDir of APP_DIRS) {
    if (!existsSync(appsDir)) continue
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
  }
  return [...names].sort()
}

function resolveRelativeDeps(source, baseFileUrl, seen) {
  const out = {}
  for (const spec of localSpecifiers(source)) {
    const u = new URL(spec, baseFileUrl)
    if (u.protocol !== 'file:') { out[spec] = null; continue }
    if (seen.has(u.href)) { out[spec] = seen.get(u.href); continue }
    const filePath = fileURLToPath(u)
    if (!existsSync(filePath)) { out[spec] = null; continue }
    const entry = { source: readFileSync(filePath, 'utf8'), deps: {} }
    seen.set(u.href, entry)
    entry.deps = resolveRelativeDeps(entry.source, u, seen)
    out[spec] = entry
  }
  return out
}

async function appMetadata(entry) {
  let mod = null
  try { mod = await import(pathToFileURL(entry).href) } catch { }
  const def = mod?.default
  const category = pickString(mod?.category, def?.category) || 'General'
  const description = pickString(mod?.description, def?.description) || null
  const declaredPlaceable = [mod?.placeable, def?.placeable].find(v => typeof v === 'boolean')
  const out = { category, placeable: declaredPlaceable !== false }
  if (description) out.description = description
  return out
}

function pickString(...values) {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v.trim()
  return null
}

async function bundleApp(name) {
  const entry = resolveAppEntry(name)
  if (!entry) { log(`WARNING: app "${name}" not found under apps/ or src/stdlib-apps/ -- skipped`); return null }
  const source = readFileSync(entry, 'utf8')
  const baseUrl = pathToFileURL(entry)
  const deps = resolveRelativeDeps(source, baseUrl, new Map())
  return { name, source, deps, ...(await appMetadata(entry)) }
}

async function resolveAppNamesFromWorld(worldName) {
  const worldFile = findWorldFile(worldName, worldRoots(ROOT)) || join(ROOT, 'apps/world', `${worldName}.js`)
  if (!existsSync(worldFile)) throw new Error(`world module not found: ${worldFile}`)
  const mod = await import(pathToFileURL(worldFile).href)
  const worldDef = expandWorldPresets(mod.default || mod)
  return [...new Set([
    ...((worldDef.entities || []).map(e => e.app).filter(Boolean)),
    ...((worldDef.placeableApps || [])),
    ...((worldDef.trustedApps || []))
  ])]
}

async function main() {
  const argv = process.argv.slice(2)
  const { outFile, apps: explicitApps, world, all, check, ifChanged } = parseArgs(argv)
  const OUT = resolve(ROOT, outFile)

  let appNames
  if (explicitApps) appNames = explicitApps
  else if (world) appNames = await resolveAppNamesFromWorld(world)
  else appNames = resolveAllApps()

  log(`resolving ${appNames.length} app(s)${explicitApps ? ' (explicit --apps list)' : world ? ` from apps/world/${world}.js` : ' (all ./apps directories)'}: ${appNames.join(', ')}`)

  const apps = (await Promise.all(appNames.map(bundleApp))).filter(Boolean)
  const failedCount = appNames.length - apps.length
  if (failedCount) log(`WARNING: ${failedCount} app(s) failed to resolve and were omitted from the manifest`)

  const manifest = { apps }
  const jsonString = JSON.stringify(manifest, null, 2)
  const bytes = Buffer.byteLength(jsonString)

  if (check) {
    if (failedCount) {
      console.error(`[bundle-apps-manifest] ERROR: ${failedCount} of ${appNames.length} app(s) failed to resolve and were omitted from the manifest`)
      process.exit(1)
    }
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

  if (ifChanged && existsSync(OUT) && readFileSync(OUT, 'utf8') === jsonString) { log(`${outFile} unchanged (${apps.length} apps)`); return }
  writeFileSync(OUT, jsonString)
  log(`wrote ${apps.length} app(s) -> ${outFile} (${bytes} bytes)`)
  if (!apps.length) { console.error('[bundle-apps-manifest] ERROR: zero apps resolved -- aborting with non-zero exit'); process.exit(1) }
}

main().catch(err => { console.error('[bundle-apps-manifest] FAILED:', err); process.exit(1) })

