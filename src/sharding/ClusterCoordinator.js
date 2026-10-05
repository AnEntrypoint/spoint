import { ClusterWorldCapacityError } from './ClusterWorldHost.js'

export function createClusterCoordinator({ manager, host, descriptorOf, onHandoff = null }) {
  const refusals = []
  const refusedClusters = new Set()
  let queue = Promise.resolve()

  async function apply(result) {
    const live = new Set()
    for (const cluster of result.clusters) {
      live.add(cluster.id)
      if (!host.has(cluster.id) && !refusedClusters.has(cluster.id)) {
        try { await host.ensure(cluster.id, descriptorOf(cluster)) } catch (error) {
          if (!(error instanceof ClusterWorldCapacityError)) throw error
          refusedClusters.add(cluster.id)
          refusals.push({ clusterId: cluster.id, code: error.code, message: error.message, members: cluster.memberIds.length })
          console.error(`[clusters] ${error.message}`)
        }
      }
      host.noteMembers(cluster.id, cluster.memberIds.length)
    }
    for (const id of refusedClusters) if (!live.has(id)) refusedClusters.delete(id)
    for (const id of host.hostedIds) if (!live.has(id)) host.noteMembers(id, 0)
    for (const event of result.events) if (event.type === 'handoff' && onHandoff) await onHandoff(event, result)
    await host.sweep()
  }

  manager.onAssignment(result => { queue = queue.then(() => apply(result)) })

  return {
    settle: async () => { await queue },
    refusals,
    get refusedClusterIds() { return [...refusedClusters] },
  }
}
