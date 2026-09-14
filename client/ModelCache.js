import { get, put, remove, clearStore } from './IndexedDBStore.js'

const DB_NAME = 'spoint-model-cache'
const DB_VERSION = 1
const STORE = 'models'
const MANIFEST_KEY = 'lru-manifest'
export const SOFT_CAP = 150 * 1024 * 1024
export const HARD_CAP = 200 * 1024 * 1024
const MANIFEST_TOUCH_DEBOUNCE_MS = 1000
const REVALIDATE_FRESH_MS = 10 * 60 * 1000

if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.persist === 'function') {
  try { navigator.storage.persist().catch(() => {}) } catch { }
}

export async function dbPut(key, etag, buffer) {
  try { await put(DB_NAME, DB_VERSION, STORE, key, { etag, buffer }) } catch { }
}

export async function dbDelete(key) {
  try { await remove(DB_NAME, DB_VERSION, STORE, key) } catch { }
}

let _manifestMem = null
async function _readManifest() {
  if (_manifestMem) return _manifestMem
  try {
    const m = await get(DB_NAME, DB_VERSION, STORE, MANIFEST_KEY)
    _manifestMem = (m && typeof m === 'object' && !m.etag) ? m : {}
  } catch { _manifestMem = {} }
  return _manifestMem
}

async function _writeManifest(manifest) {
  _manifestMem = manifest
  try { await put(DB_NAME, DB_VERSION, STORE, MANIFEST_KEY, manifest) } catch { }
}

let _pendingTouches = null
let _touchFlushTimer = null

async function _flushPendingTouches() {
  _touchFlushTimer = null
  if (!_pendingTouches || _pendingTouches.size === 0) return
  const touches = _pendingTouches
  _pendingTouches = null
  const manifest = await _readManifest()
  for (const [url, entry] of touches) manifest[url] = { ...(manifest[url] || {}), ...entry }
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
  let result
  if (chunks.length === 1 && chunks[0].byteOffset === 0 && chunks[0].buffer.byteLength === chunks[0].byteLength) {
    result = chunks[0]
  } else {
    result = new Uint8Array(received)
    let pos = 0
    for (const chunk of chunks) { result.set(chunk, pos); pos += chunk.length }
  }
  if (etag) {
    try {
      await put(DB_NAME, DB_VERSION, STORE, url, { etag, buffer: result.buffer })
      const manifest = await _readManifest()
      const now = Date.now()
      manifest[url] = { size: result.byteLength, lastAccess: now, lastRevalidated: now }
      await _writeManifest(await _pruneManifest(manifest))
    } catch { }
  }
  return result
}

export async function fetchCached(url, onProgress) {
  let cached = null
  try { cached = await get(DB_NAME, DB_VERSION, STORE, url) } catch { }

  if (cached?.etag) {
    let fresh = false
    try {
      const entry = (await _readManifest())[url]
      fresh = !!entry && Date.now() - (entry.lastRevalidated || 0) < REVALIDATE_FRESH_MS
    } catch { }
    if (!fresh) {
      try {
        const head = await fetch(url, { method: 'HEAD' })
        const serverEtag = head?.headers?.get('etag')
        if (serverEtag && serverEtag !== cached.etag) {
          return _fetchAndCache(url, onProgress)
        }
        if (serverEtag) _stampRevalidated(url)
      } catch { }
    }
    _touchManifest(url, cached.buffer?.byteLength || 0).catch(() => {})
    return new Uint8Array(cached.buffer)
  }

  return _fetchAndCache(url, onProgress)
}

function _stampRevalidated(url) {
  if (!_manifestMem) return
  const entry = _manifestMem[url]
  if (entry) entry.lastRevalidated = Date.now()
}

export async function listManifestEntries() {
  const manifest = await _readManifest()
  return Object.entries(manifest).map(([url, entry]) => ({
    url,
    size: entry?.size || 0,
    lastAccess: entry?.lastAccess || 0,
    lastRevalidated: entry?.lastRevalidated || entry?.lastAccess || 0,
  }))
}

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

export async function getCacheStats() {
  const manifest = await _readManifest()
  const entries = Object.values(manifest)
  const totalBytes = entries.reduce((s, v) => s + (v?.size || 0), 0)
  return { totalBytes, entryCount: entries.length, softCap: SOFT_CAP, hardCap: HARD_CAP }
}

export async function clearCache() {
  if (_touchFlushTimer) { clearTimeout(_touchFlushTimer); _touchFlushTimer = null }
  _pendingTouches = null
  const manifest = await _readManifest()
  const urls = Object.keys(manifest)
  for (const url of urls) {
    await dbDelete(url)
  }
  await clearStore(DB_NAME, DB_VERSION, STORE)
  _manifestMem = {}
  return { cleared: urls.length }
}

if (typeof window !== 'undefined') {
  window.__modelCache = {
    stats: () => getCacheStats(),
    clear: () => clearCache(),
    entries: () => listManifestEntries(),
  }
}
