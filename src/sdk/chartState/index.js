import { createChartEpochLedger } from '../../shared/chartEpochLedger.js'
import { createReexpressPass } from '../../shared/chartReexpress.js'
import { createPlayerMigrator } from './migratePlayers.js'
import { createEntityMigrator, collectMovers } from './migrateEntities.js'
import { createWorldAnchorMigrator } from './migrateWorldAnchors.js'

const STATIC_MIGRATION_TICK_FRACTION = 0.25

function reanchorBlocker(ctx) {
  if (ctx.peerSession) return 'peer-simulated-session: every peer must agree on the switch tick, and a rollback would restore pre-switch chart-local state'
  for (const player of ctx.playerManager.players.values()) if (player.teleportHold) return `teleport-hold-active:${player.id}`
  const runtime = ctx.appRuntime
  if (runtime._pendingTrimeshBuilds.size > 0) return 'static-collider-builds-pending'
  if (runtime._pendingTrimeshEntities.size > 0) return 'static-collider-entities-pending'
  if (runtime._pendingSetupIds.size > 0) return 'app-setup-in-flight'
  if (runtime._resimSuppressed) return 'resimulation-in-progress'
  for (const reason of runtime.chartReanchorBlocks.keys()) return reason
  return null
}

export function attachServerChartMigrators(ctx, service) {
  const frame = ctx.physics?._planetFrame
  if (!frame) throw new Error('attachServerChartMigrators needs the terrain planet frame on ctx.physics._planetFrame')
  const ledger = createChartEpochLedger({ frame })
  const tickDurationMs = ctx.tickSystem.tickDuration
  const staticBudgetMs = tickDurationMs * STATIC_MIGRATION_TICK_FRACTION
  const migrators = [
    { name: 'players', migrate: createPlayerMigrator(ctx) },
    { name: 'entities', migrate: createEntityMigrator({ appRuntime: ctx.appRuntime, staticBudgetMs }) },
    { name: 'worldAnchors', migrate: createWorldAnchorMigrator({ ctx, stageLoader: ctx.stageLoader }) },
  ]
  let appliedEpoch = ledger.currentEpoch

  function stopOnFault(epoch, stage, error) {
    ctx.chartReanchorFault = { epoch, migrator: stage, message: error.message }
    ctx.tickSystem?.stop()
    console.error(`[chart-reanchor] FATAL: '${stage}' threw at chart epoch ${epoch}; chart-local state is now split across two frames, so the tick loop is stopped:`, error)
    throw error
  }

  function applyOnce(event) {
    if (event.epoch <= appliedEpoch) return null
    if (event.epoch !== appliedEpoch + 1) throw new Error(`server chart state is at epoch ${appliedEpoch} but was asked to apply epoch ${event.epoch}: applying it would mix chart frames`)
    const startedAt = performance.now()
    const pass = createReexpressPass(event.transfer)
    const report = { epoch: event.epoch, tiltDeg: event.transfer.tiltRad * 180 / Math.PI }
    let migrating = null
    try {
      report.dormantCarriedIntoSwitch = ctx.physics._dormant ? ctx.physics._dormant.pendingCount : 0
      for (const { name, migrate } of migrators) { migrating = name; report[name] = migrate(event, pass) }
    } catch (error) { stopOnFault(event.epoch, migrating, error) }
    report.migrateMs = performance.now() - startedAt
    ledger.record(event.to)
    appliedEpoch = event.epoch
    ctx.lastChartReanchor = report
    ctx.eventLog?.record('chart_reanchor', report, { reason: 'chart_reanchor' })
    return report
  }

  function drainDormantStatics() {
    const dormant = ctx.physics._dormant
    if (!dormant || dormant.pendingCount === 0) return
    try {
      const movers = collectMovers(ctx.appRuntime, [])
      dormant.drain(staticBudgetMs, movers)
    } catch (error) { stopOnFault(appliedEpoch, 'dormant-statics', error) }
  }

  ctx.physics.setChartFrameGuard({
    epoch: () => ledger.currentEpoch,
    reexpress({ epoch, position, rotation }) {
      const transfer = ledger.transferToCurrent(epoch)
      return { position: transfer.point(position), rotation: rotation ? transfer.quat(rotation) : null }
    },
  })
  ctx.tickSystem.onTick(drainDormantStatics)
  ctx.appRuntime.chartEpochLedger = ledger

  const detachMigrator = service.onReanchor(applyOnce)
  const detachGate = service.addTerrainMigrator({ gate: () => reanchorBlocker(ctx), migrate() {} })
  ctx.chartEpochLedger = ledger
  const handle = {
    ledger, apply: applyOnce, staticBudgetMs,
    get appliedEpoch() { return appliedEpoch },
    get lastReport() { return ctx.lastChartReanchor },
    get dormantStatics() { return ctx.physics._dormant?.stats ?? null },
    detach() {
      detachMigrator(); detachGate()
      const i = ctx.tickSystem.callbacks.indexOf(drainDormantStatics)
      if (i >= 0) ctx.tickSystem.callbacks.splice(i, 1)
      ctx.physics.setChartFrameGuard(null)
    },
  }
  service.chartState = handle
  return handle
}
