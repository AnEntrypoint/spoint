// StreamingScheduler -- one shared cross-system priority queue that arbitrates ALL streaming/warm-load
// work competing for the same per-frame time budget: mesh LOD warm-loads (packages/streaming-gltf's
// model-pool.js _lodWarmQueue, currently nearest-distance-only), texture/mip fetches (a future KTX2
// streaming pipeline, not yet built -- see the follow-up PRD rows this row re-files), and any other
// async streaming-in work a system wants arbitrated instead of self-scheduling in isolation. Colliders
// (src/terrain/ColliderStreamer.js) run SERVER-side on their own setInterval loop with their own
// time-budget (COMPUTE_BUDGET_MS/ADD_BUDGET_MS, see AGENTS.md collider-streamer-fresh-territory-tick-
// stall) -- a genuinely separate process/runtime from this CLIENT-side scheduler, so it is not a direct
// consumer here; ctx.physics-facing servers can adopt the same scoring FUNCTION (scoreRequest, exported
// standalone) without adopting the queue itself. Audio (apps/_lib/audio.js) has no async streaming
// queue today -- defineAudio()'s play() fetches a whole small clip eagerly with no priority concept, so
// there is nothing to unify it with yet; it is wired as a no-op-cost consumer class only so a future
// large-audio-bank streaming feature has a queue to enqueue into on day one instead of re-discovering
// this same "every system reinvents its own nearest-first queue" problem.
//
// Design (data-first, per gm engineering invariants): a single request record type
//   { id, kind, score, run, cancel? }
// and ONE min-priority-heap-by-score ordering ALL of them, drained under ONE shared per-frame time
// budget (matching the house per-frame-budget idiom already used by ColliderStreamer's COMPUTE_BUDGET_MS
// and model-pool's _drainLodWarm/_drainGpuWarm adaptive-per-frame-start pacing) -- so "mesh LOD swap
// beats texture mip beats collider cook" is a property of the SCORE, not of which system happens to run
// its own drain first in program order. Score is lower-is-more-urgent (a real binary min-heap), matching
// the existing distance-sort convention in ColliderStreamer.classifyRing/model-pool._drainLodWarm (both
// already sort ascending-distance = ascending urgency), so porting either onto this scheduler is a
// straight scoreRequest() substitution, not an inverted-comparator rewrite.
//
// scoreRequest(features) -> numeric score, LOWER = MORE URGENT. features:
//   distance      real-world distance in meters, camera to request target (required)
//   screenSize    projected on-screen size in meters (radius or largest extent) at that distance,
//                 OPTIONAL -- a large object at range D is more urgent than a small one at the same D,
//                 because it costs more visible-error pixels while stale. Defaults to 1 (neutral).
//   inFrustum     boolean, OPTIONAL, default true. Out-of-frustum work is heavily deprioritized (not
//                 dropped -- a camera swing back needs it warm) via a fixed multiplier, never a hard
//                 exclude, so a queue-length spike doesn't starve every off-screen request forever.
//   gameplayBoost 0..1, OPTIONAL, default 0. A gameplay-authored urgency override (e.g. "this LOD swap
//                 is the enemy currently being aimed at") that linearly pulls the score toward zero
//                 (max urgency) independent of distance/screenSize -- so a request-author can express
//                 "this matters more than geometry alone says" without the score model needing to know
//                 every possible gameplay reason.
//
// The formula is intentionally simple + monotonic in each input (never a black box the caller can't
// reason about): base = distance / max(screenSize, MIN_SCREEN_SIZE); apply the frustum multiplier; then
// linearly interpolate toward 0 by gameplayBoost. Every term is independently testable (see the real
// exec_js verification run in the commit this file ships with).

const MIN_SCREEN_SIZE = 0.01       // metres; guards div-by-zero / near-zero screenSize from dominating the score
const OUT_OF_FRUSTUM_PENALTY = 8   // multiplier applied to base score when inFrustum === false

export function scoreRequest(features = {}) {
  const distance = Number.isFinite(features.distance) && features.distance >= 0 ? features.distance : Infinity
  const screenSize = Number.isFinite(features.screenSize) && features.screenSize > 0 ? features.screenSize : 1
  const inFrustum = features.inFrustum !== false
  const gameplayBoost = Number.isFinite(features.gameplayBoost) ? Math.min(1, Math.max(0, features.gameplayBoost)) : 0

  let score = distance / Math.max(screenSize, MIN_SCREEN_SIZE)
  if (!inFrustum) score *= OUT_OF_FRUSTUM_PENALTY
  // gameplayBoost=1 forces score to exactly 0 (always dispatched first among ties broken by insertion
  // order); gameplayBoost=0 leaves the geometry-derived score untouched. Linear so 0.5 halves it, not an
  // arbitrary curve a caller has to intuit.
  score = score * (1 - gameplayBoost)
  return score
}

