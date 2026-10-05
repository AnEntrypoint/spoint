import { existsSync, readdirSync, readFileSync, statSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname, resolve, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { localSpecifiers } from '../src/apps/appImports.js'
import { expandWorldPresets } from '../src/shared/worldPresets.js'

const execFileAsync = promisify(execFile)
const ROOT = resolve(import.meta.dirname, '..')
const APP_DIRS = [join(ROOT, 'apps'), join(ROOT, 'src', 'stdlib-apps')]
const ASSET_LITERAL = /(['"`])([^'"`\n$*{}]+\.(?:glb|gltf|vrm|png|jpe?g|webp|ktx2|hdr|mp3|ogg|wav|bin))\1/g
const ASSET_SCAN_ROOTS = [join(ROOT, 'apps'), join(ROOT, 'src', 'stdlib-apps'), join(ROOT, 'src', 'presets')]
const ASSET_SCAN_FILES = [join(ROOT, 'src', 'shared', 'worldDefaults.js')]
const ASSET_SERVING_ROOTS = [ROOT, join(ROOT, 'client')]
const CLIENT_DIR = join(ROOT, 'client') + sep

function rel(p) { return relative(ROOT, p).split(sep).join('/') }

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (/\.m?js$/.test(name)) out.push(full)
  }
  return out
}

function worldAppNames() {
  const worldsDir = join(ROOT, 'apps', 'world')
  return readdirSync(worldsDir)
    .filter(n => n.endsWith('.js') && !n.startsWith('_') && n !== 'index.js')
    .map(n => ({ file: join(worldsDir, n), world: n.slice(0, -3) }))
}

async function worldAppSets() {
  const sets = new Map()
  for (const { file, world } of worldAppNames()) {
    const def = expandWorldPresets((await import(pathToFileURL(file).href)).default || {})
    const names = [...(def.entities || []).map(e => e.app), ...(def.placeableApps || []), ...(def.trustedApps || [])].filter(Boolean)
    for (const name of names) sets.set(name, [...(sets.get(name) || []), world])
  }
  return sets
}

function inspectManifestEntry(owner, file, source, deps, trail, problems, reachedFromWorlds) {
  for (const spec of localSpecifiers(source)) {
    const where = `${rel(file)} imports "${spec}"`
    if (spec.startsWith('/')) {
      problems.push(`${where}: absolute specifier cannot be resolved against an app blob`)
      continue
    }
    const target = resolve(dirname(file), spec)
    if (target.startsWith(CLIENT_DIR)) problems.push(`${where}: apps never import client/*`)
    const entry = deps?.[spec]
    if (!entry) {
      problems.push(`${where}: ${existsSync(target) ? 'present on disk but missing from the bundled dependency tree (worker blob would fail to resolve it)' : 'file does not exist'}`)
      continue
    }
    if (trail.includes(target)) continue
    const entrySource = typeof entry === 'string' ? entry : entry.source
    inspectManifestEntry(owner, target, entrySource, typeof entry === 'string' ? {} : entry.deps, [...trail, target], problems, reachedFromWorlds)
  }
  if (reachedFromWorlds) {
    for (const m of source.matchAll(/(?:from|import)\s*['"]([^.'"/][^'"]*)['"]/g)) {
      if (!m[1].startsWith('node:')) problems.push(`${rel(file)} imports bare specifier "${m[1]}": a worker blob has no importmap`)
    }
  }
}

function checkAssets(problems) {
  const files = [...ASSET_SCAN_ROOTS.flatMap(d => existsSync(d) ? sourceFiles(d) : []), ...ASSET_SCAN_FILES]
  let checked = 0
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const m of source.matchAll(ASSET_LITERAL)) {
      const literal = m[2]
      if (/^(https?:|data:|blob:)/.test(literal)) continue
      checked++
      const relativeToFile = literal.startsWith('.') ? [resolve(dirname(file), literal)] : []
      const rooted = ASSET_SERVING_ROOTS.map(root => resolve(root, literal.replace(/^\.?\//, '')))
      if (![...relativeToFile, ...rooted].some(existsSync)) problems.push(`${rel(file)} references asset "${literal}": no such file under the file directory, the repo root or client/`)
    }
  }
  return checked
}

export async function checkAppImports() {
  const problems = []
  const scratch = mkdtempSync(join(tmpdir(), 'spoint-app-imports-'))
  const manifestPath = join(scratch, 'manifest.json')
  let appCount = 0
  try {
    await execFileAsync(process.execPath, [join(ROOT, 'scripts', 'bundle-apps-manifest.mjs'), '--all', manifestPath])
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const reachable = await worldAppSets()
    for (const app of manifest.apps) {
      const entryFile = APP_DIRS.map(d => [join(d, app.name, 'index.js'), join(d, `${app.name}.js`)]).flat().find(existsSync)
      appCount++
      inspectManifestEntry(app.name, entryFile, app.source, app.deps, [entryFile], problems, reachable.has(app.name))
    }
    for (const name of reachable.keys()) {
      if (!manifest.apps.some(a => a.name === name)) problems.push(`world app "${name}" (used by ${reachable.get(name).join(', ')}) has no app module under apps/ or src/stdlib-apps/`)
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  const assetCount = checkAssets(problems)
  return { problems: [...new Set(problems)], appCount, assetCount }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { problems, appCount, assetCount } = await checkAppImports()
  if (problems.length) {
    console.error(`check-app-imports: ${problems.length} problem(s)`)
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  }
  console.log(`check-app-imports: ${appCount} apps resolve every import, ${assetCount} asset references exist`)
}
