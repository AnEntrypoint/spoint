import { readFileSync, existsSync, statSync, writeFileSync, readdirSync, mkdirSync, rmSync, renameSync } from 'node:fs'
import { join, extname, sep, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync, brotliCompressSync, gzip, brotliCompress, constants as zlibConstants } from 'node:zlib'
import { promisify } from 'node:util'
import { fnv1aBytes } from '../shared/fnv1a.js'

const BROTLI_OPTS = { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }

const gzipAsync = promisify(gzip)
const brotliCompressAsync = promisify(brotliCompress)

const ASYNC_COMPRESS_THRESHOLD = 50 * 1024

export function compress(raw, encoding) {
  return encoding === 'br' ? brotliCompressSync(raw, BROTLI_OPTS) : gzipSync(raw)
}

export async function compressAsync(raw, encoding) {
  if (raw.length < ASYNC_COMPRESS_THRESHOLD) return compress(raw, encoding)
  return encoding === 'br' ? brotliCompressAsync(raw, BROTLI_OPTS) : gzipAsync(raw)
}

export const GZIP_EXTENSIONS = new Set(['.glb', '.vrm', '.gltf', '.js', '.mjs', '.css', '.html', '.json', '.wasm'])

export const MAX_CACHEABLE_BYTES = 20 * 1024 * 1024

const CACHE_BYTE_BUDGET = 256 * 1024 * 1024

export class ByteBudgetLRU {
  constructor(budget) {
    this.budget = budget
    this.bytes = 0
    this.map = new Map()
  }
  _sizeOf(entry) {
    let n = entry.raw ? entry.raw.length : 0
    if (entry.variants) for (const v of entry.variants.values()) n += v.length
    if (entry.content) n += entry.content.length
    return n
  }
  get(key) {
    const entry = this.map.get(key)
    if (!entry) return undefined
    this.map.delete(key)
    this.map.set(key, entry)
    return entry
  }
  set(key, entry) {
    const prior = this.map.get(key)
    if (prior) this.bytes -= this._sizeOf(prior)
    this.map.delete(key)
    this.map.set(key, entry)
    this.bytes += this._sizeOf(entry)
    this._evictOverBudget()
  }
  resync(key) {
    if (!this.map.has(key)) return
    let total = 0
    for (const entry of this.map.values()) total += this._sizeOf(entry)
    this.bytes = total
    this._evictOverBudget()
  }
  delete(key) {
    const entry = this.map.get(key)
    if (entry) this.bytes -= this._sizeOf(entry)
    this.map.delete(key)
  }
  _evictOverBudget() {
    while (this.bytes > this.budget && this.map.size > 0) {
      const oldestKey = this.map.keys().next().value
      this.delete(oldestKey)
    }
  }
}

export const fileCache = new ByteBudgetLRU(CACHE_BYTE_BUDGET)
export const transformedCache = new ByteBudgetLRU(CACHE_BYTE_BUDGET)

const _contentHashCache = new Map()
export function contentHashETag(fp, raw, mtime) {
  const cached = _contentHashCache.get(fp)
  if (cached && cached.mtime === mtime) return cached.hash
  const hex = fnv1aBytes(raw).toString(16)
  _contentHashCache.set(fp, { mtime, hash: hex })
  return hex
}
export function isNodeModulesPath(fp) {
  return fp.includes(sep + 'node_modules' + sep) || fp.endsWith(sep + 'node_modules')
}

export const STATIC_CACHE_DIR = resolve(process.env.SPOINT_STATIC_CACHE_DIR || join(process.cwd(), '.spoint-cache', 'static'))

const STATIC_CACHE_CODE_VERSION = fnv1aBytes(Buffer.concat([
  readFileSync(fileURLToPath(import.meta.url)),
  Buffer.from(`${process.versions.zlib}|${process.versions.brotli}|${JSON.stringify(BROTLI_OPTS)}`)
])).toString(16)

const ENCODING_EXT = { br: 'br', gzip: 'gz' }
const STALE_TMP_MS = 60 * 1000

function cacheEntryPaths(fp, encoding) {
  const key = fnv1aBytes(Buffer.from(resolve(fp))).toString(16) + '-' + basename(fp).replace(/[^\w.-]/g, '_') + '.' + ENCODING_EXT[encoding]
  const body = join(STATIC_CACHE_DIR, key)
  return { body, meta: body + '.meta' }
}

function readCacheEntry(fp, encoding, stamp) {
  const { body, meta } = cacheEntryPaths(fp, encoding)
  if (!existsSync(body) || !existsSync(meta)) return null
  try {
    const m = JSON.parse(readFileSync(meta, 'utf8'))
    if (m.codeVersion !== STATIC_CACHE_CODE_VERSION || m.src !== resolve(fp) || m.stamp !== stamp) return null
    const content = readFileSync(body)
    if (content.length !== m.bytes || fnv1aBytes(content).toString(16) !== m.hash) return null
    return content
  } catch { return null }
}

function writeAtomic(path, data) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

function writeCacheEntry(fp, encoding, stamp, content) {
  const { body, meta } = cacheEntryPaths(fp, encoding)
  try {
    mkdirSync(STATIC_CACHE_DIR, { recursive: true })
    writeAtomic(body, content)
    writeAtomic(meta, JSON.stringify({ src: resolve(fp), stamp, codeVersion: STATIC_CACHE_CODE_VERSION, bytes: content.length, hash: fnv1aBytes(content).toString(16) }))
  } catch (e) {
    console.warn(`[static-cache] write skipped for ${fp}: ${e?.message || e}`)
  }
}

