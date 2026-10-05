#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve, relative, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BAKE_TRANSFORMS } from '../src/static/BakeCodeVersion.js'

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))
const BAKE_DIR = join(ROOT, 'src', 'static')
const SELF_REL = 'src/static/BakeCodeVersion.js'
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

function main() {
  const problems = []
  for (const transform of BAKE_TRANSFORMS) {
    const entries = transform.entries.map(e => resolve(BAKE_DIR, e))
    const closure = importClosure(entries)
    const declared = new Set(transform.inputs.map(f => normalize(resolve(BAKE_DIR, f))))
    const missing = closure.filter(f => f !== SELF_REL && !declared.has(f) && extname(f) !== '.json')
    if (missing.length) {
      problems.push(`  ${transform.name}: ${missing.length} imported file(s) not in its code-version input list:\n    ${missing.join('\n    ')}`)
    } else {
      console.log(`[check-cache-keys] ${transform.name}: all ${closure.length} imported file(s) declared (codeVersion ${transform.version})`)
    }
  }
  if (problems.length) {
    console.error(`[check-cache-keys] ${problems.length} bake transform(s) can serve stale cached output:`)
    for (const p of problems) console.error(p)
    console.error('  Add each file to its BAKE_INPUTS_* list in src/static/BakeCodeVersion.js.')
    process.exit(1)
  }
  console.log(`[check-cache-keys] ${BAKE_TRANSFORMS.length} bake transforms declare their whole import closure`)
}

main()
