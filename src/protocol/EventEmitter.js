export class EventEmitter {
  constructor() {
    this.listeners = new Map()
  }

  on(event, fn) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, [])
    }
    this.listeners.get(event).push(fn)
    return this
  }

  off(event, fn) {
    if (!this.listeners.has(event)) return this
    const arr = this.listeners.get(event)
    const idx = arr.indexOf(fn)
    if (idx >= 0) arr.splice(idx, 1)
    return this
  }

  once(event, fn) {
    const wrapper = (...args) => {
      this.off(event, wrapper)
      fn(...args)
    }
    this.on(event, wrapper)
    return this
  }

  emit(event, ...args) {
    if (!this.listeners.has(event)) return false
    let delivered = 0
    for (const fn of this.listeners.get(event).slice()) {
      try {
        fn(...args)
        delivered++
      } catch (err) {
        console.error(`Error in listener for event '${event}':`, err)
      }
    }
    return delivered > 0
  }

  removeListener(event, fn) {
    return this.off(event, fn)
  }

  removeAllListeners(event) {
    if (event) {
      this.listeners.delete(event)
    } else {
      this.listeners.clear()
    }
    return this
  }

  listenerCount(event) {
    if (!this.listeners.has(event)) return 0
    return this.listeners.get(event).length
  }
}

// --- hot swap -----------------------------------------------------------------------------
// An edit to this file used to be classified RELOAD: findBoundaries walked from here to the app
// root and found no acceptor, so a save cost a whole page load. No boundary ABOVE this file can
// fix that, because a re-import is a new module instance and every importer keeps reading the
// one it imported at boot. What can is this file itself: an ESM import is a LIVE binding to this
// instance's export bindings, so re-assigning them here is visible to every importer already
// holding them. Self-accepting therefore turns the cost of a save into one module fetch.
// This re-points code only. It does not rebuild state the page already built, and every export
// below is re-assigned, so nothing an importer holds is left pointing at the previous copy.
const _hotSwapEventEmitter = (next) => {
  EventEmitter = next.EventEmitter
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapEventEmitter)
