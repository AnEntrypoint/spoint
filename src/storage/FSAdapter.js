import { readFile, writeFile, unlink, readdir, mkdir, rename, access } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { StorageAdapter } from './StorageAdapter.js'

export class FSAdapter extends StorageAdapter {
  constructor(baseDir = './data') {
    super()
    this._dir = baseDir
    this._ready = false
  }

  async _ensureDir() {
    if (this._ready) return
    await mkdir(this._dir, { recursive: true }).catch(() => {})
    this._ready = true
  }

  _path(key) {
    const safe = key.replace(/[^a-zA-Z0-9._-]/g, '_')
    return join(this._dir, `${safe}.json`)
  }

  async get(key) {
    try {
      const data = await readFile(this._path(key), 'utf-8')
      return JSON.parse(data)
    } catch { return undefined }
  }

  async set(key, value) {
    await this._ensureDir()
    const fp = this._path(key)
    const tmp = fp + '.tmp'
    await writeFile(tmp, JSON.stringify(value), 'utf-8')
    await rename(tmp, fp)
  }

  async delete(key) {
    try { await unlink(this._path(key)) } catch {}
  }

  async list(prefix = '') {
    await this._ensureDir()
    try {
      const files = await readdir(this._dir)
      const safe = prefix.replace(/[^a-zA-Z0-9._-]/g, '_')
      return files
        .filter(f => f.endsWith('.json') && f.startsWith(safe))
        .map(f => f.slice(0, -5))
    } catch { return [] }
  }

  async has(key) {
    try { await access(this._path(key)); return true } catch { return false }
  }
}
