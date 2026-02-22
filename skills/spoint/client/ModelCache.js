const DB_NAME = 'spawnpoint-model-cache'
const DB_VERSION = 1
const STORE = 'models'

let _db = null

async function openDB() {
  if (_db) return _db
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = e => e.target.result.createObjectStore(STORE)
    req.onsuccess = e => { _db = e.target.result; resolve(_db) }
    req.onerror = () => reject(req.error)
  })
}

async function dbGet(key) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function dbPut(key, value) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const req = tx.objectStore(STORE).put(value, key)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export async function fetchCached(url, onProgress) {
  let cached = null
  try { cached = await dbGet(url) } catch {}

  if (cached?.etag) {
    const head = await fetch(url, { method: 'HEAD' }).catch(() => null)
    const serverEtag = head?.headers?.get('etag')
    if (serverEtag && serverEtag === cached.etag) {
      return new Uint8Array(cached.buffer)
    }
  }

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
    try { await dbPut(url, { etag, buffer: result.buffer }) } catch {}
  }

  return result
}
