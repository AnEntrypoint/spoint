const isSeq = (v) => Number.isSafeInteger(v) && v >= 0
const isPositive = (v) => Number.isFinite(v) && v > 0

export function backoffDelay(attempt, { baseMs, maxMs, factor }) {
  return Math.min(maxMs, baseMs * factor ** attempt)
}

export class CursorEventStream {
  constructor({ open, onEvent, onGap = null, onState = null, cursor = 0, baseMs = 500, maxMs = 10000, factor = 2, timers = globalThis }) {
    if (typeof open !== 'function') throw new TypeError('CursorEventStream: open must be a function')
    if (typeof onEvent !== 'function') throw new TypeError('CursorEventStream: onEvent must be a function')
    if (!isSeq(cursor)) throw new RangeError(`CursorEventStream: cursor must be a non-negative safe integer, got ${cursor}`)
    if (!isPositive(baseMs) || !isPositive(maxMs) || baseMs > maxMs) throw new RangeError('CursorEventStream: need 0 < baseMs <= maxMs')
    if (!(factor >= 1) || !Number.isFinite(factor)) throw new RangeError('CursorEventStream: factor must be a finite number >= 1')
    this._open = open
    this._onEvent = onEvent
    this._onGap = onGap
    this._onState = onState
    this._cursor = cursor
    this._backoff = { baseMs, maxMs, factor }
    this._timers = timers
    this._attempt = 0
    this._generation = 0
    this._closeCurrent = null
    this._timer = null
    this._running = false
  }

  get cursor() { return this._cursor }
  get attempt() { return this._attempt }
  get running() { return this._running }

  start() {
    if (this._running) return
    this._running = true
    this._connect()
  }

  stop() {
    this._running = false
    this._generation++
    if (this._timer !== null) { this._timers.clearTimeout(this._timer); this._timer = null }
    const close = this._closeCurrent
    this._closeCurrent = null
    if (close) close()
    this._state('stopped')
  }

  _state(state) {
    if (this._onState) this._onState(state, this._cursor, this._attempt)
  }

  _connect() {
    this._timer = null
    const generation = ++this._generation
    const sink = {
      event: (evt) => this._deliver(generation, evt),
      closed: () => this._lost(generation),
    }
    this._state('connecting')
    this._closeCurrent = this._open(this._cursor, sink) ?? null
  }

  _deliver(generation, evt) {
    if (!this._running || generation !== this._generation) return
    const seq = evt?.seq
    if (!isSeq(seq)) throw new TypeError(`CursorEventStream: event seq must be a non-negative safe integer, got ${seq}`)
    if (seq <= this._cursor) return
    if (seq > this._cursor + 1 && this._onGap) this._onGap(this._cursor, seq)
    this._cursor = seq
    this._attempt = 0
    this._state('live')
    this._onEvent(evt)
  }

  _lost(generation) {
    if (!this._running || generation !== this._generation) return
    this._closeCurrent = null
    const delay = backoffDelay(this._attempt, this._backoff)
    this._attempt++
    this._state('backoff')
    this._timer = this._timers.setTimeout(() => this._connect(), delay)
  }
}
