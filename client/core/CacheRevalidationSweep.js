import { listManifestEntries, revalidateEntry } from '../ModelCache.js'
import { getSharedStreamingScheduler } from './StreamingScheduler.js'

const STALE_MS = 30 * 60 * 1000
const SWEEP_INTERVAL_MS = 5 * 60 * 1000
const MAX_ENQUEUED_PER_SWEEP = 8
const LOW_PRIORITY_DISTANCE = 100000
const FIRST_SWEEP_MS = 15000
const MAX_SWEEPS = 288
const SWEEP_DEADLINE_MS = 24 * 60 * 60 * 1000

export function createCacheRevalidationSweep(opts = {}) {
  const scheduler = opts.scheduler || getSharedStreamingScheduler()
  const staleMs = Number.isFinite(opts.staleMs) && opts.staleMs >= 0 ? opts.staleMs : STALE_MS
  const maxPerSweep = Number.isFinite(opts.maxPerSweep) && opts.maxPerSweep > 0 ? opts.maxPerSweep : MAX_ENQUEUED_PER_SWEEP
  const maxSweeps = Number.isFinite(opts.maxSweeps) && opts.maxSweeps > 0 ? opts.maxSweeps : MAX_SWEEPS
  const sweepDeadlineMs = Number.isFinite(opts.sweepDeadlineMs) && opts.sweepDeadlineMs > 0 ? opts.sweepDeadlineMs : SWEEP_DEADLINE_MS
  const nowFn = typeof opts.now === 'function' ? opts.now : () => Date.now()

  const stats = { sweeps: 0, candidatesSeen: 0, enqueued: 0, revalidated: 0, changed: 0, errors: 0, lastSweepAt: 0 }
  let _timer = null
  let _firstTimer = null
  let _inFlight = new Set()
  let _startedAt = 0
  let _verdict = null

  function _counters() {
    const s = getStats()
    return `sweeps=${s.sweeps} enqueued=${s.enqueued} revalidated=${s.revalidated} changed=${s.changed} errors=${s.errors}`
  }

  async function sweepOnce() {
    stats.sweeps++
    stats.lastSweepAt = nowFn()
    let entries
    try { entries = await listManifestEntries() } catch {
      console.log(`[cache-revalidate] sweep list-unavailable: ${_counters()}`)
      return 0
    }
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
    console.log(`[cache-revalidate] sweep ${_counters()}`)
    return enqueuedThisSweep
  }

  function _run() {
    if (_timer === null && _firstTimer === null) return
    sweepOnce().catch(() => {})
    if (stats.sweeps >= maxSweeps || nowFn() - _startedAt >= sweepDeadlineMs) _finish('cap')
  }

  function start() {
    if (_timer !== null || _firstTimer !== null) return false
    _startedAt = nowFn()
    _verdict = null
    _timer = setInterval(() => { _run() }, SWEEP_INTERVAL_MS)
    _firstTimer = setTimeout(() => { _firstTimer = null; _run() }, FIRST_SWEEP_MS)
    return true
  }

  function _finish(reason) {
    if (_timer === null && _firstTimer === null) return _verdict
    if (_timer !== null) { clearInterval(_timer); _timer = null }
    if (_firstTimer !== null) { clearTimeout(_firstTimer); _firstTimer = null }
    _verdict = { reason, sweeps: stats.sweeps, ms: nowFn() - _startedAt }
    console.log(`[cache-revalidate] ${reason} after ${_verdict.sweeps} sweeps / ${_verdict.ms}ms: ${_counters()}`)
    return _verdict
  }

  function stop() { return _finish('stopped') }

  function restart() {
    if (_timer !== null || _firstTimer !== null) return false
    return start()
  }

  function getStats() { return { ...stats, queued: scheduler.size(), inFlight: _inFlight.size } }

  return {
    sweepOnce,
    start,
    stop,
    restart,
    getStats,
    get stopped() { return _timer === null && _firstTimer === null },
    get verdict() { return _verdict },
    FIRST_SWEEP_MS,
    SWEEP_INTERVAL_MS,
    MAX_SWEEPS,
    SWEEP_DEADLINE_MS,
  }
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
    stop: () => getSharedCacheRevalidationSweep().stop(),
    restart: () => getSharedCacheRevalidationSweep().restart(),
    verdict: () => getSharedCacheRevalidationSweep().verdict,
    stopped: () => getSharedCacheRevalidationSweep().stopped,
  }
}
