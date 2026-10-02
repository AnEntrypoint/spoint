const DEFAULT_IDLE_FRAMES = 30
const DEFAULT_IDLE_MS = 500
const DEFAULT_TIMEOUT_MS = 90000
const GROUND_PROBE_EVERY_FRAMES = 6
const GROUND_ABOVE_MAX_M = 15
const GROUND_BELOW_MIN_M = 0
const PREFETCH_EVERY_FRAMES = 30
const FRAME_FALLBACK_MS = 50

const nextFrame = () => new Promise((resolve) => {
  const t = setTimeout(resolve, FRAME_FALLBACK_MS)
  requestAnimationFrame(() => { clearTimeout(t); resolve() })
})

function streamerSnapshot() {
  const veg = window.__veg, rocks = window.__rocks, grass = window.__grass, pool = window.__modelPool
  const poolStats = pool && typeof pool.getStats === 'function' ? pool.getStats() : null
  const scheduler = window.__streamingScheduler && window.__streamingScheduler.get().getStats()
  const hpfPending = window.__terrain?.planet && typeof window.__terrain.planet.hpfPending === 'function' ? window.__terrain.planet.hpfPending() : 0
  const deferred = poolStats?.deferredLoading
  const pending = (poolStats?.inFlight || 0) + (deferred?.queued ?? deferred?.pending ?? 0) + (scheduler?.queued || 0) + hpfPending
  return {
    pending,
    loadedChunks: {
      vegInstances: veg ? veg.totalInstances : null,
      rockInstances: rocks ? rocks.totalInstances : null,
      grassInstances: grass ? grass.totalInstances : null,
      modelPoolEntities: poolStats ? poolStats.entities : null,
      modelPoolInFlight: poolStats ? poolStats.inFlight : null,
      schedulerQueued: scheduler ? scheduler.queued : null,
      hpfPending,
    },
  }
}

function firstDrift(base, current, tolerance) {
  for (const key of Object.keys(current)) {
    const a = base[key], b = current[key]
    if (a === null || b === null) { if (a !== b) return key; continue }
    if (Math.abs(b - a) > tolerance * Math.max(1, Math.abs(a))) return key
  }
  return null
}

export async function whenSettled({ idleFrames, idleMs = DEFAULT_IDLE_MS, timeoutMs = DEFAULT_TIMEOUT_MS, requireGround = true, tolerance = 0 } = {}) {
  const idleWindowMs = idleFrames != null ? (idleFrames * 1000) / 60 : idleMs
  const client = window.__client
  if (!client || typeof client.requestTeleport !== 'function') throw new Error('whenSettled: no connected client')
  const frame = window.__terrain?.frame || null
  const t0 = performance.now()
  let stableUntil = null, frames = 0, base = null, drifting = 'init', ground = null, patchExact = frame && typeof frame._patchHeightOrNull === 'function' ? false : null
  let last = null
  while (performance.now() - t0 < timeoutMs) {
    await nextFrame()
    frames++
    const now = performance.now()
    const local = client.getLocalState()
    if (!local) continue
    const p = local.position
    if (frame && typeof frame._patchPrefetch === 'function' && frames % PREFETCH_EVERY_FRAMES === 1) frame._patchPrefetch(p[0], p[2])
    if (patchExact !== null) patchExact = Number.isFinite(frame._patchHeightOrNull(p[0], p[2]))
    if (requireGround && (frames % GROUND_PROBE_EVERY_FRAMES === 1 || !ground)) {
      const probe = await client.requestTeleport('probe', { x: p[0], z: p[2], fromY: p[1] }, 10000)
      const dy = probe.hit ? p[1] - probe.y : null
      ground = { hit: probe.hit, y: probe.y, dy, supported: probe.hit && dy > GROUND_BELOW_MIN_M && dy < GROUND_ABOVE_MAX_M, workerPosition: probe.player }
    }
    const snap = streamerSnapshot()
    const ready = (!requireGround || ground?.supported) && patchExact !== false && snap.pending === 0
    drifting = base ? firstDrift(base, snap.loadedChunks, tolerance) : 'init'
    if (ready && !drifting) { if (stableUntil === null) stableUntil = now }
    else { stableUntil = null; base = { ...snap.loadedChunks } }
    last = { position: [...p], groundHit: ground, patchExact, loadedChunks: snap.loadedChunks, pending: snap.pending }
    if (stableUntil !== null && now - stableUntil >= idleWindowMs) {
      return { ...last, frames, idleMs: Math.round(now - stableUntil), idleWindowMs: Math.round(idleWindowMs), ms: Math.round(now - t0) }
    }
  }
  const error = new Error(`whenSettled timed out after ${timeoutMs}ms`)
  error.report = { ...last, frames, ms: Math.round(performance.now() - t0), timedOut: true, stillChanging: drifting }
  throw error
}
