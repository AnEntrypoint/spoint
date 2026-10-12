import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { gunzipSync, brotliDecompressSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const HONEST_MODULE = resolve(HERE, '..', 'src', 'sdk', 'StaticCache.js')
const MODULE_FLAG = '--module='
const SMALL_JS = 'export const tiny = 1\n'
const MINUTE_MS = 60 * 1000
const LONG_AGO = new Date(2001, 8, 9)

let passed = 0
const failures = []

function record(name, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`ok - ${name}`)
    return
  }
  failures.push(name)
  console.log(`not ok - ${name}${detail ? ` :: ${detail}` : ''}`)
}

async function attempt(fn) {
  try {
    return { value: await fn() }
  } catch (error) {
    return { error: error && error.message ? error.message : String(error) }
  }
}

async function claim(name, fn) {
  const outcome = await attempt(fn)
  if (outcome.error !== undefined) {
    record(name, false, `threw ${outcome.error}`)
    return
  }
  if (outcome.value === true) {
    record(name, true)
    return
  }
  record(name, false, typeof outcome.value === 'string' ? outcome.value : 'predicate returned false')
}

function listDir(dir) {
  return existsSync(dir) ? readdirSync(dir) : []
}

function bodyForMeta(dir, metaName) {
  try {
    const m = JSON.parse(readFileSync(join(dir, metaName), 'utf8'))
    if (typeof m.body === 'string') return join(dir, m.body)
  } catch { }
  return join(dir, metaName.slice(0, -'.meta'.length))
}

function referenceFnv1a(bytes) {
  let hash = 0x811c9dc5
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193)
  return hash >>> 0
}

function patterned(length, salt) {
  const out = Buffer.alloc(length)
  for (let i = 0; i < length; i += 1) out[i] = (i * 131 + (i >>> 9) + salt) & 0xff
  return out
}

function sourceLines(count, tag) {
  return Array.from({ length: count }, (_, i) => `export const ${tag}${i} = ${i * 7}\n`).join('')
}

function fakeResponse() {
  const seen = { status: null, headers: null, body: null }
  return {
    seen,
    writeHead(status, headers) {
      seen.status = status
      seen.headers = { ...headers }
    },
    end(body) {
      seen.body = body
    },
  }
}

function moduleUnderTest(argv) {
  const flag = argv.find((arg) => arg.startsWith(MODULE_FLAG))
  return flag === undefined ? HONEST_MODULE : resolve(flag.slice(MODULE_FLAG.length))
}

