// CullingHub -- one glance at every culling/occlusion system's health. Each system registers a
// stats getter; aggregate() returns per-system stats + summed totals over the uniform shape
// (cull-stats-uniform-shape): {candidates, queriedThisFrame, resolved, occluded, failOpens,
// anomalyTrips, flips, oldestPendingFrames} -- every culling system (TerrainOcclusion.js,
// SceneOcclusion.js, ModelPoolAdapter.js) now emits exactly this shape from getStats(); oldestPendingFrames
// is MAX (worst-case pending age), not summed, since summing ages across systems isn't meaningful.
// window.__culling is the live surface: one page.evaluate (window.__culling.aggregate()) answers
// "is culling healthy" without opening anything. Registration is defensive -- a getter throwing
// reports {error} for that system instead of taking the aggregate down.
export function createCullingHub() {
  const systems = new Map()
  const SUM_KEYS = ['candidates', 'queriedThisFrame', 'resolved', 'occluded', 'failOpens', 'anomalyTrips', 'flips']
  const MAX_KEYS = ['oldestPendingFrames']
  const TOTAL_KEYS = [...SUM_KEYS, ...MAX_KEYS]   // back-compat export: any external reader iterating TOTAL_KEYS still sees every key
  function register(name, getStats) { systems.set(name, getStats) }
  function unregister(name) { systems.delete(name) }
  function aggregate() {
    const per = {}, totals = {}
    for (const k of SUM_KEYS) totals[k] = 0
    for (const k of MAX_KEYS) totals[k] = 0
    for (const [name, get] of systems) {
      let s
      try { s = get() } catch (e) { s = { error: e.message } }
      per[name] = s || null
      if (!s) continue
      for (const k of SUM_KEYS) if (Number.isFinite(s[k])) totals[k] += s[k]
      for (const k of MAX_KEYS) if (Number.isFinite(s[k]) && s[k] > totals[k]) totals[k] = s[k]
    }
    return { systems: per, totals }
  }
  const hub = { register, unregister, aggregate }
  if (typeof window !== 'undefined') window.__culling = hub
  return hub
}
