export class EventLog {
  constructor(config = {}) {
    this._log = []
    this._maxSize = config.maxSize || 100000
    this._nextId = 1
    this._recording = true
  }

  record(type, data, meta = {}) {
    if (!this._recording) return null
    const event = {
      id: this._nextId++,
      tick: meta.tick || 0,
      timestamp: Date.now(),
      type,
      data,
      meta: { actor: meta.actor || null, reason: meta.reason || null, context: meta.context || null, sourceApp: meta.sourceApp || null, sourceEntity: meta.sourceEntity || null, causalEventId: meta.causalEventId || null, ...meta }
    }
    this._log.push(event)
    if (this._log.length > this._maxSize) this._log.shift()
    return event
  }

  query(filter = {}) {
    return this._log.filter(e => {
      if (filter.type && e.type !== filter.type) return false
      if (filter.tick !== undefined && e.tick !== filter.tick) return false
      if (filter.tickRange && (e.tick < filter.tickRange[0] || e.tick > filter.tickRange[1])) return false
      if (filter.actor && e.meta.actor !== filter.actor) return false
      if (filter.entity && e.meta.sourceEntity !== filter.entity) return false
      if (filter.app && e.meta.sourceApp !== filter.app) return false
      return true
    })
  }

  getRange(startTick, endTick) {
    return this._log.filter(e => e.tick >= startTick && e.tick <= endTick)
  }

  get size() { return this._log.length }
  get lastTick() { return this._log.length > 0 ? this._log[this._log.length - 1].tick : 0 }

  pause() { this._recording = false }
  resume() { this._recording = true }
  clear() { this._log = []; this._nextId = 1 }

  serialize() { return JSON.stringify(this._log) }

  static deserialize(json) {
    const log = new EventLog()
    log._log = JSON.parse(json)
    log._nextId = log._log.length > 0 ? log._log[log._log.length - 1].id + 1 : 1
    return log
  }

  replay(runtime, options = {}) {
    const speed = options.speed || 1
    const startTick = options.startTick || 0
    const endTick = options.endTick || Infinity
    const events = this._log.filter(e => e.tick >= startTick && e.tick <= endTick)
    const result = { eventsReplayed: 0, errors: [] }
    for (const event of events) {
      try {
        switch (event.type) {
          case 'entity_spawn': runtime.spawnEntity(event.data.id, event.data.config); break
          case 'entity_destroy': runtime.destroyEntity(event.data.id); break
          case 'bus_event': runtime._eventBus?.emit(event.data.channel, event.data.data, event.meta); break
        }
        result.eventsReplayed++
      } catch (e) { result.errors.push({ eventId: event.id, error: e.message }) }
    }
    return result
  }
}
