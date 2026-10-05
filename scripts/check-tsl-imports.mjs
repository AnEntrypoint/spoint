#!/usr/bin/env node
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOTS = ['src', 'client', 'apps', 'scripts', 'bin', 'packages/mapspinner/src', 'packages/streaming-gltf/src', 'packages/ecs/src']
const SKIP_DIRS = new Set(['node_modules', '.git', '.gm', 'dist', 'basis', 'draco', 'maps', 'vendor'])
const SKIP_VENDORED_FILE = /(\.min\.js$|basis_transcoder|draco_decoder|jolt-physics)/

const MODULE_BUILDS = [
  { spec: 'three/tsl', build: 'node_modules/three/build/three.tsl.js' },
  { spec: 'three/webgpu', build: 'node_modules/three/build/three.webgpu.js' },
  { spec: 'three', build: 'node_modules/three/build/three.module.js' },
]

const IMPORT_RE = /\bimport\s+((?:(?!\bimport\b)[^;'"`])*?)\s*from\s*['"`](three\/tsl|three\/webgpu|three)['"`]/gs

function collect(dir, out) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    const full = join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) collect(full, out)
    } else if ((extname(name) === '.js' || extname(name) === '.mjs') && !SKIP_VENDORED_FILE.test(full)) {
      out.push(full)
    }
  }
  return out
}

function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++
  return line
}

function exportedNames(buildPath) {
  const text = readFileSync(buildPath, 'utf8')
  const names = new Set()
  const re = /^export\s*\{([^}]*)\}/gm
  let m
  while ((m = re.exec(text))) {
    for (const part of m[1].split(',')) {
      const trimmed = part.trim()
      if (!trimmed) continue
      const asIndex = trimmed.lastIndexOf(' as ')
      names.add(asIndex === -1 ? trimmed : trimmed.slice(asIndex + 4).trim())
    }
  }
  return names
}

function namedBindings(clause) {
  const open = clause.indexOf('{')
  if (open === -1) return []
  let depth = 0
  let close = -1
  for (let i = open; i < clause.length; i++) {
    if (clause[i] === '{') depth++
    else if (clause[i] === '}') { depth--; if (depth === 0) { close = i; break } }
  }
  if (close === -1) return []
  const inner = clause.slice(open + 1, close)
  const out = []
  for (const part of inner.split(',')) {
    const trimmed = part.trim()
    if (!trimmed || trimmed === ',') continue
    const asIndex = trimmed.lastIndexOf(' as ')
    const imported = (asIndex === -1 ? trimmed : trimmed.slice(0, asIndex)).trim()
    if (imported && imported !== 'default') out.push(imported)
  }
  return out
}

function main() {
  const files = []
  for (const root of ROOTS) collect(root, files)

  const modules = MODULE_BUILDS.map(m => ({ spec: m.spec, exports: exportedNames(m.build) }))
  const bySpec = new Map(modules.map(m => [m.spec, m.exports]))

  const problems = []
  let checkedFiles = 0
  let checkedNames = 0
  for (const file of files) {
    let text
    try { text = readFileSync(file, 'utf8') } catch { continue }
    IMPORT_RE.lastIndex = 0
    let m
    let fileHasImport = false
    while ((m = IMPORT_RE.exec(text))) {
      const clause = m[1]
      const spec = m[2]
      const names = namedBindings(clause)
      if (!names.length) continue
      fileHasImport = true
      const exports = bySpec.get(spec)
      for (const name of names) {
        checkedNames++
        if (!exports.has(name)) problems.push(`${file}:${lineOf(text, m.index)}: "${name}" is not exported by ${spec} (three ${JSON.stringify(version())})`)
      }
    }
    if (fileHasImport) checkedFiles++
  }

  console.log(`check-tsl-imports: ${checkedNames} named import(s) from ${modules.map(m => m.spec).join(', ')} across ${checkedFiles} file(s) (three ${version()})`)
  if (problems.length) {
    console.error(`check-tsl-imports: ${problems.length} named import(s) absent from the installed export list:`)
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  }
  console.log('check-tsl-imports: every named import exists in the installed export list')
}

let cachedVersion = null
function version() {
  if (cachedVersion === null) cachedVersion = JSON.parse(readFileSync('node_modules/three/package.json', 'utf8')).version
  return cachedVersion
}

main()
