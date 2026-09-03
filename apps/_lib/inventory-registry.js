// Shared per-world inventory registry: definePlayerInventory (apps/_lib/inventory.js) returns a fresh,
// isolated bag store every call -- fine for a single owning entity, but a world with MULTIPLE pickup/shop
// entities (apps/item-pickup, a future apps/shop) all need to mutate the SAME per-player inventory, not
// one bag per entity. Module-scope state (survives across every app instance in one server process,
// mirrors apps/tps-game/server.js's own ctx.state.scoreboardByName module-level-import pattern) keyed by
// a `poolId` string (default 'default' -- every pickup entity in a world sharing the default pool sees the
// same player bags) so multiple entities compose without any explicit wiring.
//
// getSharedInventory(appCtx, opts) -> the same definePlayerInventory instance for a given poolId within
// this process, constructed lazily on first call using the FIRST caller's opts (spec/itemDefs/catalog) --
// a second entity requesting the same poolId gets the already-built instance, its own opts are ignored
// (documented, not silently mismatched: differing opts across entities sharing a pool is an authoring
// mistake the first-wins behavior surfaces at inspection time via inspectPool, not a runtime crash).

import { definePlayerInventory } from './inventory.js'

const _pools = new Map()   // poolId -> the definePlayerInventory() instance
const _poolOwners = new Map()   // poolId -> the entityId that FIRST constructed this pool's inventory

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

// True if `entityId` is the pool's OWNER (the entity that first constructed it). A world with multiple
// item-pickup/shop entities sharing one poolId all correctly call add()/remove()/dropOnDeath() on the
// SAME inventory instance -- but an admin/debug/broadcast onMessage handler (inventory_query, debug_kill,
// a future 'buy'-from-any-shop-entity dispatch) that every entity in the pool independently implements
// would otherwise run ONCE PER ENTITY for a single incoming client message (each entity's onMessage fires
// from the same broadcast fan-out), double/triple-applying an action meant to happen exactly once per
// message. Gate any such handler on isPoolOwner(poolId, ctx.entity.id) so only ONE entity acts on it.
export function isPoolOwner(poolId, entityId) {
  return _poolOwners.get(poolId || 'default') === entityId
}

// Test/reset hook: clears every pool (used between fresh server boots sharing one process only -- a real
// server process naturally starts with an empty registry, this exists for the rare case a long-lived
// process needs to fully reset without restarting, e.g. a "new match" world reload).
export function clearAllInventoryPools() {
  _pools.clear()
}

export default getSharedInventory
