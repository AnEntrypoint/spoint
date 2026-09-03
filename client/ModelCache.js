import { get, put, remove, clearStore } from './IndexedDBStore.js'

const DB_NAME = 'spoint-model-cache'
const DB_VERSION = 1
const STORE = 'models'
const MANIFEST_KEY = 'lru-manifest'
export const SOFT_CAP = 150 * 1024 * 1024
export const HARD_CAP = 200 * 1024 * 1024
const MANIFEST_TOUCH_DEBOUNCE_MS = 1000

// One-time feature-detected persistence request: asks the browser not to evict this origin's
// IndexedDB cache under storage pressure. Fire-and-forget, best-effort -- absent in some browsers
// (e.g. Safari) and can be denied by the user/browser, either of which is fine since the LRU
// prune logic already handles eviction gracefully.
if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.persist === 'function') {
  try { navigator.storage.persist().catch(() => {}) } catch { }
}

export async function dbPut(key, etag, buffer) {
  try { await put(DB_NAME, DB_VERSION, STORE, key, { etag, buffer }) } catch { }
}

export async function dbDelete(key) {
  try { await remove(DB_NAME, DB_VERSION, STORE, key) } catch { }
}

async function _readManifest() {
  try {
    const m = await get(DB_NAME, DB_VERSION, STORE, MANIFEST_KEY)
    return (m && typeof m === 'object' && !m.etag) ? m : {}
  } catch { return {} }
}

async function _writeManifest(manifest) {
  try { await put(DB_NAME, DB_VERSION, STORE, MANIFEST_KEY, manifest) } catch { }
}

// Debounced manifest touch: fetchCached() calls this on every cache HIT (i.e. potentially every
// asset load, including many in a single burst at world-load time). Writing the full manifest
// read+write on each call serializes IndexedDB traffic against itself for no benefit -- only the
// FINAL lastAccess/size per url matters for LRU pruning. Pending touches are coalesced in memory
// and flushed as one read+write MANIFEST_TOUCH_DEBOUNCE_MS after the last touch in a burst.
let _pendingTouches = null   // Map<url, {size, lastAccess}> accumulated since the last flush
let _touchFlushTimer = null

async function _flushPendingTouches() {
  _touchFlushTimer = null
  if (!_pendingTouches || _pendingTouches.size === 0) return
  const touches = _pendingTouches
  _pendingTouches = null
  const manifest = await _readManifest()
  for (const [url, entry] of touches) manifest[url] = entry
  await _writeManifest(manifest)
}

function _touchManifest(url, size) {
  if (!_pendingTouches) _pendingTouches = new Map()
  _pendingTouches.set(url, { size, lastAccess: Date.now() })
  if (_touchFlushTimer) clearTimeout(_touchFlushTimer)
  _touchFlushTimer = setTimeout(() => { _flushPendingTouches().catch(() => {}) }, MANIFEST_TOUCH_DEBOUNCE_MS)
  return Promise.resolve()
}

async function _pruneManifest(manifest) {
  const entries = Object.entries(manifest)
  let total = entries.reduce((s, [, v]) => s + (v.size || 0), 0)
  if (total <= HARD_CAP) return manifest
  entries.sort((a, b) => a[1].lastAccess - b[1].lastAccess)
  for (const [url] of entries) {
    if (total <= SOFT_CAP) break
    total -= manifest[url]?.size || 0
    delete manifest[url]
    await remove(DB_NAME, DB_VERSION, STORE, url).catch(() => {})
  }
  return manifest
}

async function _fetchAndCache(url, onProgress) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const etag = response.headers.get('etag') || ''
  const contentLength = parseInt(response.headers.get('content-length') || '0', 10)
  const isGzip = (response.headers.get('content-encoding') || '').includes('gzip')
  const useTotal = contentLength > 0 && !isGzip
  const reader = response.body.getReader()
  const chunks = []
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    if (useTotal && onProgress) onProgress(received, contentLength)
  }
  const result = new Uint8Array(received)
  let pos = 0
  for (const chunk of chunks) { result.set(chunk, pos); pos += chunk.length }
  if (etag) {
    try {
      await put(DB_NAME, DB_VERSION, STORE, url, { etag, buffer: result.buffer })
      const manifest = await _readManifest()
      manifest[url] = { size: result.byteLength, lastAccess: Date.now() }
      await _writeManifest(await _pruneManifest(manifest))
    } catch { }
  }
  return result
}

export async function fetchCached(url, onProgress) {
  let cached = null
  try { cached = await get(DB_NAME, DB_VERSION, STORE, url) } catch { }

  if (cached?.etag) {
    try {
      const head = await fetch(url, { method: 'HEAD' })
      const serverEtag = head?.headers?.get('etag')
      if (serverEtag && serverEtag !== cached.etag) {
        return _fetchAndCache(url, onProgress)
      }
    } catch { }
    _touchManifest(url, cached.buffer?.byteLength || 0).catch(() => {})
    return new Uint8Array(cached.buffer)
  }

  return _fetchAndCache(url, onProgress)
}

