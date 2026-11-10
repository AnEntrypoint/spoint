import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const DIR = resolve(ROOT, argOf('--dir') || 'dist/client')
const ENTRY = argOf('--entry') || 'app.js'
const SIZE_LIMIT_BYTES = 1000000
const MARKERS = ['ds-ep-panel-section', 'freddie-editor', 'ds-247420 ep-overlay']
const EDITOR_SRC = join(ROOT, 'client', 'editor')

const failures = []
const report = (name, ok, detail) => {
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'} (${detail})`)
  if (!ok) failures.push(name)
}

const entryPath = join(DIR, ENTRY)
if (!existsSync(entryPath)) {
  report('entry-present', false, `missing ${entryPath}`)
  console.log('RESULT: FAIL: entry bundle missing')
  process.exit(1)
}

const entryText = readFileSync(entryPath, 'utf8')
const entryBytes = statSync(entryPath).size

const sourceText = readdirSync(EDITOR_SRC).filter(f => f.endsWith('.js')).map(f => readFileSync(join(EDITOR_SRC, f), 'utf8')).join('\n')
const missingInSource = MARKERS.filter(m => !sourceText.includes(m))
report('markers-are-editor-source', missingInSource.length === 0, `${MARKERS.length - missingInSource.length} of ${MARKERS.length} markers found in client/editor/*.js${missingInSource.length ? `, missing [${missingInSource.join(', ')}]` : ''}`)

report('entry-under-size-limit', entryBytes < SIZE_LIMIT_BYTES, `${ENTRY} is ${entryBytes} bytes, limit ${SIZE_LIMIT_BYTES}`)

const markersInEntry = MARKERS.filter(m => entryText.includes(m))
report('entry-free-of-editor-markers', markersInEntry.length === 0, `${markersInEntry.length} editor marker(s) in ${ENTRY}${markersInEntry.length ? ` [${markersInEntry.join(', ')}]` : ''}`)

const specifiersOf = (text, re) => [...text.matchAll(re)].map(m => m[1])
const dynamicSpecs = [...new Set(specifiersOf(entryText, /import\(\s*"\.\/([^"]+\.js)"\s*\)/g))]
const staticSpecs = [...new Set([
  ...specifiersOf(entryText, /^import\s[^;]*?from\s*"\.\/([^"]+\.js)"/gm),
  ...specifiersOf(entryText, /^import\s*"\.\/([^"]+\.js)"/gm)
])]

const chunkText = spec => {
  const p = join(DIR, spec)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

const dynamicEditorSpecs = dynamicSpecs.filter(spec => {
  const t = chunkText(spec)
  return t !== null && MARKERS.some(m => t.includes(m))
})
const coveredByDynamic = MARKERS.filter(m => dynamicEditorSpecs.some(spec => chunkText(spec).includes(m)))
report('editor-reached-by-dynamic-import', coveredByDynamic.length === MARKERS.length && dynamicEditorSpecs.length > 0, `${coveredByDynamic.length} of ${MARKERS.length} markers in ${dynamicEditorSpecs.length} dynamically imported chunk(s) [${dynamicEditorSpecs.join(', ')}]`)

const staticEditorSpecs = staticSpecs.filter(spec => {
  const t = chunkText(spec)
  return t !== null && MARKERS.some(m => t.includes(m))
})
report('no-static-import-of-editor', staticEditorSpecs.length === 0, `${staticEditorSpecs.length} statically imported editor chunk(s) [${staticEditorSpecs.join(', ')}]`)

if (failures.length === 0) console.log(`RESULT: PASS ${DIR}/${ENTRY}: entry ${entryBytes} bytes, editor only behind dynamic import`)
else console.log(`RESULT: FAIL ${DIR}/${ENTRY}: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
