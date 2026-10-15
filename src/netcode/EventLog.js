import { pack, unpack } from '../protocol/msgpack.js'

const REPLICATED_KEYS_PER_RING_SLOT = 4

const REPLAY_HANDLERS = new Map([
  ['entity_spawn', (runtime, event) => runtime.spawnEntity(event.data.id, event.data.config)],
  ['entity_destroy', (runtime, event) => runtime.destroyEntity(event.data.id)],
  ['bus_event', (runtime, event) => runtime._eventBus?.emit(event.data.channel, event.data.data, event.meta)],
])

export let EVENT_LOG_KINDS = [...REPLAY_HANDLERS.keys()]

export function parseEventKind(type) {
  return REPLAY_HANDLERS.has(type)
    ? { status: 'replayable', kind: type }
    : { status: 'no-replay-arm', kind: type }
}

export class EventLog {
  constructor(config = {}) {
    this._maxSize = config.maxSize || 1000
    this._buf = new Array(this._maxSize)
    this._head = 0
    this._count = 0
    this._nextId = 1
    this._recording = true
    this._replicatedKeys = new Set()
  }

  record(type, data, meta = {}) {
    if (!this._recording) return null
    const event = {
      id: this._nextId++,
      tick: meta.tick || 0,
      timestamp: Date.now(),
      type,
      kindStatus: parseEventKind(type).status,
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

  ingestRemote(event, originRegion) {
    const key = `${originRegion}:${event.id}`
    if (this._replicatedKeys.has(key)) return null
    this._replicatedKeys.add(key)
    const local = {
      id: this._nextId++,
      tick: event.tick || 0,
      timestamp: Date.now(),
      type: event.type,
      kindStatus: parseEventKind(event.type).status,
      data: event.data,
      meta: { ...event.meta, crossShard: false, originRegion, originId: event.id, originTick: event.tick, originTimestamp: event.timestamp }
    }
    this._buf[this._head] = local
    this._head = (this._head + 1) % this._maxSize
    if (this._count < this._maxSize) this._count++
    if (this._replicatedKeys.size > this._maxSize * REPLICATED_KEYS_PER_RING_SLOT) this._pruneReplicatedKeys()
    return local
  }

  _replicatedKeysFromRing() {
    const keys = new Set()
    for (const e of this._toArray()) {
      if (e.meta?.originRegion) keys.add(`${e.meta.originRegion}:${e.meta.originId}`)
    }
    return keys
  }

  _pruneReplicatedKeys() {
    this._replicatedKeys = this._replicatedKeysFromRing()
  }

  serialize() { return pack(this._toArray()) }

  static deserialize(json) {
    const arr = unpack(json)
    const log = new EventLog({ maxSize: Math.max(arr.length, 1000) })
    for (const e of arr) log._buf[log._head++] = { ...e, kindStatus: parseEventKind(e.type).status }
    log._count = arr.length
    log._head = log._head % log._maxSize
    log._nextId = arr.length > 0 ? arr[arr.length - 1].id + 1 : 1
    log._replicatedKeys = log._replicatedKeysFromRing()
    return log
  }

  replay(runtime, options = {}) {
    const startTick = options.startTick ?? 0
    const endTick = options.endTick ?? Infinity
    const result = { eventsReplayed: 0, errors: [] }
    const replayable = []
    for (const event of this._toArray()) {
      if (event.tick < startTick || event.tick > endTick) continue
      if (event.kindStatus !== 'replayable') {
        result.errors.push({ eventId: event.id, error: `unknown event type ${JSON.stringify(event.type)}` })
        continue
      }
      replayable.push({ event, apply: REPLAY_HANDLERS.get(event.type) })
    }
    for (const { event, apply } of replayable) {
      try {
        apply(runtime, event)
        result.eventsReplayed++
      } catch (e) { result.errors.push({ eventId: event.id, error: e.message }) }
    }
    return result
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
const _hotSwapEventLog = (next) => {
  EVENT_LOG_KINDS = next.EVENT_LOG_KINDS
  parseEventKind = next.parseEventKind
  EventLog = next.EventLog
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapEventLog)
