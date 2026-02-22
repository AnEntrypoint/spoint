export class EventBus {
  constructor() {
    this._handlers = new Map()
    this._scoped = new Map()
  }

  on(channel, handler) {
    if (!this._handlers.has(channel)) this._handlers.set(channel, new Set())
    this._handlers.get(channel).add(handler)
    return () => this.off(channel, handler)
  }

  off(channel, handler) {
    const set = this._handlers.get(channel)
    if (set) { set.delete(handler); if (set.size === 0) this._handlers.delete(channel) }
  }

  once(channel, handler) {
    const wrapper = (...args) => { this.off(channel, wrapper); handler(...args) }
    wrapper._original = handler
    this.on(channel, wrapper)
  }

  emit(channel, data, meta = {}) {
    const event = { channel, data, meta: { ...meta, timestamp: Date.now() } }
    const exact = this._handlers.get(channel)
    if (exact) for (const fn of exact) { try { fn(event) } catch (e) { console.error(`[EventBus] ${channel}:`, e.message) } }
    for (const [pattern, handlers] of this._handlers) {
      if (pattern === channel || !pattern.endsWith('*')) continue
      const prefix = pattern.slice(0, -1)
      if (channel.startsWith(prefix)) {
        for (const fn of handlers) { try { fn(event) } catch (e) { console.error(`[EventBus] ${pattern}:`, e.message) } }
      }
    }
    return event
  }

  scope(entityId) {
    const unsubs = []
    const scoped = {
      on: (ch, fn) => { const u = this.on(ch, fn); unsubs.push(u); return u },
      off: (ch, fn) => this.off(ch, fn),
      once: (ch, fn) => { const wrapper = (...a) => { this.off(ch, wrapper); fn(...a) }; wrapper._original = fn; const u = this.on(ch, wrapper); unsubs.push(u); return u },
      emit: (ch, data, meta = {}) => this.emit(ch, data, { ...meta, sourceEntity: entityId }),
      handover: (targetEntityId, stateData) => this.emit('system.handover', { targetEntityId, stateData }, { sourceEntity: entityId }),
      destroy: () => { for (const u of unsubs) u(); unsubs.length = 0 }
    }
    this._scoped.set(entityId, scoped)
    return scoped
  }

  destroyScope(entityId) {
    const scoped = this._scoped.get(entityId)
    if (scoped) { scoped.destroy(); this._scoped.delete(entityId) }
  }

  clear() {
    for (const scoped of this._scoped.values()) scoped.destroy()
    this._scoped.clear()
    this._handlers.clear()
  }
}
