import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'node_modules', '@dgreenheck', 'ez-tree', 'build', 'ez-tree.es.js')
const CLIENT_DIR = join(ROOT, 'dist', 'client')
const ASSET_DIR = join(CLIENT_DIR, 'assets', 'ez-tree')
const EXPECT_URI_COUNT = 20
const EXPECT_URI_CHARS = 3969796
const SIZE_LIMIT_BYTES = 1000000
const INLINE_RUN_MIN = 200
const SOURCE_URI_RE = /"data:image\/(jpeg|png);base64,([A-Za-z0-9+\/=]+)"/g
const CHUNK_RE = /^ez-tree\.es-.*\.js$/
const REF_RE = /\.\/assets\/ez-tree\/([0-9a-f]{16}\.(?:jpg|png))/g
const INLINE_RUN_RE = new RegExp(`data:image/[a-z]+;base64,[A-Za-z0-9+\\/=]{${INLINE_RUN_MIN + 1},}`, 'g')

const expectInline = process.argv.includes('--expect-inline')
const mode = expectInline ? 'expect-inline' : 'external-assets'
const failures = []

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

const report = (name, ok, detail) => {
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'} (${detail})`)
  if (!ok) failures.push(name)
}

const skip = (name, why) => console.log(`check ${name}: skip (${why})`)

if (!existsSync(SOURCE)) {
  report('vendor-source-present', false, `missing ${SOURCE}`)
  console.log(`RESULT: FAIL ${mode}: vendor source missing`)
  process.exit(1)
}

const sourceUris = [...readFileSync(SOURCE, 'utf8').matchAll(SOURCE_URI_RE)].map(([whole, type, payload]) => {
  const bytes = Buffer.from(payload, 'base64')
  const digest = sha256(bytes)
  return {
    name: `${digest.slice(0, 16)}.${type === 'jpeg' ? 'jpg' : 'png'}`,
    sha: digest,
    chars: whole.length - 2
  }
})
const sourceChars = sourceUris.reduce((n, u) => n + u.chars, 0)
const sourceByName = new Map(sourceUris.map(u => [u.name, u]))

report('source-uri-count', sourceUris.length === EXPECT_URI_COUNT, `${sourceUris.length} data URIs, expected ${EXPECT_URI_COUNT}`)
report('source-uri-chars', sourceChars === EXPECT_URI_CHARS, `${sourceChars} chars, expected ${EXPECT_URI_CHARS}`)

const chunkPaths = existsSync(CLIENT_DIR)
  ? readdirSync(CLIENT_DIR).filter(f => CHUNK_RE.test(f)).map(f => join(CLIENT_DIR, f))
  : []

if (chunkPaths.length === 0) {
  if (expectInline) report('built-chunk-present', false, 'no dist/client/ez-tree.es-*.js')
  else skip('built-chunk', 'no dist/client/ez-tree.es-*.js built')
} else {
  const texts = chunkPaths.map(p => readFileSync(p, 'utf8'))
  const refs = new Set(texts.flatMap(t => [...t.matchAll(REF_RE)].map(m => m[1])))
  const maxSize = Math.max(...chunkPaths.map(p => statSync(p).size))
  const inlineRuns = texts.reduce((n, t) => n + [...t.matchAll(INLINE_RUN_RE)].length, 0)

  if (expectInline) {
    report('built-chunk-asset-refs-absent', refs.size === 0, `${refs.size} asset references in built chunk`)
  } else if (existsSync(ASSET_DIR)) {
    const missing = [...refs].filter(n => !existsSync(join(ASSET_DIR, n)))
    report('built-asset-files-exist', refs.size > 0 && missing.length === 0, `${refs.size} referenced, ${missing.length} missing [${missing.join(', ')}]`)
    const mismatched = [...refs].filter(n => {
      const src = sourceByName.get(n)
      if (!src || !existsSync(join(ASSET_DIR, n))) return true
      return sha256(readFileSync(join(ASSET_DIR, n))) !== src.sha
    })
    report('built-asset-bytes-match-source', refs.size > 0 && mismatched.length === 0, `${refs.size - mismatched.length} of ${refs.size} referenced files sha256-equal to their source data URI, mismatched [${mismatched.join(', ')}]`)
    const uncovered = [...sourceByName.keys()].filter(n => !refs.has(n))
    report('built-asset-coverage', uncovered.length === 0, `${sourceByName.size - uncovered.length} of ${sourceByName.size} source images referenced, unreferenced [${uncovered.join(', ')}]`)
  } else {
    skip('built-asset-files', 'dist/client/assets/ez-tree absent')
  }

  report('built-chunk-size', expectInline ? maxSize >= SIZE_LIMIT_BYTES : maxSize < SIZE_LIMIT_BYTES, `largest chunk ${maxSize} bytes, limit ${SIZE_LIMIT_BYTES} (expect ${expectInline ? '>=' : '<'})`)
  report('built-chunk-inline-runs', expectInline ? inlineRuns === EXPECT_URI_COUNT : inlineRuns === 0, `${inlineRuns} data:image base64 runs over ${INLINE_RUN_MIN} chars (expect ${expectInline ? EXPECT_URI_COUNT : 0})`)
}

if (failures.length === 0) console.log(`RESULT: PASS ${mode}: all checks ok`)
else console.log(`RESULT: FAIL ${mode}: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
