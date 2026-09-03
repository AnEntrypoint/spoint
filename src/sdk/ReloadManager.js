import { watch } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createMachine, createActor, assign } from 'xstate'

const moduleMachine = createMachine({
  id: 'module',
  initial: 'watching',
  context: { failures: 0 },
  states: {
    watching: { on: { CHANGE: 'debouncing' } },
    debouncing: { on: { TIMER: 'reloading', CHANGE: 'debouncing' } },
    reloading: {
      on: {
        SUCCESS: { target: 'watching', actions: assign({ failures: 0 }) },
        FAILURE: [
          { target: 'disabled', guard: ({ context }) => context.failures >= 2 },
          { target: 'watching', actions: assign({ failures: ({ context }) => context.failures + 1 }) }
        ]
      }
    },
    disabled: { type: 'final' }
  }
})

export class ReloadManager {
  constructor() {
    this._watchers = new Map()
    this._moduleCache = new Map()
    this._actors = new Map()
    this._debounceTimers = new Map()
    this._validators = new Map()
  }

  addWatcher(moduleId, filePath, onReload, validator) {
    const absPath = resolve(filePath)
    if (this._watchers.has(moduleId)) return
    if (!existsSync(absPath)) {
      console.debug(`[ReloadManager] skipping watch for missing file: ${moduleId}`)
      return
    }
    const actor = createActor(moduleMachine)
    actor.start()
    this._actors.set(moduleId, actor)
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
            if (e.name !== 'AbortError') console.error(`[ReloadManager] watch error for ${moduleId}:`, e.message)
          }
        })()
      } catch (e) {
        console.error(`[ReloadManager] failed to start watcher for ${moduleId}:`, e.message)
      }
    }
    startWatch()
  }

  _debounce(moduleId, fn) {
    const actor = this._actors.get(moduleId)
    if (!actor) return
    actor.send({ type: 'CHANGE' })
    if (this._debounceTimers.has(moduleId)) clearTimeout(this._debounceTimers.get(moduleId))
    const backoff = 100 * Math.pow(2, actor.getSnapshot().context.failures)
    const timer = setTimeout(() => {
      actor.send({ type: 'TIMER' })
      fn()
      this._debounceTimers.delete(moduleId)
    }, Math.min(backoff, 400))
    this._debounceTimers.set(moduleId, timer)
  }

  async _handleReload(moduleId, onReload) {
    const actor = this._actors.get(moduleId)
    if (!actor) return
    const snap = actor.getSnapshot()
    if (snap.value !== 'reloading') return
    const validator = this._validators.get(moduleId)
    if (validator) {
      try {
        const valid = await validator()
        if (!valid) { actor.send({ type: 'FAILURE' }); return }
      } catch (e) { actor.send({ type: 'FAILURE' }); return }
    }
    try {
      await onReload()
      actor.send({ type: 'SUCCESS' })
      console.log(`[ReloadManager] successfully reloaded ${moduleId}`)
    } catch (e) {
      actor.send({ type: 'FAILURE' })
      console.error(`[ReloadManager] reload failed for ${moduleId}:`, e.message)
      if (actor.getSnapshot().value === 'disabled') {
        console.error(`[ReloadManager] ${moduleId} exceeded max failures, stopping auto-reload`)
      }
    }
  }

  removeWatcher(moduleId) {
    const ac = this._watchers.get(moduleId)
    if (ac) { ac.abort(); this._watchers.delete(moduleId) }
    const actor = this._actors.get(moduleId)
    if (actor) { actor.stop(); this._actors.delete(moduleId) }
    if (this._debounceTimers.has(moduleId)) {
      clearTimeout(this._debounceTimers.get(moduleId))
      this._debounceTimers.delete(moduleId)
    }
    this._validators.delete(moduleId)
  }

  getStats() {
    const stats = {}
    for (const [id, actor] of this._actors) {
      const snap = actor.getSnapshot()
      stats[id] = { state: snap.value, failures: snap.context.failures }
    }
    return stats
  }

  destroy() {
    for (const id of [...this._watchers.keys()]) this.removeWatcher(id)
  }
}
