import { get, put, remove } from './IndexedDBStore.js'

const DB_NAME = 'spawnpoint-model-cache'
const DB_VERSION = 1
const STORE = 'models'
const MANIFEST_KEY = 'lru-manifest'
const SOFT_CAP = 150 * 1024 * 1024
const HARD_CAP = 200 * 1024 * 1024

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

async function _touchManifest(url, size) {
  const manifest = await _readManifest()
  manifest[url] = { size, lastAccess: Date.now() }
  await _writeManifest(manifest)
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
