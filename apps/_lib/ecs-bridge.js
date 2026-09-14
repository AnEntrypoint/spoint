import { createWorld, createQuery } from '@spoint/ecs'

const ENGINE_INTERNAL_KEY_PREFIX_CODE = '_'.charCodeAt(0)

export function createEcsBridge(ctx, opts = {}) {
  const runtime = ctx._runtime
  if (!runtime) throw new Error('[ecs-bridge] ctx._runtime is null — bridge must be created after setup()')

  const world = createWorld()
  const _syncFields = opts.syncComponents || ['model', 'bodyType', 'appName', 'position']
  const _syncCustom = opts.syncCustom === true

  const _idMap = new Map()

  function sync() {
    const seen = new Set()

    for (const [appId, entity] of runtime.entities) {
      let ecsId = _idMap.get(appId)
      if (ecsId == null) {
        ecsId = world.createEntity()
        _idMap.set(appId, ecsId)
      }
      seen.add(ecsId)

      world.addComponent(ecsId, 'entity', {
        id: entity.id,
        model: entity.model,
        bodyType: entity.bodyType,
        position: entity.position ? [...entity.position] : null,
        appName: entity._appName || null,
        custom: entity.custom || null,
      })

      for (const field of _syncFields) {
        if (entity[field] !== undefined) {
          world.addComponent(ecsId, field, entity[field])
        }
      }

      if (entity._appName) world.addTag(ecsId, `app:${entity._appName}`)
      if (entity.bodyType) world.addTag(ecsId, `body:${entity.bodyType}`)

      if (entity.custom && Array.isArray(entity.custom._tags)) {
        for (const tag of entity.custom._tags) {
          if (typeof tag === 'string') world.addTag(ecsId, `tag:${tag}`)
        }
      }

      if (_syncCustom && entity.custom && typeof entity.custom === 'object') {
        for (const key of Object.keys(entity.custom)) {
          if (key.charCodeAt(0) === ENGINE_INTERNAL_KEY_PREFIX_CODE) continue
          world.addComponent(ecsId, `custom:${key}`, entity.custom[key])
        }
      }
    }

    for (const [appId, ecsId] of _idMap) {
      if (!seen.has(ecsId)) {
        world.destroyEntity(ecsId)
        _idMap.delete(appId)
      }
    }

    return world.entityCount
  }

  function query(spec) {
    return createQuery(world, spec)
  }

  function getEntity(ecsId) {
    const ent = world.getComponent(ecsId, 'entity')
    if (!ent || !ent.id) return undefined
    return runtime.entities.get(ent.id) || runtime.getEntity?.(ent.id)
  }

  function destroy() {
    for (const [, ecsId] of _idMap) {
      world.destroyEntity(ecsId)
    }
    _idMap.clear()
    world.destroy()
  }

  return {
    world,
    sync,
    query,
    getEntity,
    destroy,
    get entityCount() { return world.entityCount },
  }
}