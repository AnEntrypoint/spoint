import { get, put, remove } from './IndexedDBStore.js'

const DB_NAME = 'spawnpoint-model-cache'
const DB_VERSION = 1
const STORE = 'models'

export async function dbPut(key, etag, buffer) {
  try { await put(DB_NAME, DB_VERSION, STORE, key, { etag, buffer }) } catch { }
}

export async function dbDelete(key) {
  try { await remove(DB_NAME, DB_VERSION, STORE, key) } catch { }
}

export async function fetchCached(url, onProgress) {
  let cached = null
  try { cached = await get(DB_NAME, DB_VERSION, STORE, url) } catch { }

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
    try { await put(DB_NAME, DB_VERSION, STORE, url, { etag, buffer: result.buffer }) } catch { }
  }

  return result
}
