const DB_NAME = 'spoint-editor-autosave'
const DB_VERSION = 1
const STORE_NAME = 'recovery'
const AUTO_SAVE_INTERVAL_MS = 60000
const RECOVERY_KEY = 'latest'

let _interval = null, _db = null, _dirty = false, _lastSaveMs = 0, _onRestorePrompt = null, _onHidden = null

function _openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE_NAME) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => { console.warn('[EditorAutosave] IndexedDB open failed:', req.error); resolve(null) }
  })
}

async function _ensureDB() {
  if (_db) return _db
  _db = await _openDB()
  return _db
}

async function _writeRecoverySnapshot(data) {
  const db = await _ensureDB()
  if (!db) return false
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      store.put({ key: RECOVERY_KEY, data, savedAt: Date.now() })
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => { console.warn('[EditorAutosave] write failed:', tx.error); resolve(false) }
    } catch (e) { console.warn('[EditorAutosave] write error:', e); resolve(false) }
  })
}

async function _readRecoverySnapshot() {
  const db = await _ensureDB()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const req = store.get(RECOVERY_KEY)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => { console.warn('[EditorAutosave] read failed:', req.error); resolve(null) }
    } catch (e) { console.warn('[EditorAutosave] read error:', e); resolve(null) }
  })
}

async function _deleteRecoverySnapshot() {
  const db = await _ensureDB()
  if (!db) return
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).delete(RECOVERY_KEY)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => resolve(false)
    } catch (e) { resolve(false) }
  })
}

export const EditorAutosave = {
  async checkRecovery() {
    const snap = await _readRecoverySnapshot()
    if (!snap || !snap.data) return
    if (_onRestorePrompt) {
      _onRestorePrompt(snap.savedAt, snap.data)
    }
  },

  install({ beginSave, onRestorePrompt, onDirtyChange }) {
    _onRestorePrompt = onRestorePrompt || null
    if (onDirtyChange) {
      const origDirty = onDirtyChange
      const wrapped = (dirty) => { _dirty = dirty; origDirty(dirty) }
      return wrapped
    }

    _interval = setInterval(async () => {
      if (!_dirty) return
      if (Date.now() - _lastSaveMs < AUTO_SAVE_INTERVAL_MS / 2) return
      _lastSaveMs = Date.now()
      try {
        const data = beginSave ? await beginSave() : null
        if (data) {
          await _writeRecoverySnapshot(data)
          console.log('[EditorAutosave] autosaved at', new Date().toISOString())
        }
      } catch (e) {
        console.warn('[EditorAutosave] autosave failed:', e)
      }
    }, AUTO_SAVE_INTERVAL_MS)

    if (typeof document !== 'undefined') {
      _onHidden = async () => {
        if (!document.hidden || !_dirty) return
        try {
          const data = beginSave ? await beginSave() : null
          if (data) await _writeRecoverySnapshot(data)
        } catch (e) { }
      }
      document.addEventListener('visibilitychange', _onHidden)
    }
  },

  async clearRecovery() {
    await _deleteRecoverySnapshot()
    _lastSaveMs = Date.now()
  },

  dispose() {
    if (_interval) {
      clearInterval(_interval)
      _interval = null
    }
    if (_onHidden && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', _onHidden)
      _onHidden = null
    }
  },

  markDirty() { _dirty = true },

  markClean() { _dirty = false },

  get isDirty() { return _dirty },
  get lastSaveMs() { return _lastSaveMs }
}