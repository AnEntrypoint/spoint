const _stores = new Map()

export async function openStore(dbName, dbVersion, storeName) {
  const key = `${dbName}:${storeName}`
  if (_stores.has(key)) return _stores.get(key)

  const p = new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, dbVersion)
    req.onupgradeneeded = e => { const d = e.target.result; if (!d.objectStoreNames.contains(storeName)) d.createObjectStore(storeName) }
    req.onsuccess = e => resolve(e.target.result)
    req.onerror = () => { _stores.delete(key); reject(req.error) }
  })
  _stores.set(key, p)
  return p
}

export async function get(dbName, dbVersion, storeName, key) {
  try {
    const db = await openStore(dbName, dbVersion, storeName)
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly')
      const req = tx.objectStore(storeName).get(key)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } catch {
    return null
  }
}

export async function put(dbName, dbVersion, storeName, key, value) {
  try {
    const db = await openStore(dbName, dbVersion, storeName)
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite')
      const req = tx.objectStore(storeName).put(value, key)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } catch {}
}

export async function remove(dbName, dbVersion, storeName, key) {
  try {
    const db = await openStore(dbName, dbVersion, storeName)
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite')
      const req = tx.objectStore(storeName).delete(key)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } catch {}
}

// clearStore -- wipes every key in one object store (IDBObjectStore.clear()), for consumers that
// need a bulk reset (e.g. a user-initiated "clear cache" action) rather than deleting keys one at a
// time. Kept as its own primitive alongside get/put/remove rather than a loop over listed keys --
// clear() is a single native IDB request, cheaper and atomic vs N individual delete transactions.
export async function clearStore(dbName, dbVersion, storeName) {
  try {
    const db = await openStore(dbName, dbVersion, storeName)
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite')
      const req = tx.objectStore(storeName).clear()
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } catch {}
}
