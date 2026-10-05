function rotationArrayOf(rotation) {
  if (Array.isArray(rotation)) return rotation
  if (rotation && Number.isFinite(rotation.w)) return [rotation.x || 0, rotation.y || 0, rotation.z || 0, rotation.w]
  return [0, 0, 0, 1]
}

function reexpressEntityTransform(pass, entity) {
  pass.point(entity.position)
  pass.vector(entity.velocity)
  entity.rotation = pass.transfer.quat(rotationArrayOf(entity.rotation))
  pass.point(entity._spawnPosition)
}

function isDynamicNow(entity) {
  return entity.bodyType === 'dynamic' && entity._bodyTier !== 'kinematic'
}

function moveBody(physics, pass, bodyId, position, rotation, dynamic) {
  physics.setBodyTransform(bodyId, position, rotation)
  if (!dynamic || !physics.isBodyActive(bodyId)) return false
  const angular = [...physics.getBodyAngularVelocity(bodyId)]
  pass.vector(angular)
  physics.setBodyAngularVelocity(bodyId, angular)
  return true
}

function reexpressRootBody(physics, pass, entity) {
  const dynamic = isDynamicNow(entity)
  const moved = moveBody(physics, pass, entity._physicsBodyId, entity.position, entity.rotation, dynamic)
  if (moved && entity.velocity) physics.setBodyVelocity(entity._physicsBodyId, entity.velocity)
}

function reexpressChildBody(physics, pass, entity) {
  const bodyId = entity._physicsBodyId
  const position = [...physics.getBodyPosition(bodyId)]
  const rotation = [...physics.getBodyRotation(bodyId)]
  const velocity = [...physics.getBodyVelocity(bodyId)]
  pass.point(position); pass.rotation(rotation); pass.vector(velocity)
  const moved = moveBody(physics, pass, bodyId, position, rotation, isDynamicNow(entity))
  if (moved) physics.setBodyVelocity(bodyId, velocity)
}

function reseatSpatialIndexes(appRuntime) {
  const stageLoader = appRuntime._stageLoader
  if (stageLoader) {
    for (const stage of stageLoader.allStages()) {
      for (const id of stage.entityIds) {
        const entity = appRuntime.entities.get(id)
        if (entity && stage.spatial.has(id)) stage.spatial.insert(id, entity.position)
      }
    }
  }
  for (const player of appRuntime.getPlayers()) {
    if (player.state?.position) appRuntime._playerIndex.insert(player.id, player.state.position)
  }
}

function invalidateEntityDerivedState(appRuntime) {
  for (const id of appRuntime.entities.keys()) appRuntime._markDirty(id)
  appRuntime._staticVersion++
  appRuntime._snapshotCache = null
  appRuntime._staticXf.clear()
}

function notifyChartAwareApps(appRuntime, event) {
  const payload = { epoch: event.epoch, transfer: event.transfer, from: event.from, to: event.to }
  let notified = 0
  for (const [entityId, appDef] of appRuntime.apps) {
    const server = appDef.server || appDef
    if (typeof server.onChartReanchor !== 'function') continue
    const ctx = appRuntime.contexts.get(entityId)
    appRuntime._safeCall(server, 'onChartReanchor', [ctx, payload], `onChartReanchor(${entityId})`)
    notified++
  }
  for (const [entityId, ctx] of appRuntime.contexts) {
    for (const api of ctx._chartAwareApis ?? []) {
      try { api.onChartReanchor(payload) } catch (e) { appRuntime._logAppError(`defined behaviour onChartReanchor(${entityId})`, e) }
      notified++
    }
  }
  for (const [entityId, list] of appRuntime._behaviours) {
    for (const { name, api } of list) {
      if (typeof api.onChartReanchor !== 'function') continue
      try { api.onChartReanchor(payload) } catch (e) { appRuntime._logAppError(`behaviour ${name}.onChartReanchor(${entityId})`, e) }
      notified++
    }
  }
  return notified
}

export function createEntityMigrator({ appRuntime }) {
  return function migrateEntities(event, pass) {
    const physics = appRuntime._physics
    const counts = { roots: 0, children: 0, bodiesMoved: 0, attachments: 0, notified: 0 }
    const withBody = []
    let bodyMs = 0
    const startedAt = performance.now()
    for (const entity of appRuntime.entities.values()) {
      if (entity.parent) { counts.children++; if (entity._physicsBodyId !== undefined) withBody.push(entity); continue }
      reexpressEntityTransform(pass, entity)
      counts.roots++
      if (physics && entity._physicsBodyId !== undefined) {
        const bodyStartedAt = performance.now()
        reexpressRootBody(physics, pass, entity)
        bodyMs += performance.now() - bodyStartedAt
        counts.bodiesMoved++
      }
    }
    for (const entity of withBody) {
      if (!physics) break
      reexpressChildBody(physics, pass, entity)
      counts.bodiesMoved++
    }
    for (const attachment of appRuntime._attachments.values()) { pass.vector(attachment.offset); counts.attachments++ }
    const bodiesDoneAt = performance.now()
    invalidateEntityDerivedState(appRuntime)
    const invalidatedAt = performance.now()
    reseatSpatialIndexes(appRuntime)
    const reseatedAt = performance.now()
    counts.notified = notifyChartAwareApps(appRuntime, event)
    counts.ms = { loop: bodiesDoneAt - startedAt, bodiesOfLoop: bodyMs, invalidate: invalidatedAt - bodiesDoneAt, reseat: reseatedAt - invalidatedAt, notify: performance.now() - reseatedAt }
    return counts
  }
}
