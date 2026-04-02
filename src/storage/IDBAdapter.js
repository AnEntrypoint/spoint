import { StorageAdapter } from './StorageAdapter.js'

const DB_NAME = 'spawnpoint-server-storage'
const DB_VERSION = 1
const STORE = 'kv'

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = e => e.target.result.createObjectStore(STORE)
    req.onsuccess = e => resolve(e.target.result)
    req.onerror = () => reject(req.error)
  })
}

export class IDBAdapter extends StorageAdapter {
  constructor() {
    super()
    this._db = typeof indexedDB !== 'undefined' ? openDB().catch(() => null) : Promise.resolve(null)
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
