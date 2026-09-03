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
      fn(...args)
      this.off(event, wrapper)
    }
    this.on(event, wrapper)
    return this
  }

  emit(event, ...args) {
    if (!this.listeners.has(event)) return false
    this.listeners.get(event).forEach(fn => {
      try {
        fn(...args)
      } catch (err) {
        console.error(`Error in listener for event '${event}':`, err)
      }
    })
    return true
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