async function run(scratch, modulePath) {
  if (!existsSync(modulePath) || !statSync(modulePath).isFile()) {
    console.log(`RESULT: FAIL static-cache witness, no module file at ${modulePath}`)
    return 1
  }
  const cacheDir = join(scratch, 'static-cache')
  process.env.SPOINT_STATIC_CACHE_DIR = cacheDir
  const mod = await import(pathToFileURL(modulePath).href)
  console.log(`module under test: ${modulePath}`)
  const work = join(scratch, 'work')
  mkdirSync(work, { recursive: true })

  await claim('STATIC_CACHE_DIR resolves from SPOINT_STATIC_CACHE_DIR, so writes stay in scratch', () =>
    mod.STATIC_CACHE_DIR === resolve(cacheDir) || `got ${mod.STATIC_CACHE_DIR}`)
  await claim('MAX_CACHEABLE_BYTES is 20 MiB', () =>
    mod.MAX_CACHEABLE_BYTES === 20 * 1024 * 1024 || `got ${mod.MAX_CACHEABLE_BYTES}`)
  await claim('GZIP_EXTENSIONS admits .js and .wasm and refuses .png', () =>
    (mod.GZIP_EXTENSIONS.has('.js') && mod.GZIP_EXTENSIONS.has('.wasm') && !mod.GZIP_EXTENSIONS.has('.png')) || 'extension set is wrong')

  const payload = Buffer.from(sourceLines(400, 'v'))
  await claim('compress gzip output gunzips back to the input', () =>
    gunzipSync(mod.compress(payload, 'gzip')).equals(payload) || 'gzip round trip differs')
  await claim('compress br output brotli-decompresses back to the input', () =>
    brotliDecompressSync(mod.compress(payload, 'br')).equals(payload) || 'brotli round trip differs')
  await claim('compress uses gzip for any encoding other than br', () => {
    const gz = mod.compress(payload, 'gzip')
    return (gz[0] === 0x1f && gz[1] === 0x8b) || 'gzip header missing'
  })
  await claim('compressAsync below 50 KiB round-trips through gzip', async () =>
    gunzipSync(await mod.compressAsync(payload, 'gzip')).equals(payload) || 'small async gzip differs')
  await claim('compressAsync above 50 KiB round-trips through br and gzip', async () => {
    const large = patterned(200 * 1024, 17)
    const br = await mod.compressAsync(large, 'br')
    const gz = await mod.compressAsync(large, 'gzip')
    return (brotliDecompressSync(br).equals(large) && gunzipSync(gz).equals(large)) || 'large async round trip differs'
  })

  await claim('ByteBudgetLRU evicts the least recently set entry once over budget', () => {
    const lru = new mod.ByteBudgetLRU(100)
    lru.set('a', { raw: Buffer.alloc(60) })
    lru.set('b', { raw: Buffer.alloc(60) })
    const evictedA = lru.get('a') === undefined
    const keptB = lru.get('b') !== undefined
    return (evictedA && keptB && lru.bytes === 60) || `evictedA=${evictedA} keptB=${keptB} bytes=${lru.bytes}`
  })
  await claim('ByteBudgetLRU get() refreshes recency before eviction', () => {
    const lru = new mod.ByteBudgetLRU(150)
    lru.set('a', { raw: Buffer.alloc(60) })
    lru.set('b', { raw: Buffer.alloc(60) })
    lru.get('a')
    lru.set('c', { raw: Buffer.alloc(60) })
    const evictedB = lru.get('b') === undefined
    const keptAC = lru.get('a') !== undefined && lru.get('c') !== undefined
    return (evictedB && keptAC) || `evictedB=${evictedB} keptAC=${keptAC}`
  })
  await claim('ByteBudgetLRU resync() recounts variants and delete() releases them', () => {
    const lru = new mod.ByteBudgetLRU(1000)
    const entry = { raw: Buffer.alloc(10), variants: new Map([['gzip', Buffer.alloc(20)]]) }
    lru.set('k', entry)
    entry.variants.set('br', Buffer.alloc(30))
    lru.resync('k')
    const recounted = lru.bytes
    lru.delete('k')
    return (recounted === 60 && lru.bytes === 0) || `recounted=${recounted} afterDelete=${lru.bytes}`
  })

  await claim('contentHashETag returns the FNV-1a hex digest of the bytes', () => {
    const raw = Buffer.from('static cache witness probe')
    const got = mod.contentHashETag(join(scratch, 'probe-a.js'), raw, 1)
    return got === referenceFnv1a(raw).toString(16) || `got ${got}`
  })
  await claim('contentHashETag recomputes when the mtime changes', () => {
    const probe = join(scratch, 'probe-b.js')
    mod.contentHashETag(probe, Buffer.from('first body'), 1)
    const raw = Buffer.from('second body')
    const got = mod.contentHashETag(probe, raw, 2)
    return got === referenceFnv1a(raw).toString(16) || `got ${got}`
  })
  await claim('isNodeModulesPath matches node_modules segments only', () => {
    const inside = [join('/app', 'node_modules', 'pkg', 'index.js'), join('/app', 'node_modules')]
    const outside = [join('/app', 'node_modules_backup', 'x.js'), join('/app', 'src', 'x.js')]
    const wrongIn = inside.filter((p) => !mod.isNodeModulesPath(p))
    const wrongOut = outside.filter((p) => mod.isNodeModulesPath(p))
    return (wrongIn.length === 0 && wrongOut.length === 0) || `misclassified in=${wrongIn.length} out=${wrongOut.length}`
  })

  const mainJs = join(work, 'main-fixture.js')
  writeFileSync(mainJs, payload)
  const rawMain = readFileSync(mainJs)
  const pngFixture = join(work, 'picture-fixture.png')
  writeFileSync(pngFixture, Buffer.alloc(2048, 7))
  const tinyFixture = join(work, 'tiny-fixture.js')
  writeFileSync(tinyFixture, SMALL_JS)

  const beforeGz = listDir(cacheDir)
  await claim('getCached gzip returns a gzip variant of the file and its raw bytes', async () => {
    const r = await mod.getCached(mainJs, '.js', 'gzip')
    return (r.encoding === 'gzip' && gunzipSync(r.content).equals(rawMain) && r.raw.equals(rawMain)) || `encoding=${r.encoding}`
  })
  const gzBody = listDir(cacheDir).find((n) => n.endsWith('.gz') && !beforeGz.includes(n))
  await claim('getCached gzip persists the variant body and its .meta beside it', () => {
    const created = listDir(cacheDir).filter((n) => !beforeGz.includes(n))
    const hasBody = created.some((n) => n.endsWith('.gz'))
    const hasMeta = created.some((n) => n.endsWith('.gz.meta'))
    return (hasBody && hasMeta) || `created=${created.join(',')}`
  })
  await claim('getCached br returns a brotli variant of the same file', async () => {
    const r = await mod.getCached(mainJs, '.js', 'br')
    return (r.encoding === 'br' && brotliDecompressSync(r.content).equals(rawMain)) || `encoding=${r.encoding}`
  })
  await claim('getCached leaves non-compressible extensions as the raw bytes', async () => {
    const r = await mod.getCached(pngFixture, '.png', 'gzip')
    return (r.encoding === null && r.content.equals(readFileSync(pngFixture))) || `encoding=${r.encoding}`
  })
  await claim('getCached leaves files of 100 bytes or fewer as the raw bytes', async () => {
    const r = await mod.getCached(tinyFixture, '.js', 'gzip')
    return (r.encoding === null && r.content.equals(readFileSync(tinyFixture))) || `encoding=${r.encoding}`
  })

  const changedPayload = Buffer.concat([payload, Buffer.from('export const changed = true\n')])
  writeFileSync(mainJs, changedPayload)
  const bumped = new Date(Date.now() + MINUTE_MS)
  utimesSync(mainJs, bumped, bumped)
  await claim('getCached recompresses when the source changes (stale stamp refused)', async () => {
    const r = await mod.getCached(mainJs, '.js', 'gzip')
    return gunzipSync(r.content).equals(changedPayload) || 'served the previous source'
  })
  const gzBodyPath = join(cacheDir, gzBody === undefined ? 'no-gzip-body' : gzBody)
  await claim('getCached refuses an on-disk body that fails its content hash', async () => {
    if (gzBody === undefined) return 'no gzip body was persisted to corrupt'
    writeFileSync(gzBodyPath, Buffer.alloc(statSync(gzBodyPath).size, 0xab))
    mod.fileCache.delete(mainJs)
    const r = await mod.getCached(mainJs, '.js', 'gzip')
    return gunzipSync(r.content).equals(changedPayload) || 'served corrupted bytes'
  })
  await claim('getCached serves a valid on-disk entry without rewriting it', async () => {
    if (gzBody === undefined) return 'no gzip body to reuse'
    utimesSync(gzBodyPath, LONG_AGO, LONG_AGO)
    mod.fileCache.delete(mainJs)
    const r = await mod.getCached(mainJs, '.js', 'gzip')
    const untouched = Math.abs(statSync(gzBodyPath).mtimeMs - LONG_AGO.getTime()) < 1000
    return (gunzipSync(r.content).equals(changedPayload) && untouched) || `untouched=${untouched}`
  })

  const xformFp = join(work, 'xform-fixture.js')
  const xformRaw = Buffer.from(sourceLines(120, 'x'))
  writeFileSync(xformFp, xformRaw)
  await claim('getTransformedCached without an encoding returns the input buffer', async () => {
    const r = await mod.getTransformedCached(xformFp, 1, xformRaw, null)
    return (r.encoding === null && r.content.equals(xformRaw)) || `encoding=${r.encoding}`
  })
  const beforeNoHash = listDir(cacheDir)
  await claim('getTransformedCached without a contentHash round-trips and persists nothing', async () => {
    const r = await mod.getTransformedCached(xformFp, 1, xformRaw, 'gzip', null)
    const created = listDir(cacheDir).filter((n) => !beforeNoHash.includes(n))
    return (r.encoding === 'gzip' && gunzipSync(r.content).equals(xformRaw) && created.length === 0) || `created=${created.join(',')}`
  })
  const beforeHashed = listDir(cacheDir)
  let transformedBody
  await claim('getTransformedCached with a contentHash persists a brotli entry', async () => {
    const r = await mod.getTransformedCached(xformFp, 2, xformRaw, 'br', 'h1')
    transformedBody = listDir(cacheDir).find((n) => n.endsWith('.br') && !beforeHashed.includes(n))
    return (brotliDecompressSync(r.content).equals(xformRaw) && transformedBody !== undefined) || `body=${transformedBody}`
  })
  await claim('getTransformedCached reuses the persisted entry without rewriting it', async () => {
    if (transformedBody === undefined) return 'no persisted brotli body to reuse'
    const bodyFile = join(cacheDir, transformedBody)
    utimesSync(bodyFile, LONG_AGO, LONG_AGO)
    mod.transformedCache.delete(xformFp)
    const r = await mod.getTransformedCached(xformFp, 2, xformRaw, 'br', 'h1')
    const untouched = Math.abs(statSync(bodyFile).mtimeMs - LONG_AGO.getTime()) < 1000
    return (brotliDecompressSync(r.content).equals(xformRaw) && untouched) || `untouched=${untouched}`
  })

  const validMeta = listDir(cacheDir).find((n) => n.endsWith('.gz.meta'))
  const liveVersion = validMeta === undefined ? null : JSON.parse(readFileSync(join(cacheDir, validMeta), 'utf8')).codeVersion
  const planted = {
    staleTmp: join(cacheDir, 'stale-probe.tmp-1-1'),
    freshTmp: join(cacheDir, 'fresh-probe.tmp-1-2'),
    orphanBody: join(cacheDir, 'orphan-probe.br'),
    orphanMeta: join(cacheDir, 'orphan-probe.br.meta'),
    versionBody: join(cacheDir, 'version-probe.br'),
    versionMeta: join(cacheDir, 'version-probe.br.meta'),
    corruptBody: join(cacheDir, 'corrupt-probe.br'),
    corruptMeta: join(cacheDir, 'corrupt-probe.br.meta'),
  }
  mkdirSync(cacheDir, { recursive: true })
  const aged = new Date(Date.now() - 2 * MINUTE_MS)
  writeFileSync(planted.staleTmp, 'stale')
  utimesSync(planted.staleTmp, aged, aged)
  writeFileSync(planted.freshTmp, 'fresh')
  writeFileSync(planted.orphanBody, 'x')
  writeFileSync(planted.orphanMeta, JSON.stringify({ src: join(scratch, 'missing-source.js'), stamp: 'mtime:1', codeVersion: liveVersion, bytes: 1, hash: 'x' }))
  writeFileSync(planted.versionBody, 'y')
  writeFileSync(planted.versionMeta, JSON.stringify({ src: mainJs, stamp: 'mtime:1', codeVersion: 'not-this-build', bytes: 1, hash: 'y' }))
  writeFileSync(planted.corruptBody, 'z')
  writeFileSync(planted.corruptMeta, '{not json')
  await claim('pruneStaticCache removes stale tmp files, orphan metas, wrong-version and corrupt entries', () => {
    const removed = mod.pruneStaticCache()
    const stillPresent = ['staleTmp', 'orphanBody', 'orphanMeta', 'versionBody', 'versionMeta', 'corruptBody', 'corruptMeta'].filter((k) => existsSync(planted[k]))
    return (removed === 4 && stillPresent.length === 0) || `removed=${removed} still-present=${stillPresent.join(',')}`
  })
  await claim('pruneStaticCache keeps fresh tmp files and entries whose source still exists', () => {
    const freshKept = existsSync(planted.freshTmp)
    const validKept = validMeta !== undefined && existsSync(join(cacheDir, validMeta)) && existsSync(bodyForMeta(cacheDir, validMeta))
    return (freshKept && validKept) || `freshKept=${freshKept} validKept=${validKept}`
  })
  await claim('pruneStaticCache is idempotent once stale entries are gone', () => {
    const again = mod.pruneStaticCache()
    return again === 0 || `second prune removed ${again}`
  })

  const warm = join(work, 'warm')
  mkdirSync(join(warm, 'sub'), { recursive: true })
  mkdirSync(join(warm, 'node_modules', 'pkg'), { recursive: true })
  mkdirSync(join(warm, '.git'), { recursive: true })
  mkdirSync(join(warm, '.glb-cache'), { recursive: true })
  writeFileSync(join(warm, 'a-warm.js'), sourceLines(120, 'w'))
  writeFileSync(join(warm, 'sub', 'b-warm.json'), JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => ({ i, label: `row-${i}` })) }))
  writeFileSync(join(warm, 'img-warm.png'), Buffer.alloc(2048, 3))
  writeFileSync(join(warm, 'tiny-warm.js'), SMALL_JS)
  writeFileSync(join(warm, 'node_modules', 'pkg', 'c-warm.js'), sourceLines(120, 'n'))
  writeFileSync(join(warm, '.git', 'd-warm.js'), sourceLines(120, 'g'))
  writeFileSync(join(warm, '.glb-cache', 'e-warm.glb'), Buffer.alloc(2048, 5))
  await claim('prewarmCompression counts eligible files and skips node_modules, .git and cache dirs', async () => {
    const count = await mod.prewarmCompression([{ dir: warm, prefix: '/warm/' }])
    return count === 2 || `count=${count}`
  })
  await claim('prewarmCompression writes brotli and gzip variants for each counted file', () => {
    const names = listDir(cacheDir)
    const missing = ['-a-warm.js.br', '-a-warm.js.gz', '-b-warm.json.br', '-b-warm.json.gz'].filter((suffix) => !names.some((n) => n.endsWith(suffix)))
    return missing.length === 0 || `missing ${missing.join(',')}`
  })

  const rangeCases = [
    [undefined, null],
    ['items=0-1', null],
    ['bytes=0-99', { start: 0, end: 99 }],
    ['bytes=900-', { start: 900, end: 999 }],
    ['bytes=-100', { start: 900, end: 999 }],
    ['bytes=500-2000', { start: 500, end: 999 }],
    ['bytes=-5000', { start: 0, end: 999 }],
    ['bytes=0-1,5-6', { start: 0, end: 1 }],
    ['bytes=5-2', null],
    ['bytes=1000-', null],
    ['bytes=-0', null],
    ['bytes=abc', null],
  ]
  await claim('parseRange decodes the first byte range and refuses unsatisfiable ones', () => {
    const wrong = rangeCases.filter(([header, want]) => JSON.stringify(mod.parseRange(header, 1000)) !== JSON.stringify(want))
    return wrong.length === 0 || `wrong for ${wrong.map(([header]) => String(header)).join(' | ')}`
  })

  const bytes1000 = Buffer.from(Array.from({ length: 1000 }, (_, i) => i & 0xff))
  await claim('serveRangeable answers 200 with the whole body when no range is asked', () => {
    const res = fakeResponse()
    mod.serveRangeable({ headers: {} }, res, bytes1000, { 'Content-Type': 'text/plain', ETag: 'e1' })
    const ok = res.seen.status === 200 && res.seen.headers['Content-Length'] === 1000 && res.seen.headers['Accept-Ranges'] === 'bytes' && res.seen.body.equals(bytes1000)
    return ok || `status=${res.seen.status}`
  })
  await claim('serveRangeable answers 206 with the requested slice and drops the ETag', () => {
    const res = fakeResponse()
    mod.serveRangeable({ headers: { range: 'bytes=0-9' } }, res, bytes1000, { ETag: 'e1' })
    const ok = res.seen.status === 206 && res.seen.headers['Content-Range'] === 'bytes 0-9/1000' && res.seen.headers['Content-Length'] === 10 && res.seen.body.equals(bytes1000.subarray(0, 10)) && !('ETag' in res.seen.headers)
    return ok || `status=${res.seen.status} range=${res.seen.headers['Content-Range']}`
  })
  await claim('serveRangeable falls back to a full 200 on an unsatisfiable range', () => {
    const res = fakeResponse()
    mod.serveRangeable({ headers: { range: 'bytes=5-2' } }, res, bytes1000, {})
    return (res.seen.status === 200 && res.seen.body.equals(bytes1000)) || `status=${res.seen.status}`
  })

  await claim('without SPOINT_STATIC_CACHE_DIR the cache sits under <cwd>/.spoint-cache/static', () => {
    const cwdDir = join(scratch, 'default-cwd')
    mkdirSync(cwdDir, { recursive: true })
    const env = { ...process.env }
    delete env.SPOINT_STATIC_CACHE_DIR
    const code = `import(${JSON.stringify(pathToFileURL(modulePath).href)}).then((m) => process.stdout.write(m.STATIC_CACHE_DIR))`
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: cwdDir, env, encoding: 'utf8', timeout: 60000, windowsHide: true })
    const want = resolve(join(cwdDir, '.spoint-cache', 'static'))
    const got = String(child.stdout)
    const ok = child.status === 0 && got.toLowerCase() === want.toLowerCase()
    return ok || `status=${child.status} got=${got} want=${want} stderr=${String(child.stderr).slice(0, 200)}`
  })

  const verdict = failures.length === 0 ? 'PASS' : 'FAIL'
  const tail = failures.length === 0 ? '' : `: ${failures.join('; ')}`
  console.log(`RESULT: ${verdict} static-cache witness, ${passed} claim(s) held, ${failures.length} failed, module ${modulePath}${tail}`)
  return failures.length === 0 ? 0 : 1
}

async function main() {
  const modulePath = moduleUnderTest(process.argv.slice(2))
  const scratch = mkdtempSync(join(tmpdir(), 'static-cache-witness-'))
  try {
    return await run(scratch, modulePath)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    console.log(`RESULT: FAIL static-cache witness crashed: ${error && error.message ? error.message : String(error)}`)
    process.exitCode = 1
  },
)
