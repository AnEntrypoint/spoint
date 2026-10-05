export class ClusterWorldCapacityError extends Error {
  constructor(clusterId, hosted, maxWorlds) {
    super(`cluster-world-capacity-exhausted: cluster ${clusterId} needs a world but this process already hosts ${hosted} of ${maxWorlds} (the Jolt wasm heap is fixed at 128 MiB); route the cluster to another process`)
    this.name = 'ClusterWorldCapacityError'
    this.code = 'cluster-world-capacity-exhausted'
    this.clusterId = clusterId
  }
}

export function createClusterWorldHost({ createWorld, destroyWorld, maxWorlds, idleGraceMs, now = () => performance.now() }) {
  const worlds = new Map()
  let created = 0, destroyed = 0, refused = 0

  function ensure(clusterId, descriptor) {
    const existing = worlds.get(clusterId)
    if (existing) return existing.ready
    if (worlds.size >= maxWorlds) {
      refused++
      return Promise.reject(new ClusterWorldCapacityError(clusterId, worlds.size, maxWorlds))
    }
    const entry = { clusterId, descriptor, emptySince: null, world: null, createdAt: now() }
    entry.ready = createWorld(clusterId, descriptor).then(world => { entry.world = world; created++; return world })
    entry.ready.catch(() => { if (worlds.get(clusterId) === entry) worlds.delete(clusterId) })
    worlds.set(clusterId, entry)
    return entry.ready
  }

  function noteMembers(clusterId, memberCount) {
    const entry = worlds.get(clusterId)
    if (!entry) return
    if (memberCount > 0) entry.emptySince = null
    else if (entry.emptySince === null) entry.emptySince = now()
  }

  async function destroy(clusterId) {
    const entry = worlds.get(clusterId)
    if (!entry) return false
    worlds.delete(clusterId)
    const world = await entry.ready
    await destroyWorld(clusterId, world)
    destroyed++
    return true
  }

  async function sweep() {
    const t = now()
    const due = [...worlds.values()].filter(e => e.emptySince !== null && t - e.emptySince >= idleGraceMs).map(e => e.clusterId)
    for (const id of due) await destroy(id)
    return due
  }

  return {
    ensure, noteMembers, sweep, destroy,
    worldOf: clusterId => worlds.get(clusterId)?.world ?? null,
    has: clusterId => worlds.has(clusterId),
    get hostedIds() { return [...worlds.keys()] },
    get stats() { return { hosted: worlds.size, maxWorlds, created, destroyed, refused } },
  }
}
