import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { localSpecifiers } from './appImports.js'

const APP_SKIP = new Set(['world', '_lib', 'maps', 'node_modules', '.git', '.gm'])
const MANIFEST_VERSION = 1

export function resolveAppEntry(name, dirs) {
  for (const dir of dirs) {
    const flat = join(dir, `${name}.js`)
    if (existsSync(flat)) return flat
    const folder = join(dir, name, 'index.js')
    if (existsSync(folder)) return folder
  }
  return null
}

export function resolveAllAppNames(dirs) {
  const names = new Set()
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.') || APP_SKIP.has(ent.name)) continue
      if (ent.isDirectory()) {
        if (existsSync(join(dir, ent.name, 'index.js'))) names.add(ent.name)
      } else if (ent.isFile() && ent.name.endsWith('.js')) {
        names.add(ent.name.slice(0, -3))
      }
    }
  }
  return [...names].sort()
}

function readSource(filePath) {
  try { return readFileSync(filePath, 'utf8') } catch { return null }
}

export function collectAppSources(name, dirs) {
  const entry = resolveAppEntry(name, dirs)
  if (!entry) return null
  const files = new Map()
  const missing = new Set()
  const walk = (filePath) => {
    if (files.has(filePath)) return
    const source = readSource(filePath)
    if (source === null) return
    files.set(filePath, { path: filePath, source })
    const base = pathToFileURL(filePath)
    for (const spec of localSpecifiers(source)) {
      const url = new URL(spec, base)
      if (url.protocol !== 'file:') continue
      const dep = fileURLToPath(url)
      if (existsSync(dep)) walk(dep)
      else missing.add(spec)
    }
  }
  walk(entry)
  return {
    name,
    entry,
    files: [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    missing: [...missing].sort(),
  }
}

export function appsManifestFingerprint(dirs, names = null) {
  const appNames = names || resolveAllAppNames(dirs)
  const hash = createHash('sha256')
  hash.update(`v${MANIFEST_VERSION}\n`)
  hash.update(dirs.map(d => resolve(d)).sort().join('\n'))
  let filesRead = 0
  for (const name of appNames) {
    const app = collectAppSources(name, dirs)
    if (!app) { hash.update(`\n${name}\tunresolved`); continue }
    hash.update(`\n${name}\t${app.entry}`)
    for (const file of app.files) {
      filesRead++
      hash.update(`\n${file.path}\t${Buffer.byteLength(file.source)}\t${file.source}`)
    }
    for (const spec of app.missing) hash.update(`\n${name}\tmissing\t${spec}`)
  }
  return { fingerprint: hash.digest('hex'), filesRead, names: appNames }
}

function buildDeps(filePath, source, memo) {
  const out = {}
  const base = pathToFileURL(filePath)
  for (const spec of localSpecifiers(source)) {
    const url = new URL(spec, base)
    if (url.protocol !== 'file:') { out[spec] = null; continue }
    const dep = fileURLToPath(url)
    const depSource = existsSync(dep) ? readSource(dep) : null
    if (depSource === null) { out[spec] = null; continue }
    if (memo.has(dep)) { out[spec] = memo.get(dep); continue }
    const entry = { source: depSource, deps: {} }
    memo.set(dep, entry)
    entry.deps = buildDeps(dep, depSource, memo)
    out[spec] = entry
  }
  return out
}

function pickString(...values) {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v.trim()
  return null
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

export async function buildAppsManifest(dirs, { names = null, log = () => {} } = {}) {
  const appNames = names || resolveAllAppNames(dirs)
  const built = await Promise.all(appNames.map(async (name) => {
    const entry = resolveAppEntry(name, dirs)
    if (!entry) { log(`app "${name}" not found under ${dirs.join(', ')} -- skipped`); return null }
    const source = readSource(entry)
    if (source === null) { log(`app "${name}" at ${entry} is unreadable -- skipped`); return null }
    const deps = buildDeps(entry, source, new Map())
    return { name, source, deps, ...(await appMetadata(entry)) }
  }))
  const apps = built.filter(Boolean)
  return { apps, failed: appNames.filter((_, i) => !built[i]) }
}

export function manifestJson(apps, fingerprint) {
  return JSON.stringify({ version: MANIFEST_VERSION, fingerprint, apps }, null, 2)
}

export async function ensureAppsManifestFresh(outFile, dirs, { log = () => {}, warn = () => {} } = {}) {
  const startedAt = Date.now()
  const { fingerprint, filesRead, names } = appsManifestFingerprint(dirs)
  let current = null
  try { current = JSON.parse(readFileSync(outFile, 'utf8')) } catch { current = null }
  const currentApps = Array.isArray(current?.apps) ? current.apps : null
  if (currentApps && currentApps.length === names.length && current.fingerprint === fingerprint) {
    return { status: 'fresh', apps: currentApps.length, filesRead, ms: Date.now() - startedAt, fingerprint, bytes: null }
  }
  const { apps, failed } = await buildAppsManifest(dirs, { names, log })
  const json = manifestJson(apps, fingerprint)
  mkdirSync(dirname(outFile), { recursive: true })
  const stagedFile = `${outFile}.${process.pid}.tmp`
  writeFileSync(stagedFile, json)
  renameSync(stagedFile, outFile)
  if (failed.length) warn(`${failed.length} of ${names.length} app(s) did not resolve and are absent from ${outFile}: ${failed.join(', ')}`)
  return {
    status: currentApps ? 'refreshed' : 'written',
    apps: apps.length,
    failed,
    filesRead,
    bytes: Buffer.byteLength(json),
    ms: Date.now() - startedAt,
    fingerprint,
  }
}
