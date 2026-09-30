import { makeDirToFaceMemo, createPatchBaker } from './patch-baker.js'

const MAX_IN_FLIGHT = 32
const MAX_UNCLAIMED = 96
const READY_TIMEOUT_MS = 60000
const NO_TILE_WATCHDOG_MS = 45000

export function createRemotePatchBaker(opts = {}) {
  if (typeof Worker === 'undefined') return Promise.resolve(null)
  let worker
  try { worker = new Worker(new URL('./patch-baker-worker.js', import.meta.url), { type: 'module' }) }
  catch (e) { console.warn('[PatchBaker] worker construction failed:', e && e.message || e); return Promise.resolve(null) }
  const bakerOpts = { radius: opts.radius, reliefScale: opts.reliefScale, seed: opts.seed }
  const unclaimed = new Map()
  const inFlight = new Set()
  const statsWaiters = []
  const stats = { requested: 0, received: 0, failed: 0, evicted: 0, throttled: 0, dead: null, fallback: false }
  let isReady = false
  let lastTileAt = 0
  let fallback = null
  let settleReady
  const ready = new Promise((resolve) => { settleReady = resolve })

  function resolveStatsWaiters(value) { const waiters = statsWaiters.splice(0); for (const w of waiters) w(value) }

  function die(reason) {
    if (stats.dead) return
    stats.dead = reason
    console.warn('[PatchBaker] worker bake stopped (' + reason + ') -> main-thread GPU patch bake (readbacks stall the frame)')
    try { worker.terminate() } catch (_) {}
    inFlight.clear()
    resolveStatsWaiters(null)
    createPatchBaker(bakerOpts).then((b) => { fallback = b; stats.fallback = !!b }).catch(() => { stats.fallback = false })
  }

  worker.onmessage = (e) => {
    const m = e.data
    if (m.type === 'ready') { settleReady(m); return }
    if (m.type === 'stats') { resolveStatsWaiters(m.stats); return }
    if (m.type === 'failed') { die(m.reason); return }
    if (m.type !== 'tile') return
    inFlight.delete(m.key)
    lastTileAt = performance.now()
    if (!m.heights) { stats.failed++; return }
    stats.received++
    unclaimed.set(m.key, m.heights)
    if (unclaimed.size > MAX_UNCLAIMED) { unclaimed.delete(unclaimed.keys().next().value); stats.evicted++ }
  }
  worker.onerror = (e) => {
    const reason = 'worker error: ' + (e && e.message || e)
    if (isReady) die(reason)
    else { console.warn('[PatchBaker] ' + reason); settleReady({ ok: false, res: 0 }) }
  }
  worker.postMessage({ type: 'init', opts: bakerOpts })

  function bakeTileAsync(face, ox, oy, l, level = 0, deferFlush = false) {
    if (stats.dead) return fallback ? fallback.bakeTileAsync(face, ox, oy, l, level, deferFlush) : null
    const key = face + ':' + ox + ':' + oy + ':' + l + ':' + level
    const heights = unclaimed.get(key)
    if (heights) {
      if (deferFlush) return null
      unclaimed.delete(key)
      return heights
    }
    if (stats.received > 0 && inFlight.size > 0 && performance.now() - lastTileAt > NO_TILE_WATCHDOG_MS) { die('no tile for ' + NO_TILE_WATCHDOG_MS + ' ms with ' + inFlight.size + ' in flight'); return null }
    if (inFlight.has(key)) return null
    if (inFlight.size >= MAX_IN_FLIGHT) { stats.throttled++; return null }
    if (inFlight.size === 0) lastTileAt = performance.now()
    inFlight.add(key); stats.requested++
    worker.postMessage({ type: 'bake', key, face: face | 0, ox, oy, l, level })
    return deferFlush ? false : null
  }
  function flushBakes() { if (fallback) fallback.flushBakes() }
  function workerStats() {
    if (stats.dead) return Promise.resolve(null)
    return new Promise((resolve) => { statsWaiters.push(resolve); worker.postMessage({ type: 'stats' }) })
  }
  function dispose() { try { worker.terminate() } catch (_) {} unclaimed.clear(); inFlight.clear(); resolveStatsWaiters(null) }

  const readyTimeout = new Promise((resolve) => setTimeout(() => resolve({ ok: false, res: 0, timedOut: true }), READY_TIMEOUT_MS))
  return Promise.race([ready, readyTimeout]).then((r) => {
    if (!r || !r.ok) { if (r && r.timedOut) console.warn('[PatchBaker] worker init exceeded ' + READY_TIMEOUT_MS + ' ms'); dispose(); return null }
    isReady = true
    return {
      bakeTileAsync, flushBakes, dirToFace: makeDirToFaceMemo(opts.radius), res: r.res,
      remote: true, stats, workerStats, inFlightCount: () => inFlight.size, dispose,
    }
  })
}
