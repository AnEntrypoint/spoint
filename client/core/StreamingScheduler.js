const MIN_SCREEN_SIZE = 0.01
const OUT_OF_FRUSTUM_PENALTY = 8

export function scoreRequest(features = {}) {
  const distance = Number.isFinite(features.distance) && features.distance >= 0 ? features.distance : Infinity
  const screenSize = Number.isFinite(features.screenSize) && features.screenSize > 0 ? features.screenSize : 1
  const inFrustum = features.inFrustum !== false
  const gameplayBoost = Number.isFinite(features.gameplayBoost) ? Math.min(1, Math.max(0, features.gameplayBoost)) : 0

  let score = distance / Math.max(screenSize, MIN_SCREEN_SIZE)
  if (!inFrustum) score *= OUT_OF_FRUSTUM_PENALTY
  score = score * (1 - gameplayBoost)
  return score
}

function _less(a, b) { return a.score !== b.score ? a.score < b.score : a._seq < b._seq }

class _MinHeap {
  constructor() { this._a = [] }
  get size() { return this._a.length }
  push(item) {
    const a = this._a; a.push(item)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (_less(a[i], a[p])) { const t = a[i]; a[i] = a[p]; a[p] = t; i = p } else break
    }
  }
  pop() {
    const a = this._a
    if (a.length === 0) return undefined
    const top = a[0], last = a.pop()
    if (a.length > 0) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = i * 2 + 1, r = l + 1
        let smallest = i
        if (l < a.length && _less(a[l], a[smallest])) smallest = l
        if (r < a.length && _less(a[r], a[smallest])) smallest = r
        if (smallest === i) break
        const t = a[i]; a[i] = a[smallest]; a[smallest] = t; i = smallest
      }
    }
    return top
  }
  peek() { return this._a[0] }
  removeById(id) {
    const a = this._a
    const idx = a.findIndex(it => it.id === id)
    if (idx === -1) return false
    const last = a.pop()
    if (idx < a.length) {
      a[idx] = last
      let i = idx
      while (i > 0) {
        const p = (i - 1) >> 1
        if (_less(a[i], a[p])) { const t = a[i]; a[i] = a[p]; a[p] = t; i = p } else break
      }
      for (;;) {
        const l = i * 2 + 1, r = l + 1
        let smallest = i
        if (l < a.length && _less(a[l], a[smallest])) smallest = l
        if (r < a.length && _less(a[r], a[smallest])) smallest = r
        if (smallest === i) break
        const t = a[i]; a[i] = a[smallest]; a[smallest] = t; i = smallest
      }
    }
    return true
  }
}

export function createStreamingScheduler(opts = {}) {
  const budgetMs = Number.isFinite(opts.budgetMs) && opts.budgetMs > 0 ? opts.budgetMs : 2
  const maxStartsPerDrain = Number.isFinite(opts.maxStartsPerDrain) && opts.maxStartsPerDrain > 0 ? opts.maxStartsPerDrain : 32
  const _now = typeof opts.now === 'function' ? opts.now : (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now())

  const _heap = new _MinHeap()
  const _byId = new Map()
  let _seq = 0
  const _kindStats = new Map()
  const _dispatchLog = []
  const DISPATCH_LOG_CAP = 256

  function _statsFor(kind) {
    let s = _kindStats.get(kind)
    if (!s) { s = { enqueued: 0, dispatched: 0, cancelled: 0 }; _kindStats.set(kind, s) }
    return s
  }

  function enqueue({ id, kind = 'unknown', features = {}, run, cancel } = {}) {
    if (!id || typeof run !== 'function') return false
    const score = scoreRequest(features)
    const existing = _byId.get(id)
    if (existing) {
      _heap.removeById(id)
      existing.score = score; existing.kind = kind; existing.run = run; existing.cancel = cancel; existing._seq = _seq++
      _heap.push(existing)
      return true
    }
    const rec = { id, kind, score, run, cancel, _seq: _seq++ }
    _byId.set(id, rec)
    _heap.push(rec)
    _statsFor(kind).enqueued++
    return true
  }

  function cancel(id) {
    const rec = _byId.get(id)
    if (!rec) return false
    _heap.removeById(id)
    _byId.delete(id)
    _statsFor(rec.kind).cancelled++
    if (typeof rec.cancel === 'function') { try { rec.cancel() } catch (_) {} }
    return true
  }

  function has(id) { return _byId.has(id) }
  function size() { return _heap.size }

  function drain() {
    const deadline = _now() + budgetMs
    const dispatched = []
    let starts = 0
    while (starts < maxStartsPerDrain && _heap.size > 0 && _now() < deadline) {
      const rec = _heap.pop()
      _byId.delete(rec.id)
      _statsFor(rec.kind).dispatched++
      starts++
      const entry = { id: rec.id, kind: rec.kind, score: rec.score, dispatchedAtMs: _now() }
      dispatched.push(entry)
      _dispatchLog.push(entry)
      if (_dispatchLog.length > DISPATCH_LOG_CAP) _dispatchLog.shift()
      try { rec.run() } catch (e) { }
    }
    return dispatched
  }

  function getStats() {
    const perKind = {}
    for (const [kind, s] of _kindStats) perKind[kind] = { ...s }
    return { queued: _heap.size, budgetMs, maxStartsPerDrain, kinds: perKind }
  }

  function getDispatchLog() { return _dispatchLog.slice() }

  return { enqueue, cancel, has, size, drain, getStats, getDispatchLog, scoreRequest }
}

let _sharedScheduler = null
export function getSharedStreamingScheduler(opts) {
  if (!_sharedScheduler) _sharedScheduler = createStreamingScheduler(opts)
  return _sharedScheduler
}

if (typeof window !== 'undefined') {
  window.__streamingScheduler = {
    get: () => getSharedStreamingScheduler(),
    scoreRequest,
  }
}
