import { createChartEpochLedger } from '../../shared/chartEpochLedger.js'
import { createReexpressPass } from '../../shared/chartReexpress.js'
import { createPlayerMigrator } from './migratePlayers.js'
import { createEntityMigrator } from './migrateEntities.js'
import { createWorldAnchorMigrator } from './migrateWorldAnchors.js'

function reanchorBlocker(ctx) {
  if (ctx.peerSession) return 'peer-simulated-session: every peer must agree on the switch tick, and a rollback would restore pre-switch chart-local state'
  for (const player of ctx.playerManager.players.values()) if (player.teleportHold) return `teleport-hold-active:${player.id}`
  const runtime = ctx.appRuntime
  if (runtime._pendingTrimeshBuilds.size > 0) return 'static-collider-builds-pending'
  if (runtime._pendingTrimeshEntities.size > 0) return 'static-collider-entities-pending'
  if (runtime._pendingSetupIds.size > 0) return 'app-setup-in-flight'
  if (runtime._resimSuppressed) return 'resimulation-in-progress'
  return null
}

export function attachServerChartMigrators(ctx, service) {
  const frame = ctx.physics?._planetFrame
  if (!frame) throw new Error('attachServerChartMigrators needs the terrain planet frame on ctx.physics._planetFrame')
  const ledger = createChartEpochLedger({ frame })
  const migrators = [
    ['players', createPlayerMigrator(ctx)],
    ['entities', createEntityMigrator(ctx)],
    ['worldAnchors', createWorldAnchorMigrator({ ctx, stageLoader: ctx.stageLoader })],
  ]
  let appliedEpoch = ledger.currentEpoch

  function applyOnce(event) {
    if (event.epoch <= appliedEpoch) return null
    if (event.epoch !== appliedEpoch + 1) throw new Error(`server chart state is at epoch ${appliedEpoch} but was asked to apply epoch ${event.epoch}: applying it would mix chart frames`)
    const startedAt = performance.now()
    const pass = createReexpressPass(event.transfer)
    const report = { epoch: event.epoch, tiltDeg: event.transfer.tiltRad * 180 / Math.PI }
    let migrating = null
    try {
      for (const [name, migrate] of migrators) { migrating = name; report[name] = migrate(event, pass) }
    } catch (error) {
      ctx.chartReanchorFault = { epoch: event.epoch, migrator: migrating, message: error.message }
      ctx.tickSystem?.stop()
      console.error(`[chart-reanchor] FATAL: migrator '${migrating}' threw while moving to chart epoch ${event.epoch}; chart-local state is now split across two frames, so the tick loop is stopped:`, error)
      throw error
    }
    report.migrateMs = performance.now() - startedAt
    ledger.record(event.to)
    appliedEpoch = event.epoch
    ctx.lastChartReanchor = report
    ctx.eventLog?.record('chart_reanchor', report, { reason: 'chart_reanchor' })
    return report
  }

  const detachMigrator = service.onReanchor(applyOnce)
  const detachGate = service.addTerrainMigrator({ gate: () => reanchorBlocker(ctx), migrate() {} })
  ctx.chartEpochLedger = ledger
  const handle = { ledger, apply: applyOnce, get appliedEpoch() { return appliedEpoch }, get lastReport() { return ctx.lastChartReanchor }, detach() { detachMigrator(); detachGate() } }
  service.chartState = handle
  return handle
}