// ---------------------------------------------------------------------------------------------
// Background revalidation sweep support (client/core/CacheRevalidationSweep.js). fetchCached()
// above only ever revalidates a URL LAZILY, at the moment something re-requests it -- an entry
// loaded once early in a long-lived session/tab and never touched again keeps serving its cached
// bytes indefinitely even after the server-side content-hash ETag has moved on. The sweep walks
// the same LRU manifest this file already maintains and revalidates entries nobody has
// re-requested in a while.
// ---------------------------------------------------------------------------------------------

// listManifestEntries() -> [{ url, size, lastAccess, lastRevalidated }, ...]. Read-only snapshot
// for the sweep to pick staleness candidates from -- never mutates the manifest itself (matches
// the existing _readManifest/_writeManifest split: reads are cheap/frequent, writes are the
// serialized, debounce-guarded resource).
export async function listManifestEntries() {
  const manifest = await _readManifest()
  return Object.entries(manifest).map(([url, entry]) => ({
    url,
    size: entry?.size || 0,
    lastAccess: entry?.lastAccess || 0,
    lastRevalidated: entry?.lastRevalidated || entry?.lastAccess || 0,
  }))
}

// revalidateEntry(url) -> { changed: boolean, missing: boolean }. The actual HEAD+ETag-compare
// primitive, factored out of fetchCached() so the background sweep and the lazy per-fetch path
// share ONE revalidation implementation rather than two copies that can drift. On an ETag
// mismatch this re-downloads and re-caches via the existing _fetchAndCache (same manifest
// accounting/pruning as any other fresh fetch). On a match it stamps lastRevalidated on the
// manifest entry (without disturbing lastAccess, which stays the LRU-eviction signal driven by
// actual USE, not by this sweep's background touch) so the next sweep pass can skip it until the
// staleness threshold elapses again.
export async function revalidateEntry(url) {
  const cached = await get(DB_NAME, DB_VERSION, STORE, url).catch(() => null)
  if (!cached?.etag) return { changed: false, missing: true }
  try {
    const head = await fetch(url, { method: 'HEAD' })
    const serverEtag = head?.headers?.get('etag')
    if (serverEtag && serverEtag !== cached.etag) {
      await _fetchAndCache(url)
      return { changed: true, missing: false }
    }
  } catch {
    return { changed: false, missing: false }
  }
  try {
    const manifest = await _readManifest()
    if (manifest[url]) {
      manifest[url].lastRevalidated = Date.now()
      await _writeManifest(manifest)
    }
  } catch { }
  return { changed: false, missing: false }
}

// ---------------------------------------------------------------------------------------------
// Cache-size budget visibility/control (client/hud/SettingsMenu.js). The SOFT_CAP/HARD_CAP LRU
// eviction above (_pruneManifest) has run silently in the background since it shipped -- a player
// has never had any way to see how much of their disk this cache is using, what's in it, or a
// manual "just clear it" escape hatch. These two functions are the read (getCacheStats) and write
// (clearCache) primitives a UI surface needs, both built from the SAME manifest/dbDelete/clearStore
// primitives every other ModelCache consumer already uses -- no parallel accounting mechanism.
// ---------------------------------------------------------------------------------------------

// getCacheStats() -> { totalBytes, entryCount, softCap, hardCap }. Read-only snapshot of the
// existing LRU manifest -- same source of truth _pruneManifest already enforces caps against, so
// the UI number and the real eviction trigger can never disagree.
export async function getCacheStats() {
  const manifest = await _readManifest()
  const entries = Object.values(manifest)
  const totalBytes = entries.reduce((s, v) => s + (v?.size || 0), 0)
  return { totalBytes, entryCount: entries.length, softCap: SOFT_CAP, hardCap: HARD_CAP }
}

// clearCache() -> { cleared: number }. Manual full wipe: deletes every cached model buffer (via
// the existing dbDelete primitive, one call per manifest entry so a mid-clear failure on one entry
// doesn't abandon the rest) then clears the manifest key itself. Any pending debounced touch flush
// is dropped first so it can't resurrect a stale manifest entry write after the clear completes.
export async function clearCache() {
  if (_touchFlushTimer) { clearTimeout(_touchFlushTimer); _touchFlushTimer = null }
  _pendingTouches = null
  const manifest = await _readManifest()
  const urls = Object.keys(manifest)
  for (const url of urls) {
    await dbDelete(url)
  }
  await clearStore(DB_NAME, DB_VERSION, STORE)
  return { cleared: urls.length }
}

if (typeof window !== 'undefined') {
  window.__modelCache = {
    stats: () => getCacheStats(),
    clear: () => clearCache(),
    entries: () => listManifestEntries(),
  }
}
