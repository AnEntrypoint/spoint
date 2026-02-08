import { watch } from 'node:fs/promises'
import { resolve } from 'node:path'

export class ReloadManager {
  constructor() {
    this._watchers = new Map()
    this._moduleCache = new Map()
    this._reloadState = new Map()
    this._debounceTimers = new Map()
    this._failureCounters = new Map()
    this._validators = new Map()
    this._MAX_FAILURES = 3
    this._MAX_BACKOFF = 400
  }

  addWatcher(moduleId, filePath, onReload, validator) {
    const absPath = resolve(filePath)
    if (this._watchers.has(moduleId)) return
    this._reloadState.set(moduleId, { inProgress: false, lastSuccess: null, failureCount: 0 })
    this._failureCounters.set(moduleId, 0)
    if (validator) this._validators.set(moduleId, validator)
    const startWatch = async () => {
      try {
        const ac = new AbortController()
        this._watchers.set(moduleId, ac)
        const watcher = watch(absPath, { signal: ac.signal })
        ;(async () => {
          try {
            for await (const event of watcher) {
              this._debounce(moduleId, () => this._handleReload(moduleId, onReload))
            }
          } catch (e) {
            if (e.name !== 'AbortError') {
              console.error(`[ReloadManager] watch error for ${moduleId}:`, e.message)
            }
          }
        })()
      } catch (e) {
        console.error(`[ReloadManager] failed to start watcher for ${moduleId}:`, e.message)
      }
    }
    startWatch()
  }

  _debounce(moduleId, fn) {
    if (this._debounceTimers.has(moduleId)) {
      clearTimeout(this._debounceTimers.get(moduleId))
    }
    this._failureCounters.set(moduleId, 0)
    const timer = setTimeout(() => {
      fn()
      this._debounceTimers.delete(moduleId)
    }, 100)
    this._debounceTimers.set(moduleId, timer)
  }

  async _handleReload(moduleId, onReload) {
    const state = this._reloadState.get(moduleId)
    if (!state) return
    if (state.inProgress) return
    state.inProgress = true
    const failureCount = this._failureCounters.get(moduleId) || 0
    if (failureCount >= this._MAX_FAILURES) {
      console.error(`[ReloadManager] ${moduleId} exceeded max failures, stopping auto-reload`)
      state.inProgress = false
      return
    }
    const validator = this._validators.get(moduleId)
    if (validator) {
      try {
        const valid = await validator()
        if (!valid) {
          console.warn(`[ReloadManager] ${moduleId} failed pre-reload validation, skipping`)
          state.inProgress = false
          return
        }
      } catch (e) {
        console.warn(`[ReloadManager] ${moduleId} validation error, skipping:`, e.message)
        state.inProgress = false
        return
      }
    }
    try {
      await onReload()
      this._failureCounters.set(moduleId, 0)
      state.lastSuccess = Date.now()
      console.log(`[ReloadManager] successfully reloaded ${moduleId}`)
    } catch (e) {
      const newFailureCount = failureCount + 1
      this._failureCounters.set(moduleId, newFailureCount)
      const backoff = Math.min(100 * Math.pow(2, failureCount - 1), this._MAX_BACKOFF)
      console.error(`[ReloadManager] reload failed for ${moduleId} (${newFailureCount}/${this._MAX_FAILURES}):`, e.message)
      if (newFailureCount < this._MAX_FAILURES) {
        console.log(`[ReloadManager] retrying ${moduleId} in ${backoff}ms`)
        await new Promise(resolve => setTimeout(resolve, backoff))
        state.inProgress = false
        await this._handleReload(moduleId, onReload)
        return
      } else {
        console.error(`[ReloadManager] ${moduleId} gave up after ${newFailureCount} failures`)
      }
    }
    state.inProgress = false
  }

  stopWatcher(moduleId) {
    const ac = this._watchers.get(moduleId)
    if (ac) ac.abort()
    this._watchers.delete(moduleId)
    this._debounceTimers.delete(moduleId)
  }

  stopAllWatchers() {
    for (const ac of this._watchers.values()) ac.abort()
    this._watchers.clear()
    for (const timer of this._debounceTimers.values()) clearTimeout(timer)
    this._debounceTimers.clear()
  }

  cacheModule(moduleId, module) { this._moduleCache.set(moduleId, module) }
  getModule(moduleId) { return this._moduleCache.get(moduleId) }
  getState(moduleId) { return this._reloadState.get(moduleId) }
  getStats() {
    return { watchers: this._watchers.size, modules: this._moduleCache.size, failures: Object.fromEntries(this._failureCounters) }
  }
}