export function pruneStaticCache() {
  let removed = 0
  let names
  try { names = readdirSync(STATIC_CACHE_DIR) } catch { return 0 }
  for (const name of names) {
    if (name.includes('.tmp-')) {
      const tmp = join(STATIC_CACHE_DIR, name)
      try { if (Date.now() - statSync(tmp).mtimeMs > STALE_TMP_MS) { rmSync(tmp, { force: true }); removed++ } } catch { }
      continue
    }
    if (!name.endsWith('.meta')) continue
    const meta = join(STATIC_CACHE_DIR, name)
    let keep = false
    try {
      const m = JSON.parse(readFileSync(meta, 'utf8'))
      keep = m.codeVersion === STATIC_CACHE_CODE_VERSION && typeof m.src === 'string' && existsSync(m.src.replace(/#transformed$/, ''))
    } catch { }
    if (keep) continue
    rmSync(meta, { force: true })
    rmSync(meta.slice(0, -'.meta'.length), { force: true })
    removed++
  }
  return removed
}

export async function getCached(fp, ext, encoding) {
  const key = fp
  const mtime = statSync(fp).mtimeMs
  let cached = fileCache.get(key)
  const size = cached?.raw ? cached.raw.length : statSync(fp).size
  const cacheable = size <= MAX_CACHEABLE_BYTES
  if (!cached || cached.mtime !== mtime) {
    const raw = readFileSync(fp)
    cached = { mtime, raw, variants: new Map() }
    if (raw.length <= MAX_CACHEABLE_BYTES) fileCache.set(key, cached)
    else fileCache.delete(key)
  }
  const shouldCompress = encoding && GZIP_EXTENSIONS.has(ext) && cached.raw.length > 100
  if (!shouldCompress) return { mtime: cached.mtime, content: cached.raw, encoding: null, raw: cached.raw }
  let variant = cached.variants.get(encoding)
  if (!variant) {
    const stamp = `mtime:${cached.mtime}`
    variant = readCacheEntry(fp, encoding, stamp)
    if (!variant) {
      variant = await compressAsync(cached.raw, encoding)
      writeCacheEntry(fp, encoding, stamp, variant)
    }
    cached.variants.set(encoding, variant)
    if (cacheable) fileCache.resync(key)
  }
  return { mtime: cached.mtime, content: variant, encoding, raw: cached.raw }
}

export async function getTransformedCached(fp, srcMtime, rawBuffer, encoding, contentHash = null) {
  let cached = transformedCache.get(fp)
  if (!cached || cached.srcMtime !== srcMtime) {
    cached = { srcMtime, variants: new Map(), raw: rawBuffer.length <= MAX_CACHEABLE_BYTES ? rawBuffer : null }
    if (rawBuffer.length <= MAX_CACHEABLE_BYTES) transformedCache.set(fp, cached)
    else transformedCache.delete(fp)
  }
  if (!encoding) return { srcMtime, content: rawBuffer, encoding: null }
  let variant = cached.variants.get(encoding)
  if (!variant) {
    const stamp = contentHash ? `transformed:${contentHash}` : null
    variant = stamp ? readCacheEntry(fp + '#transformed', encoding, stamp) : null
    if (!variant) {
      variant = await compressAsync(rawBuffer, encoding)
      if (stamp) writeCacheEntry(fp + '#transformed', encoding, stamp, variant)
    }
    cached.variants.set(encoding, variant)
    if (rawBuffer.length <= MAX_CACHEABLE_BYTES) transformedCache.resync(fp)
  }
  return { srcMtime, content: variant, encoding }
}

const PREWARM_SKIP_DIRS = new Set(['node_modules', '.glb-cache', '.progressive-cache', '.git'])

export async function prewarmCompression(dirs) {
  const pruned = pruneStaticCache()
  if (pruned) console.log(`[static-cache] pruned ${pruned} stale entr${pruned === 1 ? 'y' : 'ies'} from ${STATIC_CACHE_DIR}`)
  let count = 0
  async function walk(dir) {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isDirectory() && PREWARM_SKIP_DIRS.has(e.name)) continue
      const fp = join(dir, e.name)
      if (e.isDirectory()) { await walk(fp); continue }
      const ext = extname(e.name)
      if (!GZIP_EXTENSIONS.has(ext)) continue
      try {
        if (statSync(fp).size <= 100) continue
        await getCached(fp, ext, 'br')
        await getCached(fp, ext, 'gzip')
        count++
      } catch { }
    }
  }
  for (const { dir, prefix } of dirs) {
    if (prefix === '/node_modules/' || dir.endsWith(sep + 'node_modules') || dir.endsWith('/node_modules')) continue
    await walk(dir)
  }
  return count
}

export function parseRange(rangeHeader, totalSize) {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) return null
  const spec = rangeHeader.slice(6).split(',')[0].trim()
  const m = /^(\d*)-(\d*)$/.exec(spec)
  if (!m) return null
  let start, end
  if (m[1] === '' && m[2] === '') return null
  if (m[1] === '') {
    const suffixLen = parseInt(m[2], 10)
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) return null
    start = Math.max(0, totalSize - suffixLen)
    end = totalSize - 1
  } else {
    start = parseInt(m[1], 10)
    end = m[2] === '' ? totalSize - 1 : parseInt(m[2], 10)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || start >= totalSize) return null
  end = Math.min(end, totalSize - 1)
  return { start, end }
}

export function serveRangeable(req, res, buf, headers) {
  headers['Accept-Ranges'] = 'bytes'
  const range = parseRange(req.headers['range'], buf.length)
  if (!range) {
    headers['Content-Length'] = buf.length
    res.writeHead(200, headers)
    res.end(buf)
    return
  }
  const { start, end } = range
  headers['Content-Range'] = `bytes ${start}-${end}/${buf.length}`
  headers['Content-Length'] = end - start + 1
  delete headers['ETag']
  res.writeHead(206, headers)
  res.end(buf.subarray(start, end + 1))
}
