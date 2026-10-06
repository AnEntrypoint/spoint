#!/usr/bin/env node
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import { join, extname, dirname, resolve, sep } from 'node:path'

const ROOTS = ['src', 'client', 'apps', 'scripts', 'bin', 'packages/mapspinner/src', 'packages/streaming-gltf/src', 'packages/ecs/src']
const SKIP_DIRS = new Set(['node_modules', '.git', '.gm', 'dist', 'basis', 'draco', 'maps', 'vendor'])
const SKIP_VENDORED_FILE = /(\.min\.js$|basis_transcoder|draco_decoder|jolt-physics)/
const CANDIDATE_SUFFIXES = ['', '.js', '.mjs', '.json', '/index.js', '/index.mjs']

const EXPORT_STAR_RE = /\bexport\s*\*\s*(?:as\s+[\w$]+\s*)?from\b/
const EXPORT_NAMED_RE = /\bexport\s*(?:type\s*)?\{([^}]*)\}\s*(?!\s*from)/g
const EXPORT_DECL_RE = /\bexport\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g
const EXPORT_DEFAULT_RE = /\bexport\s+default\b/
const REEXPORT_NAMED_RE = /\bexport\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"`]([^'"`\n]+)['"`]/g
const NAMED_IMPORT_RE = /\bimport\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"`]([^'"`\n]+)['"`]/g
const CJS_EXPORT_RE = /\bmodule\.exports\b/

const trimBraceNames = (group, pick) => group
  .split(',')
  .map(part => part.trim())
  .filter(Boolean)
  .map(part => { const bits = part.split(/\s+as\s+/).map(s => s.trim()); return pick === 'bound' ? bits[bits.length - 1] : bits[0] })
  .filter(Boolean)

function resolveTarget(fromFile, spec) {
  const clean = spec.split('?')[0].split('#')[0]
  if (!clean) return null
  const base = resolve(dirname(fromFile), clean.split('/').join(sep))
  for (const suffix of CANDIDATE_SUFFIXES) if (existsSync(base + suffix)) return base + suffix
  return null
}

const exportCache = new Map()

function exportedNames(file) {
  const cached = exportCache.get(file)
  if (cached) return cached
  let names = null
  let text
  try { text = readFileSync(file, 'utf8') } catch { exportCache.set(file, null); return null }
  if (CJS_EXPORT_RE.test(text) || EXPORT_STAR_RE.test(text)) { exportCache.set(file, null); return null }
  names = new Set()
  for (const m of text.matchAll(EXPORT_DECL_RE)) names.add(m[1])
  for (const m of text.matchAll(EXPORT_NAMED_RE)) for (const n of trimBraceNames(m[1], 'bound')) names.add(n)
  for (const m of text.matchAll(REEXPORT_NAMED_RE)) for (const n of trimBraceNames(m[1], 'bound')) names.add(n)
  if (EXPORT_DEFAULT_RE.test(text)) names.add('default')
  exportCache.set(file, names)
  return names
}

function namedImportProblems(file, text) {
  const problems = []
  for (const m of text.matchAll(NAMED_IMPORT_RE)) {
    const spec = m[2]
    if (!spec.startsWith('.') || spec.includes('${')) continue
    const target = resolveTarget(file, spec)
    if (!target || target.endsWith('.json')) continue
    const names = exportedNames(target)
    if (!names) continue
    for (const want of trimBraceNames(m[1], 'imported')) {
      if (!names.has(want)) problems.push(`${file}:${lineOf(text, m.index)}: imports "${want}" from "${spec}" but ${target} exports no such name`)
    }
  }
  return problems
}

const SPECIFIER_PATTERNS = [
  /\bimport\s*\(\s*['"`]([^'"`\n]+)['"`]\s*\)/g,
  /\brequire\s*\(\s*['"`]([^'"`\n]+)['"`]\s*\)/g,
  /\bfrom\s*['"`]([^'"`\n]+)['"`]/g,
  /\bimport\s+['"`]([^'"`\n]+)['"`]/g,
]

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

function specifiers(text) {
  const found = []
  for (const re of SPECIFIER_PATTERNS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text))) found.push({ spec: m[1], index: m.index })
  }
  return found
}

function resolves(target) {
  for (const suffix of CANDIDATE_SUFFIXES) if (existsSync(target + suffix)) return true
  return false
}

function main() {
  const files = []
  for (const root of ROOTS) collect(root, files)

  const missingRoots = ROOTS.filter((root) => !existsSync(root))
  if (missingRoots.length) {
    console.error(`check-relative-imports: source root(s) absent: ${missingRoots.join(', ')}`)
    process.exit(1)
  }
  if (files.length === 0) {
    console.error('check-relative-imports: 0 file(s) collected -- an empty scan is not a pass')
    process.exit(1)
  }

  const problems = []
  let checked = 0
  let namedChecked = 0
  for (const file of files) {
    let text
    try { text = readFileSync(file, 'utf8') } catch { continue }
    for (const { spec, index } of specifiers(text)) {
      if (!spec.startsWith('.')) continue
      if (spec.includes('${')) continue
      const clean = spec.split('?')[0].split('#')[0]
      if (!clean) continue
      checked++
      const target = resolve(dirname(file), clean.split('/').join(sep))
      if (!resolves(target)) problems.push(`${file}:${lineOf(text, index)}: "${spec}" resolves to no file under ${target}`)
    }
    const namedProblems = namedImportProblems(file, text)
    namedChecked += (text.match(NAMED_IMPORT_RE) || []).length
    problems.push(...namedProblems)
  }

  console.log(`check-relative-imports: ${checked} relative specifier(s) in ${files.length} file(s)`)
  if (checked === 0) {
    console.error(`check-relative-imports: 0 relative specifier(s) in ${files.length} file(s) -- an empty scan is not a pass`)
    process.exit(1)
  }
  if (namedChecked === 0) {
    console.error('check-relative-imports: 0 named relative import(s) found -- an empty export-name scan is not a pass')
    process.exit(1)
  }
  if (problems.length) {
    console.error(`check-relative-imports: ${problems.length} unresolvable relative import(s):`)
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  }
  console.log(`check-relative-imports: every relative specifier resolves, and all ${namedChecked} named relative import(s) name an export that exists`)
}

main()
