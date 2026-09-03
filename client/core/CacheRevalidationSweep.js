// CacheRevalidationSweep -- background revalidation for client/ModelCache.js's cached assets.
//
// WHY THIS EXISTS: ModelCache.fetchCached() only revalidates (HEAD + ETag compare) LAZILY, at the
// moment something actually re-requests a given URL -- an asset loaded once early in a long-lived
// session/tab and never re-fetched through the normal load path (e.g. a map's static-geometry GLB,
// loaded once at world-load and never touched again) can carry a stale IndexedDB cache entry for
// the entire session even after a redeploy moves the server-side content-hash ETag. This module
// walks the LRU manifest ModelCache already maintains on an idle cadence and issues a
// HEAD-revalidation for every entry past STALE_MS, so a long session eventually converges on
// fresh content without needing every asset to be re-requested through gameplay.
//
// Each revalidation is enqueue()d onto the shared StreamingScheduler (kind: 'cacheRevalidate',
// low/zero gameplayBoost, real distance if the asset happens to currently be placed in the scene)
// rather than firing as an uncoordinated background burst -- background bandwidth/CPU competing
// against live gameplay-critical streaming (mesh LOD warm-loads, texture mips) is exactly the
// "every system reinvents its own priority" problem StreamingScheduler.js exists to arbitrate away
// (see that file's own header). A cache-revalidation HEAD request is the least urgent traffic on
// the page by construction -- nothing is waiting on it, the cached bytes are already usable -- so it
// defaults to the worst (highest, least-urgent) score band via a fixed out-of-frustum-equivalent
// distance rather than 0/Infinity magic numbers, and yields immediately to anything with a real
// distance/gameplayBoost score.

import { listManifestEntries, revalidateEntry } from '../ModelCache.js'
import { getSharedStreamingScheduler } from './StreamingScheduler.js'

const STALE_MS = 30 * 60 * 1000        // 30 minutes since last revalidation (not last access -- an
                                        // entry in constant active use still gets swept periodically)
const SWEEP_INTERVAL_MS = 5 * 60 * 1000 // how often the idle timer looks for new stale candidates
const MAX_ENQUEUED_PER_SWEEP = 8        // cap how many HEAD requests one sweep pass can enqueue, so a
                                         // cold session with a large manifest doesn't burst-enqueue
                                         // hundreds of requests the scheduler then has to drain down
// Score inputs for a background revalidation request: no real on-screen size is known for an
// off-screen/unplaced cached asset, and it is never in the current view frustum by definition of
// "nobody has re-requested it" -- so it scores via the same distance/screenSize model everything
// else uses, just anchored far enough out (LOW_PRIORITY_DISTANCE) that any real gameplay streaming
// request (finite in-scene distance) always outranks it, matching the "least urgent traffic on the
// page" intent above without inventing a second score axis just for this consumer.
const LOW_PRIORITY_DISTANCE = 100000 // metres -- effectively "as far as it gets" on this scheduler's scale

// createCacheRevalidationSweep(opts) -> { sweepOnce, start, stop, getStats }. Factored as a plain
// factory (not a boot-time side effect) so it stays independently witnessable via exec_js/browser
// page.evaluate without needing a full app.js boot.
//   opts.scheduler       StreamingScheduler instance to enqueue onto (default: shared client instance)
//   opts.staleMs         override STALE_MS
//   opts.maxPerSweep     override MAX_ENQUEUED_PER_SWEEP
//   opts.now             clock fn override (Date.now-based, real-wall-clock semantics -- manifest
//                         timestamps are Date.now(), not performance.now())
export function createCacheRevalidationSweep(opts = {}) {
  const scheduler = opts.scheduler || getSharedStreamingScheduler()
  const staleMs = Number.isFinite(opts.staleMs) && opts.staleMs >= 0 ? opts.staleMs : STALE_MS
  const maxPerSweep = Number.isFinite(opts.maxPerSweep) && opts.maxPerSweep > 0 ? opts.maxPerSweep : MAX_ENQUEUED_PER_SWEEP
  const nowFn = typeof opts.now === 'function' ? opts.now : () => Date.now()

  const stats = { sweeps: 0, candidatesSeen: 0, enqueued: 0, revalidated: 0, changed: 0, errors: 0, lastSweepAt: 0 }
  let _timer = null
  let _inFlight = new Set() // urls currently enqueued/running, so a re-sweep before drain doesn't double-enqueue

  // sweepOnce() -> number of NEW revalidation requests enqueued this pass. Synchronous scan +
  // enqueue (the manifest read is the only await); the actual HEAD/refetch work runs later when
  // the shared scheduler's drain() dispatches each request, same as every other consumer.
  async function sweepOnce() {
    stats.sweeps++
    stats.lastSweepAt = nowFn()
    let entries
    try { entries = await listManifestEntries() } catch { return 0 }
    const cutoff = nowFn() - staleMs
    let enqueuedThisSweep = 0
    for (const entry of entries) {
      if (enqueuedThisSweep >= maxPerSweep) break
      stats.candidatesSeen++
      if (entry.lastRevalidated > cutoff) continue
      if (_inFlight.has(entry.url)) continue
      _inFlight.add(entry.url)
      enqueuedThisSweep++
      const id = `cacheRevalidate:${entry.url}`
      scheduler.enqueue({
        id,
        kind: 'cacheRevalidate',
        features: { distance: LOW_PRIORITY_DISTANCE, screenSize: 1, inFrustum: false, gameplayBoost: 0 },
        run: () => {
          stats.enqueued++
          revalidateEntry(entry.url).then(res => {
            stats.revalidated++
            if (res && res.changed) stats.changed++
          }).catch(() => { stats.errors++ }).finally(() => { _inFlight.delete(entry.url) })
        },
      })
    }
    return enqueuedThisSweep
  }

  function start() {
    if (_timer) return
    // Fire an initial sweep shortly after start (not immediately -- give boot-time loading its
    // own uncontended window on the scheduler/network) then repeat on SWEEP_INTERVAL_MS-equivalent
    // cadence via setInterval, matching the plain top-level setInterval idiom client/app.js already
    // uses for other non-per-frame background cadences (e.g. the 1Hz connection-quality poll).
    _timer = setInterval(() => { sweepOnce().catch(() => {}) }, SWEEP_INTERVAL_MS)
    setTimeout(() => { sweepOnce().catch(() => {}) }, 15000)
  }

  function stop() {
    if (_timer) { clearInterval(_timer); _timer = null }
  }

  function getStats() { return { ...stats, queued: scheduler.size(), inFlight: _inFlight.size } }

  return { sweepOnce, start, stop, getStats }
}

let _sharedSweep = null
export function getSharedCacheRevalidationSweep(opts) {
  if (!_sharedSweep) _sharedSweep = createCacheRevalidationSweep(opts)
  return _sharedSweep
}

if (typeof window !== 'undefined') {
  window.__cacheRevalidationSweep = {
    get: () => getSharedCacheRevalidationSweep(),
    sweepOnce: () => getSharedCacheRevalidationSweep().sweepOnce(),
    stats: () => getSharedCacheRevalidationSweep().getStats(),
  }
}
