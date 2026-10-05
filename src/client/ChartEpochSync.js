import { createChartTransfer } from '../shared/chartTransfer.js'
import { createReexpressPass } from '../shared/chartReexpress.js'
import { decodeChart } from '../shared/chartWireCodec.js'

const RETAINED_CHARTS = 64
const MAX_DEFERRED_ACKS = 16
const HELD_SNAPSHOTS_BEFORE_RESYNC_REQUEST = 3
const HELD_MS_BEFORE_RESYNC_REQUEST = 250
const RESYNC_REREQUEST_MS = 500
const POINT_ACK_FIELDS = ['position', 'player']
const VECTOR_ACK_FIELDS = ['velocity']

export function createChartEpochSync({ callbacks, holders, requestResync, replayAck, now = () => performance.now() }) {
  const charts = new Map()
  const deferredAcks = []
  const stats = { applied: 0, hardResyncs: 0, heldSnapshots: 0, staleSnapshots: 0, ignoredBroadcasts: 0, resyncRequests: 0, reexpressedAcks: 0, deferredAcks: 0, adoptions: 0 }
  let epoch = null
  let chart = null
  let heldSince = 0
  let heldCount = 0
  let lastRequestAt = 0
  let missedBroadcastReported = false

  function remember(snapshot) {
    charts.set(snapshot.chartEpoch, snapshot)
    for (const e of charts.keys()) if (e < snapshot.chartEpoch - RETAINED_CHARTS) charts.delete(e)
  }

  function clearHold() { heldCount = 0; heldSince = 0; missedBroadcastReported = false }

  function adopt(payload) {
    if (!Number.isInteger(payload?.chartEpoch)) return
    adoptChart(payload.chartEpoch, payload.chart ? decodeChart(payload.chart) : null)
  }

  function adoptChart(newEpoch, newChart) {
    const changed = epoch !== newEpoch
    epoch = newEpoch
    chart = newChart
    charts.clear()
    deferredAcks.length = 0
    if (chart) remember(chart)
    clearHold()
    stats.adoptions++
    if (changed) holders().mirror?.clearTiles()
  }

  function finishApply(to) {
    epoch = to.chartEpoch
    chart = to
    remember(to)
    clearHold()
    flushDeferredAcks()
  }

  function applyTransfer(from, to, ackSeq) {
    if (!charts.has(from.chartEpoch)) remember(from)
    const transfer = createChartTransfer(from, to)
    callbacks.onChartReanchoring({ epoch: to.chartEpoch, from, to, transfer, ackSeq })
    const pass = createReexpressPass(transfer)
    const h = holders()
    h.mirror?.reexpress(transfer)
    h.pred?.applyChartTransfer(pass, ackSeq)
    h.timeline.applyChartTransfer(pass)
    h.snapProc.applyChartTransfer(pass)
    stats.applied++
    finishApply(to)
    callbacks.onChartReanchor({ epoch: to.chartEpoch, from, to, transfer, ackSeq })
    return transfer
  }

  function hardResync(to, reason) {
    const h = holders()
    h.pred?.resyncToServer({ keepHistory: false })
    h.timeline.reset()
    h.snapProc.clear()
    h.mirror?.clearTiles()
    stats.hardResyncs++
    console.error(`[chart] hard resync to chart epoch ${to.chartEpoch} from ${epoch}: ${reason}; prediction history dropped, expect one visible reposition`)
    finishApply(to)
    callbacks.onChartResync({ epoch: to.chartEpoch, to, reason })
  }

  function onBroadcast(wire) {
    if (!wire?.to) return
    const to = decodeChart(wire.to)
    const payload = { ...wire, to, from: wire.from ? decodeChart(wire.from) : undefined }
    if (epoch === null) { adoptChart(to.chartEpoch, to); return }
    if (to.chartEpoch <= epoch) { stats.ignoredBroadcasts++; return }
    if (payload.resync || !payload.from) { hardResync(to, 'server reports the chart history for this client is no longer retained'); return }
    const from = payload.from.chartEpoch === epoch ? payload.from : (chart?.chartEpoch === epoch ? chart : null)
    if (!from) {
      console.error(`[chart] broadcast ${payload.from.chartEpoch}->${to.chartEpoch} does not continue this client's chart epoch ${epoch} and the client holds no chart for it; asking the server for the chart history`)
      requestFromServer()
      return
    }
    const resyncReply = payload.ackSeq === undefined
    applyTransfer(from, to, payload.ackSeq)
    if (resyncReply) holders().pred?.resyncToServer({ keepHistory: true })
  }

  function requestFromServer() {
    const t = now()
    if (t - lastRequestAt < RESYNC_REREQUEST_MS) return
    lastRequestAt = t
    stats.resyncRequests++
    requestResync(epoch)
  }

  function admitSnapshot(payload) {
    const snapshotEpoch = payload.chartEpoch
    if (!Number.isInteger(snapshotEpoch)) return true
    if (epoch === null) { adoptChart(snapshotEpoch, null); return true }
    if (snapshotEpoch === epoch) { if (heldCount) clearHold(); return true }
    if (snapshotEpoch < epoch) { stats.staleSnapshots++; return false }
    stats.heldSnapshots++
    if (!heldCount) heldSince = now()
    heldCount++
    if (heldCount >= HELD_SNAPSHOTS_BEFORE_RESYNC_REQUEST && now() - heldSince >= HELD_MS_BEFORE_RESYNC_REQUEST) {
      if (!missedBroadcastReported) {
        missedBroadcastReported = true
        console.error(`[chart] snapshots are at chart epoch ${snapshotEpoch} but this client is at ${epoch} and the CHART_REANCHOR broadcast has not arrived after ${heldCount} snapshots (${Math.round(now() - heldSince)} ms); snapshots are withheld, requesting the chart history`)
      }
      requestFromServer()
    }
    return false
  }

  function transferFromEpoch(ackEpoch) {
    const from = charts.get(ackEpoch)
    return from && chart ? createChartTransfer(from, chart) : null
  }

  function admitAck(ack) {
    const ackEpoch = ack.chartEpoch
    if (!Number.isInteger(ackEpoch) || epoch === null || ackEpoch === epoch) return ack
    if (ackEpoch > epoch) {
      if (deferredAcks.length >= MAX_DEFERRED_ACKS) {
        deferredAcks.shift()
        console.error(`[chart] ${MAX_DEFERRED_ACKS} teleport acks are waiting for a chart broadcast that has not arrived; dropping the oldest`)
      }
      deferredAcks.push(ack)
      stats.deferredAcks++
      return null
    }
    const transfer = transferFromEpoch(ackEpoch)
    if (!transfer) { console.error(`[chart] teleport ack from chart epoch ${ackEpoch} dropped: client chart history no longer holds it (client epoch ${epoch})`); return null }
    for (const key of POINT_ACK_FIELDS) if (Array.isArray(ack[key])) ack[key] = transfer.point(ack[key])
    for (const key of VECTOR_ACK_FIELDS) if (Array.isArray(ack[key])) ack[key] = transfer.vec(ack[key])
    stats.reexpressedAcks++
    return ack
  }

  function flushDeferredAcks() {
    for (const ack of deferredAcks.splice(0)) {
      const admitted = admitAck(ack)
      if (admitted) replayAck(admitted)
    }
  }

  return { adopt, onBroadcast, admitSnapshot, admitAck, stats, get epoch() { return epoch }, get chart() { return chart }, get heldSnapshots() { return heldCount } }
}
