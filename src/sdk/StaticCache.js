import { readFileSync, existsSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { join, extname, sep } from 'node:path'
import { gzipSync, brotliCompressSync, gzip, brotliCompress, constants as zlibConstants } from 'node:zlib'
import { promisify } from 'node:util'

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

const FNV1A_OFFSET_BASIS = 2166136261
const FNV1A_PRIME = 16777619
const _contentHashCache = new Map()
export function contentHashETag(fp, raw, mtime) {
  const cached = _contentHashCache.get(fp)
  if (cached && cached.mtime === mtime) return cached.hash
  let hash = FNV1A_OFFSET_BASIS
  for (let i = 0; i < raw.length; i++) { hash ^= raw[i]; hash = Math.imul(hash, FNV1A_PRIME) }
  const hex = (hash >>> 0).toString(16)
  _contentHashCache.set(fp, { mtime, hash: hex })
  return hex
}
export function isNodeModulesPath(fp) {
  return fp.includes(sep + 'node_modules' + sep) || fp.endsWith(sep + 'node_modules')
}

const SIBLING_EXT = { br: '.br', gzip: '.gz' }

function siblingPaths(fp, encoding) {
  const ext = SIBLING_EXT[encoding]
  return { body: fp + ext, meta: fp + ext + '.meta' }
}

function readSiblingIfFresh(fp, encoding, srcMtime) {
  const { body, meta } = siblingPaths(fp, encoding)
  if (!existsSync(body) || !existsSync(meta)) return null
  try {
    const m = JSON.parse(readFileSync(meta, 'utf8'))
    if (m.srcMtime !== srcMtime) return null
    return readFileSync(body)
  } catch { return null }
}

function writeSibling(fp, encoding, srcMtime, content) {
  const { body, meta } = siblingPaths(fp, encoding)
  try {
    writeFileSync(body, content)
    writeFileSync(meta, JSON.stringify({ srcMtime }))
  } catch { }
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
    variant = readSiblingIfFresh(fp, encoding, cached.mtime)
    if (!variant) {
      variant = await compressAsync(cached.raw, encoding)
      writeSibling(fp, encoding, cached.mtime, variant)
    }
    cached.variants.set(encoding, variant)
    if (cacheable) fileCache.resync(key)
  }
  return { mtime: cached.mtime, content: variant, encoding, raw: cached.raw }
}

function readTransformedSibling(base, encoding, hash) {
  if (!base || !hash) return null
  const { body, meta } = siblingPaths(base, encoding)
  if (!existsSync(body) || !existsSync(meta)) return null
  try {
    const m = JSON.parse(readFileSync(meta, 'utf8'))
    if (m.hash !== hash) return null
    return readFileSync(body)
  } catch { return null }
}

function writeTransformedSibling(base, encoding, hash, content) {
  if (!base || !hash) return
  const { body, meta } = siblingPaths(base, encoding)
  try {
    writeFileSync(body, content)
    writeFileSync(meta, JSON.stringify({ hash }))
  } catch { }
}

export async function getTransformedCached(fp, srcMtime, rawBuffer, encoding, sibling = null) {
  let cached = transformedCache.get(fp)
  if (!cached || cached.srcMtime !== srcMtime) {
    cached = { srcMtime, variants: new Map(), raw: rawBuffer.length <= MAX_CACHEABLE_BYTES ? rawBuffer : null }
    if (rawBuffer.length <= MAX_CACHEABLE_BYTES) transformedCache.set(fp, cached)
    else transformedCache.delete(fp)
  }
  if (!encoding) return { srcMtime, content: rawBuffer, encoding: null }
  let variant = cached.variants.get(encoding)
  if (!variant) {
    variant = readTransformedSibling(sibling?.base, encoding, sibling?.hash)
    if (!variant) {
      variant = await compressAsync(rawBuffer, encoding)
      writeTransformedSibling(sibling?.base, encoding, sibling?.hash, variant)
    }
    cached.variants.set(encoding, variant)
    if (rawBuffer.length <= MAX_CACHEABLE_BYTES) transformedCache.resync(fp)
  }
  return { srcMtime, content: variant, encoding }
}

const PREWARM_SKIP_DIRS = new Set(['node_modules', '.glb-cache', '.progressive-cache', '.git'])

export async function prewarmCompression(dirs) {
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
      if (ext === '.br' || ext === '.gz') continue
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
