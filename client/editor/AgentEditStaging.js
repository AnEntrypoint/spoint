// Review/buffer staging layer for AGENT-authored app-code edits, in front of the SAVE_SOURCE disk-save pipeline. Human Ctrl+S (EditPanelEditor.js doSave) bypasses this entirely and saves directly.

const DB_NAME = 'spoint-agent-staging'
const DB_VERSION = 1
const STORE = 'edits'

function keyOf(appName, file) { return appName + '::' + file }

function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'))
  })
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => reject(req.error)
  })
}

function idbGetAll(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAll()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error)
  })
}

function idbPut(db, record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(record)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

function idbDelete(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export function createAgentEditStaging({ getSource, saveSource } = {}) {
  let _db = null
  let _entries = new Map()
  const _listeners = new Set()

  async function _ensureDB() {
    if (_db) return _db
    _db = await openDB()
    return _db
  }

  function _emit() { for (const fn of _listeners) { try { fn(list()) } catch (_) {} } }

  function list() { return Array.from(_entries.values()) }

  function subscribe(fn) { _listeners.add(fn); return () => _listeners.delete(fn) }

  // A 'persisting' entry on load means the page closed mid-write; re-mark 'dirty' rather than guess which value committed.
  async function loadAll() {
    const db = await _ensureDB()
    const rows = await idbGetAll(db)
    _entries = new Map(rows.map(r => [r.key, r.status === 'persisting' ? { ...r, status: 'dirty' } : r]))
    _emit()
    return list()
  }

  async function stage(appName, file, source) {
    const db = await _ensureDB()
    const key = keyOf(appName, file)
    const existing = _entries.get(key)
    let baseSource = existing ? existing.baseSource : undefined
    if (baseSource === undefined) {
      try { baseSource = getSource ? await getSource(appName, file) : null } catch (_) { baseSource = null }
    }
    const record = { key, appName, file, source, baseSource, status: 'persisting', updatedAt: Date.now() }
    _entries.set(key, record)
    _emit()
    try {
      await idbPut(db, record)
      record.status = 'dirty'
      _entries.set(key, { ...record })
      _emit()
    } catch (e) {
      record.status = 'dirty'
      _entries.set(key, { ...record })
      _emit()
      throw e
    }
    return record
  }

  function get(appName, file) { return _entries.get(keyOf(appName, file)) || null }

  function isDirty(appName, file) { const e = get(appName, file); return !!e && e.status !== 'clean' }

  async function hasConflict(appName, file) {
    const e = get(appName, file)
    if (!e || e.baseSource == null || !getSource) return null
    try {
      const live = await getSource(appName, file)
      return live !== e.baseSource
    } catch (_) { return null }
  }

  // Default aborts on conflict (disk changed since staging) unless force=true.
  async function commitOne(appName, file, { force = false } = {}) {
    const e = get(appName, file)
    if (!e) return { ok: false, error: 'nothing staged for ' + appName + '/' + file }
    if (!force) {
      const conflict = await hasConflict(appName, file)
      if (conflict === true) return { ok: false, conflict: true, error: 'disk content changed since this edit was staged' }
    }
    if (!saveSource) return { ok: false, error: 'no saveSource wired' }
    try {
      const res = await saveSource(appName, file, e.source)
      if (res && res.ok === false) return { ok: false, error: res.error || 'save failed' }
      const db = await _ensureDB()
      await idbDelete(db, keyOf(appName, file))
      _entries.delete(keyOf(appName, file))
      _emit()
      return { ok: true }
    } catch (e2) {
      return { ok: false, error: e2?.message || String(e2) }
    }
  }

  async function commitAll({ force = false } = {}) {
    const targets = list().filter(e => e.status === 'dirty')
    const results = []
    for (const e of targets) {
      const r = await commitOne(e.appName, e.file, { force })
      results.push({ appName: e.appName, file: e.file, ...r })
    }
    return results
  }

  async function discard(appName, file) {
    const db = await _ensureDB()
    const key = keyOf(appName, file)
    await idbDelete(db, key)
    _entries.delete(key)
    _emit()
  }

  return { loadAll, stage, get, isDirty, hasConflict, commitOne, commitAll, discard, list, subscribe }
}
