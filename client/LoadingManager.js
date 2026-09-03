import { fetchCached } from './ModelCache.js'

export class LoadingManager extends EventTarget {
  constructor() {
    super()
    this._dlStarted = new Set()
    this._dlDone = new Set()
    this._dlTotal = 0
    this._dlCompleted = 0
    this._fixedTotal = null
    this._procDone = 0
    this._procTotal = 0
    this.label = 'Connecting...'
  }

  setFixedTotal(count) {
    this._fixedTotal = count
    this._dlTotal = count
    this._emitDownload()
  }

  beginDownload(key) {
    if (this._dlStarted.has(key)) return
    this._dlStarted.add(key)
    if (this._fixedTotal === null) this._dlTotal++
    this._emitDownload()
  }

  completeDownload(key) {
    if (!this._dlStarted.has(key) || this._dlDone.has(key)) return
    this._dlDone.add(key)
    this._dlCompleted++
    this._emitDownload()
  }

  _emitDownload() {
    // Clamp: more distinct keys than a fixed total can push _dlCompleted past _dlTotal.
    const done = Math.min(this._dlCompleted, this._dlTotal)
    const pct = this._dlTotal > 0 ? Math.min(100, (done / this._dlTotal) * 100) : 0
    this._dispatch('download', { percent: pct, done, total: this._dlTotal })
  }

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

  async fetchWithProgress(url, key) {
    const k = key || url
    this.beginDownload(k)
    try {
      const result = await fetchCached(url, (received, total) => this._dispatch('download', { percent: Math.min(100, (received / total) * 100), done: received, total }))
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
