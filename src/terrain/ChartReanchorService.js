import { createChartAnchorLattice, reanchorChartFor, CHART_ANCHORS_PER_FACE } from '../shared/chartAnchor.js'
import { chartAnchorDecision, CHART_REANCHOR_HYSTERESIS_DEG } from '../shared/chartReanchorPolicy.js'

export function createChartReanchorService({ frame, radius, playerDirs, anchorsPerFace = CHART_ANCHORS_PER_FACE, hysteresisDeg = CHART_REANCHOR_HYSTERESIS_DEG }) {
  const lattice = createChartAnchorLattice(radius, anchorsPerFace)
  if (!lattice) throw new Error(`chart reanchor needs a positive finite planet radius, got ${radius}`)
  const migrators = []
  const terrainMigrators = []
  let reanchorCount = 0, refusalCount = 0, lastRefusal = null

  function onReanchor(migrate) {
    migrators.push(migrate)
    return () => { const i = migrators.indexOf(migrate); if (i >= 0) migrators.splice(i, 1) }
  }

  function addTerrainMigrator(terrainMigrator) {
    terrainMigrators.push(terrainMigrator)
    return () => { const i = terrainMigrators.indexOf(terrainMigrator); if (i >= 0) terrainMigrators.splice(i, 1) }
  }

  function refusalOf(decision) {
    for (const { gate } of terrainMigrators) {
      const reason = gate({ decision, epoch: frame.chartEpoch })
      if (reason) return reason
    }
    return null
  }

  function step(dirs = playerDirs()) {
    if (!migrators.length) throw new Error('chart reanchor stepped with no registered state migrator: rotating the frame alone would leave every chart-local position, collider and client on the old chart')
    const decision = chartAnchorDecision({ lattice, frame, dirs, hysteresisDeg })
    if (!decision) return null
    if (decision.refusal) {
      refusalCount++
      if (lastRefusal?.reason !== decision.refusal) console.warn(`[chart-reanchor] refusing to re-anchor: ${decision.refusal}${decision.worstPlayerAngleDeg === undefined ? '' : ` (worst player ${decision.worstPlayerAngleDeg.toFixed(2)} deg from the anchor, walkable limit ${decision.walkableLimitDeg.toFixed(2)} deg)`}; players this far apart need per-cluster charts`)
      lastRefusal = { reason: decision.refusal, decision, epoch: frame.chartEpoch }
      return null
    }
    const reason = refusalOf(decision)
    if (reason) {
      refusalCount++
      lastRefusal = { reason, decision, epoch: frame.chartEpoch }
      return null
    }
    const shift = reanchorChartFor({ frame, lattice, dir: decision.centroidDir, cellTrigger: true })
    reanchorCount++
    const event = { ...shift, decision, epoch: frame.chartEpoch }
    for (const { migrate } of terrainMigrators) migrate(event)
    for (const migrate of migrators) migrate(event)
    return event
  }

  return {
    lattice, onReanchor, addTerrainMigrator, step,
    get reanchorCount() { return reanchorCount },
    get migratorCount() { return migrators.length },
    get refusalCount() { return refusalCount },
    get lastRefusal() { return lastRefusal },
  }
}
