const DB_NAME = 'spoint-editor'
const STORE_NAME = 'undo-history'
const MAX_ENTRIES = 100

function _dbKey(worldId) {
  return `history:${worldId}`
}

async function _openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true })
      }
    }
  })
}

async function _saveEntry(db, worldId, entry) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const data = { worldId, entry, ts: Date.now(), seq: entry.txnId }
    const req = store.add(data)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(req.result)
  })
}

async function _loadEntries(db, worldId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const req = store.getAll()
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const items = req.result.filter(d => d.worldId === worldId).sort((a, b) => a.seq - b.seq)
      resolve(items.slice(-MAX_ENTRIES).map(d => d.entry))
    }
  })
}

async function _clearEntries(db, worldId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const req = store.getAll()
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const toDelete = req.result.filter(d => d.worldId === worldId)
      for (const item of toDelete) {
        const delReq = store.delete(item.id)
        delReq.onerror = () => reject(delReq.error)
      }
      resolve()
    }
  })
}

async function _cleanup(db, worldId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const req = store.getAll()
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const items = req.result.filter(d => d.worldId === worldId).sort((a, b) => a.seq - b.seq)
      if (items.length > MAX_ENTRIES) {
        const excess = items.slice(0, items.length - MAX_ENTRIES)
        for (const item of excess) {
          const delReq = store.delete(item.id)
          delReq.onerror = () => reject(delReq.error)
        }
      }
      resolve()
    }
  })
}

export function createPersistentHistory(worldId) {
  let _db = null
  let _inMemory = []
  let _ready = false

  async function _init() {
    try {
      _db = await _openDB()
      _inMemory = await _loadEntries(_db, worldId)
      _ready = true
    } catch (e) {
      console.warn('[PersistentHistory] init failed, falling back to in-memory:', e?.message)
      _ready = true
    }
  }

  async function add(entry) {
    if (!_ready) await _init()
    _inMemory.push(entry)
    if (_db) {
      try {
        await _saveEntry(_db, worldId, entry)
        await _cleanup(_db, worldId)
      } catch (e) {
        console.warn('[PersistentHistory] save failed:', e?.message)
      }
    }
  }

  async function load() {
    if (!_ready) await _init()
    return [..._inMemory]
  }

  async function clear() {
    if (!_ready) await _init()
    _inMemory = []
    if (_db) {
      try {
        await _clearEntries(_db, worldId)
      } catch (e) {
        console.warn('[PersistentHistory] clear failed:', e?.message)
      }
    }
  }

  _init().catch(e => console.warn('[PersistentHistory] async init failed:', e?.message))

  return { add, load, clear }
}
