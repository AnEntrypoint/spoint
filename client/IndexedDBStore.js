const _stores = new Map()

export async function openStore(dbName, dbVersion, storeName) {
  const key = `${dbName}:${storeName}`
  if (_stores.has(key)) return _stores.get(key)

  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, dbVersion)
    req.onupgradeneeded = e => e.target.result.createObjectStore(storeName)
    req.onsuccess = e => resolve(e.target.result)
    req.onerror = () => reject(req.error)
  })
  _stores.set(key, db)
  return db
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