// Binary min-heap keyed on .score (lower = dequeued first). Array-backed, no allocation on push beyond
// the array grow itself -- matches the allocation-conscious style already used by FrameMetrics'
// ring-buffer tracker. Ties broken by insertion sequence (stable-ish: earlier-enqueued wins) via a
// monotonic `_seq` tiebreaker folded into comparison, so two same-score requests don't reorder
// nondeterministically across drains (important for the ordering witness/test below).
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
  // O(n) removal by id -- rare path (explicit cancel), heap isn't optimized for it; acceptable since
  // queue sizes here are the same "small in practice" scale model-pool.js's own comment notes for its
  // _lodWarmQueue linear min-scan.
  removeById(id) {
    const a = this._a
    const idx = a.findIndex(it => it.id === id)
    if (idx === -1) return false
    const last = a.pop()
    if (idx < a.length) {
      a[idx] = last
      // Re-heapify from idx in both directions since the swapped-in element could violate either way.
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

// createStreamingScheduler(opts) -> the shared scheduler instance.
//   opts.budgetMs         per-drain() wall-clock time budget in ms (default 2, matching
//                         ColliderStreamer's COMPUTE_BUDGET_MS=2.5 / ADD_BUDGET_MS=2 house convention)
//   opts.maxStartsPerDrain hard cap on requests STARTED per drain() call regardless of remaining time
//                         budget, so one call never dispatches an unbounded burst even if each `run` is
//                         cheap (default 32)
//   opts.now              clock fn, injectable for a deterministic real-execution witness (default
//                         performance.now-or-Date.now, same fallback FrameMetrics/ColliderStreamer use)
export function createStreamingScheduler(opts = {}) {
  const budgetMs = Number.isFinite(opts.budgetMs) && opts.budgetMs > 0 ? opts.budgetMs : 2
  const maxStartsPerDrain = Number.isFinite(opts.maxStartsPerDrain) && opts.maxStartsPerDrain > 0 ? opts.maxStartsPerDrain : 32
  const _now = typeof opts.now === 'function' ? opts.now : (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now())

  const _heap = new _MinHeap()
  const _byId = new Map()          // id -> request record (for has()/cancel() O(1) lookup)
  let _seq = 0
  const _kindStats = new Map()     // kind -> { enqueued, dispatched, cancelled }
  const _dispatchLog = []          // last N dispatches, for ordering verification / debug inspection
  const DISPATCH_LOG_CAP = 256

  function _statsFor(kind) {
    let s = _kindStats.get(kind)
    if (!s) { s = { enqueued: 0, dispatched: 0, cancelled: 0 }; _kindStats.set(kind, s) }
    return s
  }

  // enqueue({ id, kind, features, run, cancel }) -- id must be unique per in-flight request (re-enqueuing
  // an existing id UPDATES its score/features in place, matching model-pool's existing
  // "nearest distance wins priority" _enqueueLodWarm idempotent-want semantics rather than duplicating
  // the entry). `run` is called with no args when dispatched (start the actual async work); its return
  // value is ignored by the scheduler (fire-and-forget dispatch -- the caller's own promise chain, e.g.
  // model-pool's ensureMeshLod().then(...), owns completion/error handling, matching the existing
  // per-system pattern this scheduler generalizes rather than replaces).
  function enqueue({ id, kind = 'unknown', features = {}, run, cancel } = {}) {
    if (!id || typeof run !== 'function') return false
    const score = scoreRequest(features)
    const existing = _byId.get(id)
    if (existing) {
      // Idempotent re-want: refresh score/run/cancel, keep the SAME record object so the heap's
      // in-place mutation + re-heapify (via removeById+push, O(log n)) reflects the new priority
      // immediately -- e.g. an object that was far and is now close jumps the queue, matching
      // _enqueueLodWarm's "nearest distance wins" comment generalized across every feature.
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

  // cancel(id) -- removes a not-yet-dispatched request. Calls its `cancel` callback if provided (so a
  // caller can e.g. abort an in-progress fetch controller). No-op if already dispatched or unknown.
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

  // drain() -- dispatch highest-priority (lowest-score) requests until EITHER the time budget OR the
  // per-drain start cap is exhausted, whichever comes first (matching model-pool._drainLodWarm's own
  // dual-bound: starts-- count AND _lodWarmInFlight cap). Returns the ordered list of dispatched
  // {id,kind,score} for this call, so a caller (or a live witness run) can directly observe real
  // dispatch ORDER without needing to separately instrument each consumer.
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
      try { rec.run() } catch (e) { /* a consumer's run() throwing must not stall the rest of this drain */ }
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

// Single shared client-side instance, matching the CullingHub/ShadowPipeline/RuntimeStats "one owner,
// window.__ mirror" convention (client/core/FrameMetrics.js's own top comment names this exact pattern).
// Call client-side once per frame, e.g. from a RenderGraph node analogous to the existing
// 'modelpool-update' node in client/app.js's buildFrameSectionNodes -- wiring model-pool's
// _enqueueLodWarm/_drainLodWarm through this shared instance (instead of its own private
// _lodWarmQueue) and a future KTX2 texture-mip consumer are the follow-up rows this scheduler unblocks.
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
