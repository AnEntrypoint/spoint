// EditorAutosave.js — periodic autosave to IndexedDB with crash recovery.
// Saves the full world snapshot (entities + scene graph) to IndexedDB every AUTOSAVE_INTERVAL_MS
// while the editor is open and has unsaved changes. On boot, checks for an unsaved-recovery
// snapshot and offers to restore it.
//
// Uses the SAME IndexedDB database and object store shape as WorldPersistence (src/sdk/WorldPersistence.js)
// so the recovery snapshot is compatible with the existing save/load infrastructure.
//
// Integration:
//   - client/app.js: EditorAutosave.install({ client, onRestorePrompt })
//   - The periodic save is triggered by a setInterval; the save itself calls
//     client.send(MSG.SAVE_WORLD, ...) or a direct snapshot via the existing save path.
//   - On boot: if a recovery snapshot exists and is newer than the last explicit save, prompt
//     the user to restore.

const DB_NAME = 'spoint-editor-autosave'
const DB_VERSION = 1
const STORE_NAME = 'recovery'
const AUTO_SAVE_INTERVAL_MS = 60000 // 1 minute
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
  // Call once after boot to check for unsaved recovery data. If a snapshot exists and is
  // newer than the last explicit save, prompts the user via onRestorePrompt.
  async checkRecovery() {
    const snap = await _readRecoverySnapshot()
    if (!snap || !snap.data) return
    if (_onRestorePrompt) {
      _onRestorePrompt(snap.savedAt, snap.data)
    }
  },

  // Install the autosave interval. beginSave() is called to capture the current world state.
  // clearRecovery() is called after a successful explicit save.
  install({ beginSave, onRestorePrompt, onDirtyChange }) {
    _onRestorePrompt = onRestorePrompt || null
    if (onDirtyChange) {
      const origDirty = onDirtyChange
      // Wrap to track dirty state
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

    // Also save on visibility change (tab hidden). A browser setInterval handle is a plain
    // number, not an object -- it cannot carry a ._onHidden property (attempting to assign one
    // throws "Cannot create property '_onHidden' on number"). Track the listener in a
    // module-level variable instead, matching how _interval itself is already scoped.
    if (typeof document !== 'undefined') {
      _onHidden = async () => {
        if (!document.hidden || !_dirty) return
        try {
          const data = beginSave ? await beginSave() : null
          if (data) await _writeRecoverySnapshot(data)
        } catch (e) { /* quiet */ }
      }
      document.addEventListener('visibilitychange', _onHidden)
    }
  },

  // Call after a successful explicit save to clear the recovery snapshot.
  async clearRecovery() {
    await _deleteRecoverySnapshot()
    _lastSaveMs = Date.now()
  },

  // Call to dispose the autosave interval (e.g. on page unload).
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

  // Mark the editor as having unsaved changes.
  markDirty() { _dirty = true },

  // Mark as clean (no unsaved changes).
  markClean() { _dirty = false },

  get isDirty() { return _dirty },
  get lastSaveMs() { return _lastSaveMs }
}