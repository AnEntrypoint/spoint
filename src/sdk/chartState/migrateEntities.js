const DEFERRAL_SAFE_RADIUS_M = 96
const MOVER_CELL_M = DEFERRAL_SAFE_RADIUS_M
const STATIC_BUDGET_CHECK_INTERVAL = 64

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


function createStaticTransformer(transfer) {
  const m = transfer.m, q = transfer.qM, c = transfer.point([0, 0, 0])
  const m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3], m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7], m8 = m[8]
  const c0 = c[0], c1 = c[1], c2 = c[2]
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3]
  function movePoint(p) {
    const a = p[0], b = p[1], d = p[2]
    p[0] = m0 * a + m1 * b + m2 * d + c0
    p[1] = m3 * a + m4 * b + m5 * d + c1
    p[2] = m6 * a + m7 * b + m8 * d + c2
  }
  return function transformStatic(entity) {
    movePoint(entity.position)
    if (entity._spawnPosition) movePoint(entity._spawnPosition)
    const r = rotationArrayOf(entity.rotation)
    const x = qw * r[0] + qx * r[3] + qy * r[2] - qz * r[1]
    const y = qw * r[1] - qx * r[2] + qy * r[3] + qz * r[0]
    const z = qw * r[2] + qx * r[1] - qy * r[0] + qz * r[3]
    const w = qw * r[3] - qx * r[0] - qy * r[1] - qz * r[2]
    const l = Math.sqrt(x * x + y * y + z * z + w * w) || 1
    entity.rotation = [x / l, y / l, z / l, w / l]
  }
}


function isDynamicNow(entity) {
  return entity.bodyType === 'dynamic' && entity._bodyTier !== 'kinematic'
}


function hasBody(entity) {
  return entity._physicsBodyId !== undefined
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


function cellKeyOf(x, z) {
  return Math.floor(x / MOVER_CELL_M) * 4194304 + Math.floor(z / MOVER_CELL_M)
}


export function collectMovers(appRuntime, movingEntities) {
  const points = []
  for (const player of appRuntime.getPlayers()) if (player.state?.position) points.push(player.state.position)
  for (const entity of movingEntities) points.push(entity.position)
  return points
}


function indexMovers(points) {
  const cells = new Map()
  for (const p of points) {
    const key = cellKeyOf(p[0], p[2])
    const bucket = cells.get(key)
    if (bucket) bucket.push(p); else cells.set(key, [p])
  }
  return cells
}


function nearAnyMover(cells, p) {
  const radius2 = DEFERRAL_SAFE_RADIUS_M * DEFERRAL_SAFE_RADIUS_M
  const cx = Math.floor(p[0] / MOVER_CELL_M), cz = Math.floor(p[2] / MOVER_CELL_M)
  for (let gx = cx - 1; gx <= cx + 1; gx++) {
    for (let gz = cz - 1; gz <= cz + 1; gz++) {
      const bucket = cells.get(gx * 4194304 + gz)
      if (!bucket) continue
      for (const m of bucket) {
        const dx = m[0] - p[0], dy = m[1] - p[1], dz = m[2] - p[2]
        if (dx * dx + dy * dy + dz * dz <= radius2) return true
      }
    }
  }
  return false
}


export function placeStaticBodies(physics, statics, movers, budgetMs) {
  const cells = indexMovers(movers)
  const dormant = physics.dormantStatics
  const startedAt = performance.now()
  const parked = []
  let nearMoved = 0, budgetMoved = 0, nearMs = 0
  let outOfBudget = false
  for (let i = 0; i < statics.length; i++) {
    const entity = statics[i]
    if (dormant.has(entity._physicsBodyId)) continue
    if (nearAnyMover(cells, entity.position)) {
      const movedAt = performance.now()
      physics.setBodyTransform(entity._physicsBodyId, entity.position, entity.rotation)
      nearMs += performance.now() - movedAt
      nearMoved++
      continue
    }
    if (!outOfBudget && i % STATIC_BUDGET_CHECK_INTERVAL === 0 && performance.now() - startedAt >= budgetMs) outOfBudget = true
    if (outOfBudget) { if (physics.bodies.has(entity._physicsBodyId)) parked.push({ bodyId: entity._physicsBodyId, owner: entity }); continue }
    physics.setBodyTransform(entity._physicsBodyId, entity.position, entity.rotation)
    budgetMoved++
  }
  const parkStartedAt = performance.now()
  dormant.park(parked)
  const finishedAt = performance.now()
  return { nearMoved, budgetMoved, parked: parked.length, nearMs, parkMs: finishedAt - parkStartedAt, ms: finishedAt - startedAt }
}


function reseatSpatialIndexes(appRuntime) {
  const stageLoader = appRuntime._stageLoader
  const positionOf = id => appRuntime.entities.get(id)?.position
  if (stageLoader) for (const stage of stageLoader.allStages()) stage.spatial.reseat(positionOf)
  for (const player of appRuntime.getPlayers()) {
    if (player.state?.position) appRuntime._playerIndex.insert(player.id, player.state.position)
  }
}


function invalidateEntityDerivedState(appRuntime) {
  for (const id of appRuntime.entities.keys()) appRuntime._markDirty(id)
  appRuntime._staticVersion++
  appRuntime._snapshotEncCache.clear()
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
    for (const api of ctx._liveChartAwareApis()) {
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


export function createEntityMigrator({ appRuntime, staticBudgetMs }) {
  return function migrateEntities(event, pass) {
    const physics = appRuntime._physics
    const counts = { roots: 0, children: 0, bodiesMoved: 0, attachments: 0, notified: 0 }
    const withBody = [], statics = [], movers = []
    const transformStatic = createStaticTransformer(pass.transfer)
    const startedAt = performance.now()
    for (const entity of appRuntime.entities.values()) {
      if (entity.parent) { counts.children++; if (hasBody(entity)) withBody.push(entity); continue }
      counts.roots++
      if (entity.bodyType === 'static' && entity._vehicleId == null) {
        transformStatic(entity)
        if (physics && hasBody(entity)) statics.push(entity)
        continue
      }
      reexpressEntityTransform(pass, entity)
      if (physics && entity._physicsBodyId !== undefined) {
        reexpressRootBody(physics, pass, entity)
        counts.bodiesMoved++
        movers.push(entity)
      }
    }
    for (const entity of withBody) {
      if (!physics) break
      reexpressChildBody(physics, pass, entity)
      counts.bodiesMoved++
      movers.push(entity)
    }
    for (const attachment of appRuntime._attachments.values()) { pass.vector(attachment.offset); counts.attachments++ }
    const dynamicsDoneAt = performance.now()
    counts.statics = physics && statics.length ? placeStaticBodies(physics, statics, collectMovers(appRuntime, movers), staticBudgetMs) : { nearMoved: 0, budgetMoved: 0, parked: 0, ms: 0 }
    counts.bodiesMoved += counts.statics.nearMoved + counts.statics.budgetMoved
    const bodiesDoneAt = performance.now()
    invalidateEntityDerivedState(appRuntime)
    const invalidatedAt = performance.now()
    reseatSpatialIndexes(appRuntime)
    const reseatedAt = performance.now()
    counts.notified = notifyChartAwareApps(appRuntime, event)
    counts.ms = { dynamicsAndData: dynamicsDoneAt - startedAt, statics: bodiesDoneAt - dynamicsDoneAt, invalidate: invalidatedAt - bodiesDoneAt, reseat: reseatedAt - invalidatedAt, notify: performance.now() - reseatedAt }
    return counts
  }
}
