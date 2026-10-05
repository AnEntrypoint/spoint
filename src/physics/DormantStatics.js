const REINSERT_BATCH = 32
const REORDER_DISPLACEMENT_M = 32
const ORDER_BUCKET_M = 32
const ORDER_BUCKET_COUNT = 128

function reachAlongRay(center, radius, origin, direction, maxDistance) {
  const ox = center[0] - origin[0], oy = center[1] - origin[1], oz = center[2] - origin[2]
  const along = ox * direction[0] + oy * direction[1] + oz * direction[2]
  const perpendicular2 = ox * ox + oy * oy + oz * oz - along * along
  if (perpendicular2 > radius * radius) return Infinity
  const entry = along - Math.sqrt(radius * radius - perpendicular2)
  if (along + radius < 0 || entry > maxDistance) return Infinity
  return Math.max(0, entry)
}

export function createDormantStatics(world) {
  const J = world.Jolt
  const bodyIdBuffer = new J.ArrayBodyID()
  const entries = new Map()
  let queue = []
  let cursor = 0
  let orderedFor = null
  const stats = { parked: 0, reinserted: 0, drains: 0, maxDrainMs: 0, maxBatchMs: 0 }

  function localBoundsRadius(body) {
    const bounds = body.GetShape().GetLocalBounds()
    const mn = bounds.mMin, mx = bounds.mMax
    return Math.hypot(Math.max(Math.abs(mn.GetX()), Math.abs(mx.GetX())), Math.max(Math.abs(mn.GetY()), Math.abs(mx.GetY())), Math.max(Math.abs(mn.GetZ()), Math.abs(mx.GetZ())))
  }

  function park(parked) {
    if (parked.length === 0) return 0
    bodyIdBuffer.clear()
    for (const { bodyId, owner } of parked) {
      entries.set(bodyId, { bodyId, owner, radius: -1 })
      bodyIdBuffer.push_back(world.bodyIds.get(bodyId))
      world._staticTiles?.forget(bodyId)
    }
    world.bodyInterface.RemoveBodies(bodyIdBuffer.data(), parked.length)
    queue = queue.slice(cursor)
    cursor = 0
    for (const { bodyId } of parked) queue.push(bodyId)
    orderedFor = null
    stats.parked += parked.length
    return parked.length
  }

  function has(bodyId) { return entries.has(bodyId) }

  function forget(bodyId) { entries.delete(bodyId) }

  function orderNearestFirst(movers) {
    const pending = []
    for (let i = cursor; i < queue.length; i++) if (entries.has(queue[i])) pending.push(queue[i])
    const buckets = Array.from({ length: ORDER_BUCKET_COUNT }, () => [])
    for (const bodyId of pending) {
      const p = entries.get(bodyId).owner.position
      let best = Infinity
      for (const m of movers) { const dx = p[0] - m[0], dy = p[1] - m[1], dz = p[2] - m[2]; const d2 = dx * dx + dy * dy + dz * dz; if (d2 < best) best = d2 }
      buckets[Math.min(ORDER_BUCKET_COUNT - 1, Math.floor(Math.sqrt(best) / ORDER_BUCKET_M))].push(bodyId)
    }
    queue = buckets.flat()
    cursor = 0
    orderedFor = movers.map(m => [m[0], m[1], m[2]])
  }

  function needsReorder(movers) {
    if (!orderedFor || orderedFor.length !== movers.length) return true
    for (let i = 0; i < movers.length; i++) {
      const a = orderedFor[i], b = movers[i]
      if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > REORDER_DISPLACEMENT_M) return true
    }
    return false
  }

  function reinsertBatch(limit = REINSERT_BATCH) {
    const batch = []
    while (batch.length < limit && cursor < queue.length) {
      const bodyId = queue[cursor++]
      const entry = entries.get(bodyId)
      if (entry && world.bodies.has(bodyId)) batch.push(entry)
      else entries.delete(bodyId)
    }
    if (batch.length === 0) return 0
    bodyIdBuffer.clear()
    for (const { bodyId, owner } of batch) {
      world._repositionBody(bodyId, owner.position, owner.rotation)
      bodyIdBuffer.push_back(world.bodyIds.get(bodyId))
    }
    const addState = world.bodyInterface.AddBodiesPrepare(bodyIdBuffer.data(), batch.length)
    world.bodyInterface.AddBodiesFinalize(bodyIdBuffer.data(), batch.length, addState, J.EActivation_DontActivate)
    for (const { bodyId } of batch) entries.delete(bodyId)
    stats.reinserted += batch.length
    return batch.length
  }

  function drain(budgetMs, movers) {
    if (entries.size === 0) return 0
    const startedAt = performance.now()
    if (movers.length > 0 && needsReorder(movers)) orderNearestFirst(movers)
    let done = 0
    for (;;) {
      const batchStartedAt = performance.now()
      const n = reinsertBatch()
      if (n === 0) break
      done += n
      const now = performance.now()
      if (now - batchStartedAt > stats.maxBatchMs) stats.maxBatchMs = now - batchStartedAt
      if (now - startedAt >= budgetMs) break
    }
    if (entries.size === 0) { queue = []; cursor = 0; orderedFor = null }
    stats.drains++
    const spent = performance.now() - startedAt
    if (spent > stats.maxDrainMs) stats.maxDrainMs = spent
    return done
  }

  function drainAll() {
    let total = 0
    while (entries.size > 0) total += reinsertBatch(Infinity)
    queue = []; cursor = 0; orderedFor = null
    return total
  }

  function firstReach(origin, direction, maxDistance) {
    let nearest = Infinity
    for (const entry of entries.values()) {
      if (entry.radius < 0) entry.radius = localBoundsRadius(world.bodies.get(entry.bodyId))
      const reach = reachAlongRay(entry.owner.position, entry.radius, origin, direction, maxDistance)
      if (reach < nearest) nearest = reach
    }
    return nearest
  }

  function destroy() { J.destroy(bodyIdBuffer); entries.clear(); queue = [] }

  return { park, has, forget, drain, drainAll, firstReach, destroy, stats, get pendingCount() { return entries.size } }
}
