import { createChartTransfer, snapshotChart } from './chartAnchor.js'

const DEFAULT_RETAINED_EPOCHS = 64

export function createChartEpochLedger({ frame, retainedEpochs = DEFAULT_RETAINED_EPOCHS }) {
  const charts = new Map()
  let current = snapshotChart(frame)
  const base = current
  charts.set(current.chartEpoch, current)

  function record(snapshot) {
    if (snapshot.chartEpoch !== current.chartEpoch + 1) throw new Error(`chart epoch ledger expected epoch ${current.chartEpoch + 1}, got ${snapshot.chartEpoch}: an epoch was skipped, so a chart-local value from the skipped chart can never be re-expressed`)
    current = snapshot
    charts.set(snapshot.chartEpoch, snapshot)
    const oldest = snapshot.chartEpoch - retainedEpochs
    for (const epoch of charts.keys()) if (epoch < oldest && epoch !== base.chartEpoch) charts.delete(epoch)
  }

  function chartOf(epoch) {
    const chart = charts.get(epoch)
    if (!chart) throw new Error(`chart epoch ${epoch} is no longer retained (current ${current.chartEpoch}, retained ${retainedEpochs}): a client message that old must be rejected, not guessed`)
    return chart
  }

  return {
    record,
    get currentEpoch() { return current.chartEpoch },
    get current() { return current },
    get base() { return base },
    transferToCurrent(fromEpoch) { return createChartTransfer(chartOf(fromEpoch), current) },
    transferFromCurrentTo(toEpoch) { return createChartTransfer(current, chartOf(toEpoch)) },
    transferToBase() { return createChartTransfer(current, base) },
    canonicalTransfer() { return current.chartEpoch === base.chartEpoch ? null : createChartTransfer(current, base) },
    transferFromBase() { return createChartTransfer(base, current) },
  }
}
