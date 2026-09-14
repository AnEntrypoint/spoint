import { definePlayerInventory } from './inventory.js'

const _pools = new Map()
const _poolOwners = new Map()

export function getSharedInventory(appCtx, opts = {}) {
  const poolId = opts.poolId || 'default'
  let inv = _pools.get(poolId)
  if (!inv) {
    inv = definePlayerInventory(opts, appCtx)
    _pools.set(poolId, inv)
    _poolOwners.set(poolId, appCtx.entity.id)
  }
  return inv
}

export function isPoolOwner(poolId, entityId) {
  return _poolOwners.get(poolId || 'default') === entityId
}

export function clearAllInventoryPools() {
  _pools.clear()
  _poolOwners.clear()
}

export default getSharedInventory
