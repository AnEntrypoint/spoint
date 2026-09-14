import { listManifestEntries, revalidateEntry } from '../ModelCache.js'
import { getSharedStreamingScheduler } from './StreamingScheduler.js'

const STALE_MS = 30 * 60 * 1000
const SWEEP_INTERVAL_MS = 5 * 60 * 1000
const MAX_ENQUEUED_PER_SWEEP = 8
const LOW_PRIORITY_DISTANCE = 100000

export function createCacheRevalidationSweep(opts = {}) {
  const scheduler = opts.scheduler || getSharedStreamingScheduler()
  const staleMs = Number.isFinite(opts.staleMs) && opts.staleMs >= 0 ? opts.staleMs : STALE_MS
  const maxPerSweep = Number.isFinite(opts.maxPerSweep) && opts.maxPerSweep > 0 ? opts.maxPerSweep : MAX_ENQUEUED_PER_SWEEP
  const nowFn = typeof opts.now === 'function' ? opts.now : () => Date.now()

  const stats = { sweeps: 0, candidatesSeen: 0, enqueued: 0, revalidated: 0, changed: 0, errors: 0, lastSweepAt: 0 }
  let _timer = null
  let _inFlight = new Set()

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
