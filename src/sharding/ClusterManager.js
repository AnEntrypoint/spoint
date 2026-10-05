import { createClusterAssigner } from '../shared/clusterAssignment.js'

export function createClusterManager({ config, now = () => performance.now() }) {
  if (!config) throw new Error('cluster manager needs a resolved cluster config (resolveClusterConfig returned null: clusters are not enabled)')
  const assigner = createClusterAssigner({
    radius: config.radius, linkM: config.linkM, memberRadiusM: config.memberRadiusM, lattice: config.lattice,
    hysteresisDeg: config.hysteresisDeg, stayFactor: config.stayFactor, joinFactor: config.joinFactor,
  })
  const dirs = new Map()
  const listeners = []
  const reportedRejections = new Set()
  const periodMs = 1000 / config.hz
  let lastStepAt = -Infinity, steps = 0, last = null, handoffs = 0, merges = 0, created = 0, dropped = 0

  function setPlayerDir(id, dir) { dirs.set(id, dir) }
  function removePlayer(id) { dirs.delete(id) }

  function reportRejections(rejected) {
    for (const r of rejected) {
      const key = `${r.id}:${r.reason}`
      if (reportedRejections.has(key)) continue
      reportedRejections.add(key)
      console.warn(`[clusters] player ${r.id} left out of the assignment: ${r.reason}`)
    }
  }

  function step({ force = false } = {}) {
    const t = now()
    if (!force && t - lastStepAt < periodMs) return null
    lastStepAt = t
    const result = assigner.assign([...dirs].map(([id, dir]) => ({ id, dir })))
    steps++
    reportRejections(result.rejected)
    for (const c of result.clusters) if (c.created) created++
    for (const e of result.events) {
      if (e.type === 'handoff') handoffs++
      else if (e.type === 'merge') merges++
      else if (e.type === 'drop') dropped++
    }
    last = result
    for (const listener of listeners) listener(result)
    return result
  }

  function onAssignment(listener) {
    listeners.push(listener)
    return () => { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1) }
  }

  return {
    config, setPlayerDir, removePlayer, step, onAssignment,
    dirOf: id => dirs.get(id) ?? null,
    get last() { return last },
    clusterOf: id => last?.clusterOf.get(id) ?? null,
    get stats() { return { steps, created, handoffs, merges, dropped, players: dirs.size, clusters: last?.clusters.length ?? 0 } },
  }
}
