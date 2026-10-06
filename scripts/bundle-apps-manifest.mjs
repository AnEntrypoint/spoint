#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expandWorldPresets } from '../src/shared/worldPresets.js'
import { findWorldFile, worldRoots } from '../src/sdk/WorldLocator.js'
import { resolveAllAppNames, buildAppsManifest, manifestJson, appsManifestFingerprint } from '../src/apps/appsManifest.js'

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
  else appNames = resolveAllAppNames(APP_DIRS)

  log(`resolving ${appNames.length} app(s)${explicitApps ? ' (explicit --apps list)' : world ? ` from apps/world/${world}.js` : ' (all ./apps directories)'}: ${appNames.join(', ')}`)

  const { apps, failed } = await buildAppsManifest(APP_DIRS, { names: appNames, log })
  const failedCount = failed.length
  if (failedCount) log(`WARNING: ${failedCount} app(s) failed to resolve and were omitted from the manifest`)

  const json = manifestJson(apps, appsManifestFingerprint(APP_DIRS, appNames).fingerprint)
  const bytes = Buffer.byteLength(json)

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
    if (existingJson !== json) {
      console.error(`[bundle-apps-manifest] ERROR: ${outFile} is out of sync with ./apps. Run 'npm run bundle-apps-manifest' to update it.`)
      process.exit(1)
    }
    log(`OK: ${outFile} is in sync (${apps.length} apps)`)
    return
  }

  if (ifChanged && existsSync(OUT) && readFileSync(OUT, 'utf8') === json) { log(`${outFile} unchanged (${apps.length} apps)`); return }
  writeFileSync(OUT, json)
  log(`wrote ${apps.length} app(s) -> ${outFile} (${bytes} bytes)`)
  if (!apps.length) { console.error('[bundle-apps-manifest] ERROR: zero apps resolved -- aborting with non-zero exit'); process.exit(1) }
}

main().catch(err => { console.error('[bundle-apps-manifest] FAILED:', err); process.exit(1) })
