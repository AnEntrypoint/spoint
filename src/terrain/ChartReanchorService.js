import { createChartAnchorLattice, reanchorChartFor, CHART_ANCHORS_PER_FACE } from '../shared/chartAnchor.js'
import { chartAnchorDecision, CHART_REANCHOR_HYSTERESIS_DEG } from '../shared/chartReanchorPolicy.js'

export function createChartReanchorService({ frame, radius, playerDirs, anchorsPerFace = CHART_ANCHORS_PER_FACE, hysteresisDeg = CHART_REANCHOR_HYSTERESIS_DEG }) {
  const lattice = createChartAnchorLattice(radius, anchorsPerFace)
  if (!lattice) throw new Error(`chart reanchor needs a positive finite planet radius, got ${radius}`)
  const migrators = []
  let reanchorCount = 0

  function onReanchor(migrate) {
    migrators.push(migrate)
    return () => { const i = migrators.indexOf(migrate); if (i >= 0) migrators.splice(i, 1) }
  }

  function step(dirs = playerDirs()) {
    if (!migrators.length) throw new Error('chart reanchor stepped with no registered state migrator: rotating the frame alone would leave every chart-local position, collider and client on the old chart')
    const decision = chartAnchorDecision({ lattice, frame, dirs, hysteresisDeg })
    if (!decision) return null
    const shift = reanchorChartFor({ frame, lattice, dir: decision.centroidDir, cellTrigger: true })
    reanchorCount++
    const event = { ...shift, decision, epoch: frame.chartEpoch }
    for (const migrate of migrators) migrate(event)
    return event
  }

  return { lattice, onReanchor, step, get reanchorCount() { return reanchorCount }, get migratorCount() { return migrators.length } }
}
