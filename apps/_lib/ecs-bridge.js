// ecs-bridge.js — Adapter that wraps AppRuntime entity API with @spoint/ecs queries.
//
// FIRST SLICE of cross-project-ecs-appruntime-ecs-bridge. Before replacing the AppRuntime
// entity store, this bridge mirrors AppRuntime entities into an @spoint/ecs world so apps
// can use ECS queries alongside the existing ctx.world API. The bridge is a per-app construct:
// each app that wants ECS queries creates its own bridge via createEcsBridge(ctx, opts).
//
// The bridge syncs the AppRuntime's current entity set into an ECS world on each call to
// sync(), tagging each entity with components derived from its AppRuntime entity object:
//   - 'entity' component: { id, model, bodyType, position, appName, custom }
//   - tag components for appName, bodyType, and any custom._tags[] the entity carries
//
// Queries (bridge.query(spec)) are thin wrappers over @spoint/ecs createQuery, operating
// on the synced mirror world. Call bridge.sync() before querying to ensure the mirror is
// up to date with the current tick's entity set.
//
// Usage:
//   import { createEcsBridge } from '../_lib/ecs-bridge.js'
//   const bridge = createEcsBridge(ctx)
//   bridge.sync()
//   const enemies = bridge.query({ has: ['entity'], hasAny: ['tag:enemy'] })
//   for (const eid of enemies) {
//     const ent = bridge.world.getComponent(eid, 'entity')
//   }

import { createWorld, createQuery } from '@spoint/ecs'

/**
 * Create an ECS bridge that mirrors AppRuntime entities into an @spoint/ecs world.
 *
 * @param {object} ctx - AppContext (the app's ctx, providing ctx.world and ctx._runtime)
 * @param {object} [opts]
 * @param {string[]} [opts.syncComponents] - extra entity fields to mirror as ECS components
 *   (default: ['model', 'bodyType', 'appName', 'position']). Each field becomes a component
 *   named after the field, with the field's value as data.
 * @param {boolean} [opts.syncCustom] - when true, also mirror entity.custom keys as components
 *   (default: false). Custom keys starting with '_' are skipped (engine-internal).
 * @returns {object} bridge with { world, sync, query, destroy, getEntity, entityCount }
 */
export function createEcsBridge(ctx, opts = {}) {
  const runtime = ctx._runtime
  if (!runtime) throw new Error('[ecs-bridge] ctx._runtime is null — bridge must be created after setup()')

  const world = createWorld()
  const _syncFields = opts.syncComponents || ['model', 'bodyType', 'appName', 'position']
  const _syncCustom = opts.syncCustom === true

  // Map AppRuntime entity id -> ECS entity id (so we can find+update existing mirror entities)
  const _idMap = new Map()

  /**
   * Sync all AppRuntime entities into the ECS mirror world.
   * Call this once per tick before querying. Entities that were removed from AppRuntime
   * since the last sync are destroyed in the ECS world; new entities are created; existing
   * entities have their component data refreshed.
   *
   * Returns the number of entities synced.
   */
  function sync() {
    // Track which ECS ids are still alive in this sync pass
    const seen = new Set()

    for (const [appId, entity] of runtime.entities) {
      let ecsId = _idMap.get(appId)
      if (ecsId == null) {
        // New entity — create ECS mirror
        ecsId = world.createEntity()
        _idMap.set(appId, ecsId)
      }
      seen.add(ecsId)

      // --- Base 'entity' component with core fields ---
      world.addComponent(ecsId, 'entity', {
        id: entity.id,
        model: entity.model,
        bodyType: entity.bodyType,
        position: entity.position ? [...entity.position] : null,
        appName: entity._appName || null,
        custom: entity.custom || null,
      })

      // --- Sync requested fields as individual components ---
      for (const field of _syncFields) {
        if (entity[field] !== undefined) {
          world.addComponent(ecsId, field, entity[field])
        }
      }

      // --- Tag components for appName and bodyType ---
      if (entity._appName) world.addTag(ecsId, `app:${entity._appName}`)
      if (entity.bodyType) world.addTag(ecsId, `body:${entity.bodyType}`)

      // --- Tag components from custom._tags (if entity has them) ---
      if (entity.custom && Array.isArray(entity.custom._tags)) {
        for (const tag of entity.custom._tags) {
          if (typeof tag === 'string') world.addTag(ecsId, `tag:${tag}`)
        }
      }

      // --- Sync custom keys as components (opt-in) ---
      if (_syncCustom && entity.custom && typeof entity.custom === 'object') {
        for (const key of Object.keys(entity.custom)) {
          if (key.charCodeAt(0) === 95) continue // skip engine-internal keys
          world.addComponent(ecsId, `custom:${key}`, entity.custom[key])
        }
      }
    }

    // Remove entities that are no longer in AppRuntime
    for (const [appId, ecsId] of _idMap) {
      if (!seen.has(ecsId)) {
        world.destroyEntity(ecsId)
        _idMap.delete(appId)
      }
    }

    return world.entityCount
  }

  /**
   * Create a query over the synced ECS mirror world.
   * Thin wrapper around @spoint/ecs createQuery — same spec shape { has, hasAny, not }.
   * Call bridge.sync() before querying to ensure the mirror is current.
   *
   * @param {object} spec - same as createQuery's spec: { has, hasAny, not }
   * @returns {object} query object with refresh(), changed(), count(), get(), forEach(), [Symbol.iterator]
   */
  function query(spec) {
    return createQuery(world, spec)
  }

  /**
   * Look up the AppRuntime entity for a given ECS entity id.
   * Returns the AppRuntime entity object, or undefined if not found.
   */
  function getEntity(ecsId) {
    const ent = world.getComponent(ecsId, 'entity')
    if (!ent || !ent.id) return undefined
    return runtime.entities.get(ent.id) || runtime.getEntity?.(ent.id)
  }

  /**
   * Destroy the bridge: clear the ECS world and the id map.
   * Safe to call multiple times; idempotent.
   */
  function destroy() {
    for (const [, ecsId] of _idMap) {
      world.destroyEntity(ecsId)
    }
    _idMap.clear()
    world.destroy()
  }

  return {
    world,       // raw ECS world (for direct component reads/writes, registering systems, etc.)
    sync,        // sync AppRuntime entities into the ECS world
    query,       // create a query over the synced world
    getEntity,   // look up AppRuntime entity from ECS id
    destroy,     // clean up the bridge
    get entityCount() { return world.entityCount },
  }
}