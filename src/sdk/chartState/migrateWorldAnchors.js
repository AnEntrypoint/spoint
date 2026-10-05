function reexpressedPoints(transfer, points) {
  return points.map(p => transfer.point(p))
}

export function createWorldAnchorMigrator({ ctx, stageLoader }) {
  return function migrateWorldAnchors({ transfer }, pass) {
    const counts = { spawnPoints: 0, stageSpawnPoints: 0, rejoinStates: 0 }
    if (Array.isArray(ctx.worldSpawnPoints)) {
      ctx.worldSpawnPoints = reexpressedPoints(transfer, ctx.worldSpawnPoints)
      ctx.worldSpawnPoint = ctx.worldSpawnPoints[0] ?? transfer.point(ctx.worldSpawnPoint)
      counts.spawnPoints = ctx.worldSpawnPoints.length
    }
    for (const stage of stageLoader.allStages()) {
      if (!Array.isArray(stage.spawnPoint)) continue
      stage.spawnPoint = transfer.point(stage.spawnPoint)
      counts.stageSpawnPoints++
    }
    const rejoinStates = [...(ctx.pendingRejoinState?.values() ?? [])]
    if (ctx.localRejoinState) rejoinStates.push(ctx.localRejoinState)
    for (const rejoin of rejoinStates) {
      pass.point(rejoin.position)
      if (Array.isArray(rejoin.rotation)) pass.yawRotation(rejoin.rotation)
      counts.rejoinStates++
    }
    return counts
  }
}
