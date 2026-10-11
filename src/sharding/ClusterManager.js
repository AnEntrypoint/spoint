import { createClusterAssigner } from '../shared/clusterAssignment.js'
import { messageRefusal } from './ShardingRefusal.js'

const TALLY_KEY_BY_EVENT = new Map([['handoff', 'handoffs'], ['merge', 'merges'], ['drop', 'dropped']])

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
  const tallies = { handoffs: 0, merges: 0, dropped: 0 }
  let lastStepAt = -Infinity, steps = 0, last = null, created = 0

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
      const key = TALLY_KEY_BY_EVENT.get(e?.type)
      if (key === undefined) {
        const refusal = messageRefusal('assignment-event-not-tallied', { type: e?.type ?? null })
        console.warn(`[clusters] assignment event ${JSON.stringify(refusal.detail.type)} is not tallied: ${refusal.code}`)
        continue
      }
      tallies[key]++
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
    get stats() { return { steps, created, ...tallies, players: dirs.size, clusters: last?.clusters.length ?? 0 } },
  }
}
