import { reexpressLook } from '../shared/chartReexpress.js'
import { snapshotChart } from '../shared/chartAnchor.js'
import { encodeChart } from '../shared/chartWireCodec.js'

const POINT_FIELDS = ['origin', 'point']
const VECTOR_FIELDS = ['direction', 'dir']

export function currentChartEpoch(physics) {
  return physics?._planetFrame?.chartEpoch ?? 0
}

export function currentChartSnapshot(physics) {
  const frame = physics?._planetFrame
  return frame ? snapshotChart(frame) : null
}

export function chartHandshakeFields(ctx) {
  const chart = currentChartSnapshot(ctx.physics)
  return { chartEpoch: currentChartEpoch(ctx.physics), chart: chart ? encodeChart(chart) : null }
}

export function createChartWireStats() {
  return { staleInputPackets: 0, staleShots: 0, rejectedFuture: 0, rejectedExpired: 0, rejectedTeleports: 0, resyncServed: 0, resyncExpired: 0 }
}

const statsByPhysics = new WeakMap()

export function chartWireStatsOf(ctx) {
  let stats = statsByPhysics.get(ctx.physics)
  if (!stats) { stats = createChartWireStats(); statsByPhysics.set(ctx.physics, stats) }
  return stats
}

export function resolveEpochTransfer(ctx, epoch) {
  const current = currentChartEpoch(ctx.physics)
  if (epoch === current) return { transfer: null, rejected: null }
  const stats = chartWireStatsOf(ctx)
  if (epoch > current) { stats.rejectedFuture++; return { transfer: null, rejected: `future-chart-epoch:${epoch}>${current}` } }
  const ledger = ctx.chartEpochLedger
  if (!ledger) { stats.rejectedExpired++; return { transfer: null, rejected: `no-chart-ledger-for-epoch:${epoch}` } }
  try {
    return { transfer: ledger.transferToCurrent(epoch), rejected: null }
  } catch (error) {
    stats.rejectedExpired++
    return { transfer: null, rejected: `expired-chart-epoch:${epoch}:${error.message}` }
  }
}

export function reexpressInputEntries(transfer, entries) {
  for (const entry of entries) reexpressLook(transfer, entry.data)
}

export function reexpressShot(transfer, payload) {
  for (const key of POINT_FIELDS) if (Array.isArray(payload[key])) payload[key] = transfer.point(payload[key])
  for (const key of VECTOR_FIELDS) if (Array.isArray(payload[key])) payload[key] = transfer.vec(payload[key])
}

export function createChartReanchorMessage(event, tick, ackSeq) {
  return { epoch: event.epoch, tick, from: encodeChart(event.from), to: encodeChart(event.to), ackSeq }
}

export function createChartResyncReply(ctx, clientEpoch) {
  const ledger = ctx.chartEpochLedger
  const stats = chartWireStatsOf(ctx)
  const current = ledger ? ledger.current : currentChartSnapshot(ctx.physics)
  if (!current) return null
  const tick = ctx.tickSystem?.currentTick ?? 0
  if (ledger && clientEpoch < current.chartEpoch) {
    try {
      const from = ledger.chartAt(clientEpoch)
      stats.resyncServed++
      return { epoch: current.chartEpoch, tick, from: encodeChart(from), to: encodeChart(current) }
    } catch {
      stats.resyncExpired++
    }
  }
  return { epoch: current.chartEpoch, tick, resync: true, to: encodeChart(current) }
}

// --- hot swap ----------------------------------------------------------------------------
// An edit to this file used to be classified RELOAD: findBoundaries walked from here to the app
// root and found no acceptor, so a save cost a whole page load. No boundary ABOVE this file can
// fix that, because a re-import is a new module instance and every importer keeps reading the
// one it imported at boot. What can is this file itself: an ESM import is a LIVE binding to this
// instance's export bindings, so re-assigning them here is visible to every importer already
// holding them. Self-accepting therefore turns the cost of a save into one module fetch.
// This re-points code only. It does not rebuild state the page already built, and every export
// below is re-assigned, so nothing an importer holds is left pointing at the previous copy.
const _hotSwapchartWire = (next) => {
  currentChartEpoch = next.currentChartEpoch
  currentChartSnapshot = next.currentChartSnapshot
  chartHandshakeFields = next.chartHandshakeFields
  createChartWireStats = next.createChartWireStats
  chartWireStatsOf = next.chartWireStatsOf
  resolveEpochTransfer = next.resolveEpochTransfer
  reexpressInputEntries = next.reexpressInputEntries
  reexpressShot = next.reexpressShot
  createChartReanchorMessage = next.createChartReanchorMessage
  createChartResyncReply = next.createChartResyncReply
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapchartWire)
