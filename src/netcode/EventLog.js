import { pack, unpack } from '../protocol/msgpack.js'

export class EventLog {
  constructor(config = {}) {
    this._maxSize = config.maxSize || 1000
    this._buf = new Array(this._maxSize)
    this._head = 0
    this._count = 0
    this._nextId = 1
    this._recording = true
    // Dedupe set for cross-shard replicated events (see ingestRemote below) -- keyed by
    // "originRegion:originId" so a worker restart / router resync replaying already-applied events
    // never double-applies them to this log. Bounded the same way the ring buffer itself is bounded
    // (cleared entries are simply evicted from this Set lazily, see _pruneReplicatedKeys) so a
    // long-running shard doesn't grow this unboundedly.
    this._replicatedKeys = new Set()
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
  clear() { this._buf = new Array(this._maxSize); this._head = 0; this._count = 0; this._nextId = 1; this._replicatedKeys.clear() }

  // Applies an event forwarded from a SIBLING shard's own EventLog (see RegionWorkerEntry.js's
  // cross-shard replication hook + RegionRouter.js's fan-out). Distinct from record() in three ways
  // required by real multi-shard operation:
  //  - idempotent: a (originRegion, originId) pair is applied at most once, so a router resync or a
  //    replayed IPC message (e.g. after a worker restart re-requests recent history) never
  //    double-applies an event that already landed here.
  //  - provenance-preserving: the ORIGINATING shard's id/tick are kept verbatim under
  //    meta.originId/meta.originTick (never renumbered to look locally-authored) alongside a fresh
  //    LOCAL id/tick from this log's own sequence (so query()/getRange() by local tick still works
  //    normally against this log's own timeline) and meta.originRegion identifying the source shard.
  //  - never re-forwarded: meta.crossShard is stripped on ingest (see RegionWorkerEntry.js's outbound
  //    hook, which only forwards events carrying meta.crossShard===true) so a 3+-shard topology can't
  //    loop an event back out to its own origin or duplicate-broadcast it around a ring.
  // Returns the applied event, or null if it was a duplicate (already-seen origin) and was skipped.
  ingestRemote(event, originRegion) {
    const key = `${originRegion}:${event.id}`
    if (this._replicatedKeys.has(key)) return null
    this._replicatedKeys.add(key)
    if (this._replicatedKeys.size > this._maxSize * 4) this._pruneReplicatedKeys()
    const local = {
      id: this._nextId++,
      tick: event.tick || 0,
      timestamp: Date.now(),
      type: event.type,
      data: event.data,
      meta: { ...event.meta, crossShard: false, originRegion, originId: event.id, originTick: event.tick, originTimestamp: event.timestamp }
    }
    this._buf[this._head] = local
    this._head = (this._head + 1) % this._maxSize
    if (this._count < this._maxSize) this._count++
    return local
  }

  // Drops dedupe keys for origin events that have long since scrolled out of any plausible resync
  // window -- keeps the Set bounded on a long-running shard without needing a TTL/clock dependency.
  // A generous multiple of _maxSize (4x) is used rather than 1x because the LOCAL ring buffer and the
  // set of DISTINCT remote origins seen are different sizes (a busy multi-shard topology can see more
  // distinct remote event ids than fit in one shard's own local ring).
  _pruneReplicatedKeys() {
    const keep = new Set()
    for (const e of this._toArray()) {
      if (e.meta?.originRegion) keep.add(`${e.meta.originRegion}:${e.meta.originId}`)
    }
    this._replicatedKeys = keep
  }

  serialize() { return pack(this._toArray()) }

  static deserialize(json) {
    const arr = unpack(json)
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
