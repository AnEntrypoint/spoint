import { fetchCached } from './ModelCache.js'

export class LoadingManager extends EventTarget {
  constructor() {
    super()
    // Download: count-based (works for cached + network assets)
    this._dlStarted = new Set()
    this._dlDone = new Set()
    this._dlTotal = 0
    this._dlCompleted = 0
    // Processing: count-based (entity shader warmup)
    this._procDone = 0
    this._procTotal = 0
    this.label = 'Connecting...'
  }

  // Register an asset as "about to download" (call before fetchCached)
  beginDownload(key) {
    if (this._dlStarted.has(key)) return
    this._dlStarted.add(key)
    this._dlTotal++
    this._emitDownload()
  }

  // Mark an asset download complete (call after fetchCached resolves/rejects)
  completeDownload(key) {
    if (!this._dlStarted.has(key) || this._dlDone.has(key)) return
    this._dlDone.add(key)
    this._dlCompleted++
    this._emitDownload()
  }

  _emitDownload() {
    const pct = this._dlTotal > 0 ? Math.min(100, (this._dlCompleted / this._dlTotal) * 100) : 0
    this._dispatch('download', { percent: pct, done: this._dlCompleted, total: this._dlTotal })
  }

  // Report processing progress (entity shader warmup)
  reportProcessing(done, total) {
    this._procDone = done
    this._procTotal = total
    const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0
    this._dispatch('processing', { percent: pct, done, total })
  }

  setLabel(label) {
    this.label = label
    this._dispatch('label', { label })
  }

  // Convenience: register + fetch + complete
  async fetchWithProgress(url, key) {
    const k = key || url
    this.beginDownload(k)
    try {
      const result = await fetchCached(url)
      this.completeDownload(k)
      return result
    } catch (error) {
      this.completeDownload(k)
      console.error('[loading] fetch failed:', url, error)
      throw error
    }
  }

  _dispatch(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }))
  }

  dispose() {
    this._dlStarted.clear()
    this._dlDone.clear()
  }
}
