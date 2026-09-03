// Byte-budgeted LRU caching + gzip/brotli compression infrastructure for StaticHandler.js's static
// file server: raw file bytes, compressed variants, and transformed (GLB/VRM-optimized) variants.
// No HTTP request/response handling here -- pure caching/compression, split out for a smaller,
// single-responsibility file.

import { readFileSync, existsSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { join, extname, sep } from 'node:path'
import { gzipSync, brotliCompressSync, gzip, brotliCompress, constants as zlibConstants } from 'node:zlib'
import { promisify } from 'node:util'

// quality 5: q11 default is 100x+ slower for marginal gain; q5 still beats gzip -6 by ~14% (measured on anim-lib.glb)
const BROTLI_OPTS = { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }

const gzipAsync = promisify(gzip)
const brotliCompressAsync = promisify(brotliCompress)

// Below this size, the sync zlib call costs sub-millisecond -- not worth the promise/microtask
// overhead, and small-file callers (e.g. tests driving the handler with a bare mock `res` and
// reading `res` synchronously right after the call returns) rely on the response being written
// before the call returns. Above it (large JS bundles, GLB/VRM/wasm) sync compression can run
// long enough to visibly stall the 128Hz tick sharing this event loop, so it goes through the
// async zlib API instead.
const ASYNC_COMPRESS_THRESHOLD = 50 * 1024

export function compress(raw, encoding) {
  return encoding === 'br' ? brotliCompressSync(raw, BROTLI_OPTS) : gzipSync(raw)
}

export async function compressAsync(raw, encoding) {
  if (raw.length < ASYNC_COMPRESS_THRESHOLD) return compress(raw, encoding)
  return encoding === 'br' ? brotliCompressAsync(raw, BROTLI_OPTS) : gzipAsync(raw)
}

// excludes already-compressed/high-entropy image formats; GLB/VRM/glTF still win since they carry uncompressed JSON+animation data
export const GZIP_EXTENSIONS = new Set(['.glb', '.vrm', '.gltf', '.js', '.mjs', '.css', '.html', '.json'])

// Raw bytes for anything bigger than this never enter the in-memory cache -- a single huge asset
// (large baked GLB, video, etc) would otherwise dominate the byte budget and evict everything else
// for one requester's benefit. Still served fine, just re-read from disk (OS page cache absorbs the
// repeat cost) instead of being pinned in process memory.
export const MAX_CACHEABLE_BYTES = 20 * 1024 * 1024

// Total byte budget across both LRU caches combined (raw file bytes + compressed variants +
// transformed/optimized GLB variants). Split proportionally isn't necessary -- one shared budget,
// evicted oldest-first, keeps the accounting simple and self-balancing between the two caches.
const CACHE_BYTE_BUDGET = 256 * 1024 * 1024

// Minimal Map-based LRU: `Map` iterates insertion order, so a re-set on touch (delete+set) moves an
// entry to the "most recently used" end for free, and eviction just shifts from the front.
export class ByteBudgetLRU {
  constructor(budget) {
    this.budget = budget
    this.bytes = 0
    this.map = new Map()
  }
  _sizeOf(entry) {
    // entry.raw for fileCache rows, entry.variants Map values, entry.content for pass-through rows
    let n = entry.raw ? entry.raw.length : 0
    if (entry.variants) for (const v of entry.variants.values()) n += v.length
    if (entry.content) n += entry.content.length
    return n
  }
  get(key) {
    const entry = this.map.get(key)
    if (!entry) return undefined
    // touch: move to MRU position
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
  // call after mutating an entry already in the map in-place (e.g. adding a new compressed variant)
  // so the tracked byte total stays accurate without a full re-set/re-promote.
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

// Content-hash ETag for /node_modules: third-party deps are re-materialized byte-identical on every
// redeploy (fresh `npm install`/checkout gives every file a NEW mtime even when its bytes didn't
// change), so an mtime-based ETag (the general path below) forces a needless revalidation round-trip
// on every redeploy. Hashing raw content instead means an unchanged file keeps the SAME ETag across
// redeploys, so a client's cached copy still 304s. Same fnv1a-1a used by SnapshotEncoder.js for
// dirty-detection -- non-cryptographic, fast, adequate for a weak validator (ETag is not a security
// boundary). Cached per (path, mtime) so a warm process only hashes each file once; a real content
// edit still gets a fresh mtime and recomputes.
const _contentHashCache = new Map() // fp -> { mtime, hash }
export function contentHashETag(fp, raw, mtime) {
  const cached = _contentHashCache.get(fp)
  if (cached && cached.mtime === mtime) return cached.hash
  let hash = 2166136261
  for (let i = 0; i < raw.length; i++) { hash ^= raw[i]; hash = Math.imul(hash, 16777619) }
  const hex = (hash >>> 0).toString(16)
  _contentHashCache.set(fp, { mtime, hash: hex })
  return hex
}
export function isNodeModulesPath(fp) {
  return fp.includes(sep + 'node_modules' + sep) || fp.endsWith(sep + 'node_modules')
}

const SIBLING_EXT = { br: '.br', gzip: '.gz' }

// Disk-persisted sibling (<file>.br / <file>.gz next to the source) so a compressed variant
// survives a process restart/redeploy instead of being recomputed from scratch every boot --
// this is the actual "precompress at bake time" behavior; the in-memory Map above is still the
// hot per-process cache layered on top so a warm process never touches disk twice for the same
// (file, encoding) pair. A stale sibling (source mtime moved on) is detected via a ".meta" JSON
// stamp recording the source mtime it was built from, same pattern as GLBTransformer's cache.
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
  } catch { /* read-only fs (e.g. some CDN/edge mounts) -- in-memory cache above still serves fine */ }
}

// lazily-populated compressed variants keyed by encoding, so each of a br- and non-br-capable client pays the compression cost once
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

export async function getTransformedCached(fp, srcMtime, rawBuffer, encoding) {
  let cached = transformedCache.get(fp)
  if (!cached || cached.srcMtime !== srcMtime) {
    cached = { srcMtime, variants: new Map(), raw: rawBuffer.length <= MAX_CACHEABLE_BYTES ? rawBuffer : null }
    if (rawBuffer.length <= MAX_CACHEABLE_BYTES) transformedCache.set(fp, cached)
    else transformedCache.delete(fp)
  }
  if (!encoding) return { srcMtime, content: rawBuffer, encoding: null }
  let variant = cached.variants.get(encoding)
  if (!variant) {
    variant = await compressAsync(rawBuffer, encoding)
    cached.variants.set(encoding, variant)
    if (rawBuffer.length <= MAX_CACHEABLE_BYTES) transformedCache.resync(fp)
  }
  return { srcMtime, content: variant, encoding }
}

// Bake-time precompression: walk each mounted static dir and populate the .br/.gz disk siblings
// for every GZIP_EXTENSIONS file up front, so the very first request for any given asset already
// hits a warm sibling instead of paying brotli-q5 compression inline. Safe to call repeatedly
// (mtime-gated, same as the lazy path) -- intended to run once at server boot, backgrounded.
// A node_modules-rooted mount (third-party deps, can be 10⁴-10⁵ files) is deliberately excluded --
// walking + brotli-compressing the whole dependency tree at boot is unbounded work for code this
// app doesn't own; those files still compress fine on the lazy per-request path (getCached), just
// without the boot-time head start. Same for any nested node_modules encountered mid-walk.
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
      } catch { /* unreadable file -- skip, request-time path still covers it */ }
    }
  }
  for (const { dir, prefix } of dirs) {
    if (prefix === '/node_modules/' || dir.endsWith(sep + 'node_modules') || dir.endsWith('/node_modules')) continue
    await walk(dir)
  }
  return count
}

// Parses a single-range `Range: bytes=start-end` header (the only form browsers/download managers
// send for a resumed GLB/wasm fetch; multi-range is not worth supporting here). Returns null for
// anything absent/malformed/unsatisfiable so the caller falls back to a plain 200.
export function parseRange(rangeHeader, totalSize) {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) return null
  const spec = rangeHeader.slice(6).split(',')[0].trim()
  const m = /^(\d*)-(\d*)$/.exec(spec)
  if (!m) return null
  let start, end
  if (m[1] === '' && m[2] === '') return null
  if (m[1] === '') {
    // suffix range: last N bytes
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

// Range/206 is only meaningful against the UNCOMPRESSED body -- a byte offset into a brotli/gzip
// stream is meaningless to the client, so a Range request always gets the identity encoding.
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
  delete headers['ETag'] // ETag above was computed for the whole-file 200 case; a 206 still names the same resource via Content-Range so omit rather than mismatch
  res.writeHead(206, headers)
  res.end(buf.subarray(start, end + 1))
}
