import { definePlayerInventory } from './inventory.js'

const _pools = new Map()

const poolKey = (poolId) => poolId || 'default'

export function getSharedInventory(appCtx, opts = {}) {
  const key = poolKey(opts.poolId)
  let pool = _pools.get(key)
  if (!pool) {
    pool = { inv: definePlayerInventory(opts, appCtx), members: new Set() }
    _pools.set(key, pool)
  }
  pool.members.add(appCtx.entity.id)
  return pool.inv
}

export function isPoolOwner(poolId, entityId) {
  const pool = _pools.get(poolKey(poolId))
  if (!pool) return false
  for (const firstMember of pool.members) return firstMember === entityId
  return false
}

export function releaseSharedInventory(poolId, entityId) {
  const key = poolKey(poolId)
  const pool = _pools.get(key)
  if (!pool) return
  pool.members.delete(entityId)
  queueMicrotask(() => { if (pool.members.size === 0 && _pools.get(key) === pool) _pools.delete(key) })
}

export default getSharedInventory
