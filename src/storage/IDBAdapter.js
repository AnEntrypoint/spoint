import { StorageAdapter } from './StorageAdapter.js'

const DB_NAME = 'spoint-server-storage'
const DB_VERSION = 1
const STORE = 'kv'
// singleplayer-worker-boot-stall-on-cold-backgrounded-tab: a real, documented Chromium behavior for a
// dedicated Worker belonging to a tab that has NEVER been foregrounded/painted -- the storage partition
// backing indexedDB.open() can be deferred indefinitely (neither onsuccess NOR onerror ever fires,
// not even onblocked), because the browser has no urgency signal to actually initialize storage for a
// browsing context it has never composited. openDB() previously had no upper bound at all, so
// WorkerEntry.js's `await storage.get('placed-models')` / `await restoreWorldSnapshot(ctx)` (both routed
// through IDBAdapter._tx -> `await this._db`) could block init() forever on exactly this class of tab --
// the Worker is constructed and running (WORKER_READY already posted before INIT reaches this code), but
// INIT processing itself never completes, so SEND_CLIENT/the player id the main thread's connect()
// promise is waiting on never arrives. IDBAdapter already has a complete, safe degrade path for
// "indexedDB unavailable" (the `this._mem` in-memory Map, same one every write already populates) --
// this reuses that exact path for "indexedDB technically exists but never actually opens", the only
// change being an upper bound on how long init() will wait for it before falling back.
const OPEN_TIMEOUT_MS = 4000

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = e => e.target.result.createObjectStore(STORE)
    req.onsuccess = e => resolve(e.target.result)
    req.onerror = () => reject(req.error)
  })
}

function openDBWithTimeout() {
  return new Promise(resolve => {
    let settled = false
    const finish = db => { if (settled) return; settled = true; resolve(db) }
    // Timer fires even if the Worker's macrotask queue is throttled (never fully halted, unlike rAF --
    // see PlacementScheduler.js's own live-confirmed setInterval-survives-backgrounding finding), so this
    // is a real bound, not a best-effort one; a late openDB() resolution after the timeout is simply
    // ignored (finish is idempotent), matching "storage keeps working via the in-memory map for this
    // session" rather than trying to retroactively swap the backing store out from under live writes.
    setTimeout(() => finish(null), OPEN_TIMEOUT_MS)
    openDB().then(finish).catch(() => finish(null))
  })
}

export class IDBAdapter extends StorageAdapter {
  constructor() {
    super()
    this._db = typeof indexedDB !== 'undefined' ? openDBWithTimeout() : Promise.resolve(null)
    this._mem = new Map()
  }

  async _tx(mode, fn) {
    const db = await this._db
    if (!db) return fn(null)
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const store = tx.objectStore(STORE)
      const req = fn(store)
      if (req) { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error) }
      else tx.oncomplete = () => resolve()
    })
  }

  async get(key) {
    const val = await this._tx('readonly', s => s?.get(key))
    return val !== undefined ? val : this._mem.get(key)
  }

  async set(key, value) {
    this._mem.set(key, value)
    await this._tx('readwrite', s => s?.put(value, key)).catch(() => {})
  }

  async delete(key) {
    this._mem.delete(key)
    await this._tx('readwrite', s => s?.delete(key)).catch(() => {})
  }

  async list(prefix = '') {
    const db = await this._db
    if (!db) return [...this._mem.keys()].filter(k => k.startsWith(prefix))
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).getAllKeys()
      req.onsuccess = () => resolve(req.result.filter(k => String(k).startsWith(prefix)))
      req.onerror = () => reject(req.error)
    })
  }

  async has(key) {
    const val = await this.get(key)
    return val !== undefined
  }
}
