const realSetImmediate = globalThis.setImmediate
const realSetTimeout = globalThis.setTimeout
const EPOCH_MS = Date.UTC(2026, 0, 1)
const TIMEOUT_MAX_MS = 2147483647
const DEFAULT_IDLE_REAL_MS = 120000

export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function clampDelay(delay) {
  const d = Number(delay)
  return Number.isFinite(d) && d >= 1 && d <= TIMEOUT_MAX_MS ? d : 1
}

function entryLess(a, b) {
  return a.at < b.at || (a.at === b.at && a.seq < b.seq)
}

export function createVirtualClock({ epochMs = EPOCH_MS, seed = 0 } = {}) {
  let now = 0
  let seq = 0
  let nextId = 1
  const heap = []
  const live = new Map()
  const random = mulberry32(seed)

  function heapPush(entry) {
    entry.seq = seq++
    heap.push(entry)
    let i = heap.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!entryLess(heap[i], heap[p])) break
      ;[heap[i], heap[p]] = [heap[p], heap[i]]
      i = p
    }
  }

  function heapPop() {
    const top = heap[0]
    const last = heap.pop()
    if (heap.length) {
      heap[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < heap.length && entryLess(heap[l], heap[m])) m = l
        if (r < heap.length && entryLess(heap[r], heap[m])) m = r
        if (m === i) break
        ;[heap[i], heap[m]] = [heap[m], heap[i]]
        i = m
      }
    }
    return top
  }

  function peekLive() {
    while (heap.length) {
      const top = heap[0]
      if (!top.rec.cancelled && top.version === top.rec.version) return top
      heapPop()
    }
    return null
  }

  function enqueue(rec, at) {
    rec.version++
    rec.at = at
    heapPush({ at, seq: 0, rec, version: rec.version })
  }

  function cancel(rec) {
    if (rec.cancelled) return
    rec.cancelled = true
    live.delete(rec.id)
  }

  class Handle {
    constructor(rec) { this._rec = rec }
    ref() { return this }
    unref() { return this }
    hasRef() { return !this._rec.cancelled }
    refresh() {
      if (!this._rec.cancelled && !this._rec.immediate) enqueue(this._rec, now + this._rec.delay)
      return this
    }
    close() { cancel(this._rec); return this }
    [Symbol.toPrimitive]() { return this._rec.id }
  }

  function makeTimer(fn, delay, args, repeat, immediate) {
    if (typeof fn !== 'function') throw new TypeError('[virtual-clock] the callback must be a function')
    const rec = { id: nextId++, fn, args, repeat, immediate, delay: immediate ? 0 : clampDelay(delay), cancelled: false, version: 0, at: 0 }
    live.set(rec.id, rec)
    enqueue(rec, immediate ? now : now + rec.delay)
    return new Handle(rec)
  }

  function clearHandle(handle) {
    if (handle instanceof Handle) cancel(handle._rec)
    else if (typeof handle === 'number') { const rec = live.get(handle); if (rec) cancel(rec) }
  }

  function runNext() {
    const top = peekLive()
    if (top === null) return false
    heapPop()
    now = Math.max(now, top.at)
    const rec = top.rec
    if (rec.repeat) enqueue(rec, rec.at + rec.delay)
    else live.delete(rec.id)
    rec.fn(...rec.args)
    return true
  }

  async function drive(task, { maxVirtualMs = Infinity, idleRealMs = DEFAULT_IDLE_REAL_MS } = {}) {
    let outcome = null
    const finished = Promise.resolve().then(task).then(
      value => { outcome = { ok: true, value } },
      error => { outcome = { ok: false, error } }
    )
    let idleStart = null
    while (outcome === null) {
      await new Promise(resolveImmediate => realSetImmediate(resolveImmediate))
      if (outcome !== null) break
      const next = peekLive()
      if (next === null) {
        idleStart ??= process.hrtime.bigint()
        if (Number(process.hrtime.bigint() - idleStart) / 1e6 > idleRealMs) {
          throw new Error(`[virtual-clock] no virtual timer is pending and the task has not settled after ${idleRealMs} ms of real time`)
        }
        await new Promise(resolveSleep => realSetTimeout(resolveSleep, 1))
        continue
      }
      idleStart = null
      if (next.at > maxVirtualMs) {
        throw new Error(`[virtual-clock] virtual time reached ${next.at} ms, past the ${maxVirtualMs} ms limit, with the task still running`)
      }
      runNext()
    }
    await finished
    if (!outcome.ok) throw outcome.error
    return outcome.value
  }

  return {
    now: () => now,
    dateNow: () => epochMs + Math.floor(now),
    random,
    setTimeout: (fn, delay, ...args) => makeTimer(fn, delay, args, false, false),
    clearTimeout: clearHandle,
    setInterval: (fn, delay, ...args) => makeTimer(fn, delay, args, true, false),
    clearInterval: clearHandle,
    setImmediate: (fn, ...args) => makeTimer(fn, 0, args, false, true),
    clearImmediate: clearHandle,
    pending: () => live.size,
    drive
  }
}

export function installVirtualGlobals(clock) {
  globalThis.setTimeout = clock.setTimeout
  globalThis.clearTimeout = clock.clearTimeout
  globalThis.setInterval = clock.setInterval
  globalThis.clearInterval = clock.clearInterval
  globalThis.setImmediate = clock.setImmediate
  globalThis.clearImmediate = clock.clearImmediate
  Object.defineProperty(globalThis, 'performance', { value: { now: clock.now }, configurable: true, writable: true })
  Date.now = clock.dateNow
  Math.random = clock.random
}
