#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve, relative, extname, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { BAKE_TRANSFORMS, HEIGHTFIELD_BAKE_CODE_VERSION, COLLISION_GRID_CODE_VERSION_SOURCE, SNAPSHOT_ENCODE_CODE_VERSION_SOURCE, SNAPSHOT_ENTITY_ENC_CODE_VERSION_SOURCE } from '../src/static/BakeCodeVersion.js'

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))
const BAKE_DIR = join(ROOT, 'src', 'static')
const SELF_REL = 'src/static/BakeCodeVersion.js'
const PIN_REL = 'src/shared/cacheCodeVersions.js'
const WORKSPACE_PREFIX = { 'mapspinner': 'packages/mapspinner', 'streaming-gltf': 'packages/streaming-gltf', 'ecs': 'packages/ecs' }

const SPEC_RE = /(?:^|[\s;}])(?:import|export)\s*(?:[\s\S]*?\sfrom\s*)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g

function normalize(abs) {
  return relative(ROOT, abs).replace(/\\/g, '/')
}

function specifiers(source) {
  const out = []
  for (const m of source.matchAll(SPEC_RE)) {
    const spec = m[1] ?? m[2]
    if (spec) out.push(spec)
  }
  return out
}

function resolveSpecifier(spec, fromFile) {
  if (spec.startsWith('node:') || spec.startsWith('data:') || spec.startsWith('http')) return null
  if (spec.startsWith('.')) return resolve(dirname(fromFile), spec)
  if (spec.startsWith('/')) return join(ROOT, spec)
  const slash = spec.indexOf('/')
  const bare = slash === -1 ? spec : spec.slice(0, slash)
  const rest = slash === -1 ? '' : spec.slice(slash)
  const prefix = WORKSPACE_PREFIX[bare] ?? WORKSPACE_PREFIX[`@spoint/${bare}`]
  if (!prefix) return null
  return resolve(ROOT, `${prefix}/src${rest}`)
}

function withExtension(p) {
  if (existsSync(p)) return p
  for (const ext of ['.js', '.mjs', '.json']) if (existsSync(p + ext)) return p + ext
  return join(p, 'index.js')
}

function importClosure(entries) {
  const seen = new Map()
  const queue = entries.slice()
  while (queue.length) {
    const file = queue.shift()
    const key = normalize(file)
    if (seen.has(key)) continue
    seen.set(key, file)
    let source
    try { source = readFileSync(file, 'utf8') } catch { continue }
    for (const spec of specifiers(source)) {
      const target = resolveSpecifier(spec, file)
      if (!target) continue
      const abs = withExtension(target)
      if (!existsSync(abs)) continue
      const rel = normalize(abs)
      if (rel.startsWith('..') || rel.includes('/node_modules/')) continue
      if (!seen.has(rel)) queue.push(abs)
    }
  }
  return [...seen.keys()].sort()
}

const HEIGHTFIELD_EXT = '.hf'
const TRACKED_LIST_MAX_BYTES = 64 * 1024 * 1024

function trackedFiles() {
  const listed = spawnSync('git', ['ls-files', '--cached', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: TRACKED_LIST_MAX_BYTES,
    windowsHide: true,
  })
  const why = listed.error
    ? listed.error.message
    : listed.status !== 0
      ? `git exited ${listed.status}: ${(listed.stderr || '').trim()}`
      : null
  if (why) return { files: null, error: why }
  const files = listed.stdout.split('\0').filter(Boolean).map(p => p.split('/').join(sep))
  return { files, error: null }
}

function shippedHeightfields() {
  const { files, error } = trackedFiles()
  if (error) {
    return { files: [], error: `git ls-files could not list tracked files (${error}), so no shipped ${HEIGHTFIELD_EXT} artifact was verified` }
  }
  const heightfields = files.filter(p => p.endsWith(HEIGHTFIELD_EXT)).sort()
  if (heightfields.length === 0) {
    return { files: heightfields, error: `git ls-files tracks no ${HEIGHTFIELD_EXT} artifact, so no shipped heightfield was verified` }
  }
  return { files: heightfields, error: null }
}

async function main() {
  const problems = []
  const markers = await import('../src/shared/cacheCodeVersions.js')
  const pinned = [
    ['COLLISION_GRID_CODE_VERSION', markers.COLLISION_GRID_CODE_VERSION, COLLISION_GRID_CODE_VERSION_SOURCE],
    ['SNAPSHOT_ENCODE_CODE_VERSION', markers.SNAPSHOT_ENCODE_CODE_VERSION, SNAPSHOT_ENCODE_CODE_VERSION_SOURCE],
    ['SNAPSHOT_ENTITY_ENC_CODE_VERSION', markers.SNAPSHOT_ENTITY_ENC_CODE_VERSION, SNAPSHOT_ENTITY_ENC_CODE_VERSION_SOURCE],
  ]
  for (const [name, marker, source] of pinned) {
    if (marker !== source) problems.push(`  ${name}: src/shared/cacheCodeVersions.js pins '${marker}' but its producing source hashes to '${source}' -- set ${name} = '${source}'`)
    else console.log(`[check-cache-keys] ${name}: ${marker} matches its producing source`)
  }
  for (const transform of BAKE_TRANSFORMS) {
    const entries = transform.entries.map(e => resolve(BAKE_DIR, e))
    const closure = importClosure(entries)
    const declared = new Set(transform.inputs.map(f => normalize(resolve(BAKE_DIR, f))))
    const missing = closure.filter(f => f !== SELF_REL && f !== PIN_REL && !declared.has(f) && extname(f) !== '.json')
    if (missing.length) {
      problems.push(`  ${transform.name}: ${missing.length} imported file(s) not in its code-version input list:\n    ${missing.join('\n    ')}`)
    } else {
      console.log(`[check-cache-keys] ${transform.name}: all ${closure.length} imported file(s) declared (codeVersion ${transform.version})`)
    }
  }
  const { decodeHeightfield } = await import('mapspinner/heightfield-codec')
  const { files: heightfields, error: heightfieldError } = shippedHeightfields()
  if (heightfieldError) problems.push(`  ${heightfieldError}`)
  else console.log(`[check-cache-keys] verifying ${heightfields.length} shipped .hf artifact(s)`)
  for (const rel of heightfields) {
    const buf = readFileSync(join(ROOT, rel))
    const header = decodeHeightfield(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
    if (!header) { problems.push(`  ${rel}: not a decodable .hf artifact`); continue }
    if (header.codeVersion !== HEIGHTFIELD_BAKE_CODE_VERSION) {
      problems.push(`  ${rel}: baked with height code version ${header.codeVersion ?? '(none)'}, this tree bakes ${HEIGHTFIELD_BAKE_CODE_VERSION} -- re-run: node scripts/bake-heightfield.mjs --world <name> --extent ${header.extent} --res ${header.extent / (header.N - 1)} --sector ${header.sectors.nodesPerSector} --bits ${header.sectors.bits} --out ${rel}`)
    } else {
      console.log(`[check-cache-keys] ${rel}: height code version ${header.codeVersion} matches this tree`)
    }
  }
  if (problems.length) {
    console.error(`[check-cache-keys] ${problems.length} stale-bake problem(s):`)
    for (const p of problems) console.error(p)
    console.error('  Add each file to its BAKE_INPUTS_* list in src/static/BakeCodeVersion.js, or re-bake the artifact.')
    process.exit(1)
  }
  console.log(`[check-cache-keys] ${BAKE_TRANSFORMS.length} bake transforms declare their whole import closure`)
}

main().catch((e) => { console.error('[check-cache-keys] harness error:', e?.message || e); process.exit(2) })
