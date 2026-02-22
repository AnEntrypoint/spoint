export class EventLog {
  constructor(config = {}) {
    this._maxSize = config.maxSize || 1000
    this._buf = new Array(this._maxSize)
    this._head = 0
    this._count = 0
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
    this._buf[this._head] = event
    this._head = (this._head + 1) % this._maxSize
    if (this._count < this._maxSize) this._count++
    return event
  }

  _toArray() {
    if (this._count < this._maxSize) return this._buf.slice(0, this._count)
    return [...this._buf.slice(this._head), ...this._buf.slice(0, this._head)]
  }

  query(filter = {}) {
    return this._toArray().filter(e => {
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
    return this._toArray().filter(e => e.tick >= startTick && e.tick <= endTick)
  }

  get size() { return this._count }
  get lastTick() {
    if (this._count === 0) return 0
    const idx = (this._head - 1 + this._maxSize) % this._maxSize
    return this._buf[idx].tick
  }

  pause() { this._recording = false }
  resume() { this._recording = true }
  clear() { this._buf = new Array(this._maxSize); this._head = 0; this._count = 0; this._nextId = 1 }

  serialize() { return JSON.stringify(this._toArray()) }

  static deserialize(json) {
    const arr = JSON.parse(json)
    const log = new EventLog({ maxSize: Math.max(arr.length, 1000) })
    for (const e of arr) log._buf[log._head++] = e
    log._count = arr.length
    log._head = log._head % log._maxSize
    log._nextId = arr.length > 0 ? arr[arr.length - 1].id + 1 : 1
    return log
  }

  replay(runtime, options = {}) {
    const startTick = options.startTick || 0
    const endTick = options.endTick || Infinity
    const events = this._toArray().filter(e => e.tick >= startTick && e.tick <= endTick)
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
