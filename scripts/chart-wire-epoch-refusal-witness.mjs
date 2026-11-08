import { createChartEpochLedger } from '../src/shared/chartEpochLedger.js'
import { snapshotChart } from '../src/shared/chartAnchor.js'
import { chartWireStatsOf, resolveEpochTransfer } from '../src/sdk/chartWire.js'

const RETAINED_EPOCHS = 2
const CURRENT_EPOCH = 4
const EXPIRED_EPOCH = 1
const RETAINED_EPOCH = 3

const frame = { radius: 1000, offsetY: 0, anchorHeight: 0, chartEpoch: 0, east: [1, 0, 0], up: [0, 1, 0], north: [0, 0, 1] }
const ledger = createChartEpochLedger({ frame, retainedEpochs: RETAINED_EPOCHS })
for (let epoch = 1; epoch <= CURRENT_EPOCH; epoch++) {
  frame.chartEpoch = epoch
  ledger.record(snapshotChart(frame))
}
const ctx = { physics: { _planetFrame: frame }, chartEpochLedger: ledger }
const stats = chartWireStatsOf(ctx)

const failures = []
const expect = (label, condition, detail) => { if (!condition) failures.push(`${label}: ${detail}`) }

function snapshotCounters() {
  return { malformed: stats.rejectedMalformed, expired: stats.rejectedExpired, future: stats.rejectedFuture }
}

function resolveAndCount(label, epoch) {
  const before = snapshotCounters()
  const gate = resolveEpochTransfer(ctx, epoch)
  const after = snapshotCounters()
  return { label, gate, delta: { malformed: after.malformed - before.malformed, expired: after.expired - before.expired, future: after.future - before.future } }
}

const malformedEpochs = [
  ['non-integer 1.5', 1.5],
  ['negative -1', -1],
  ['string "2"', '2'],
  ['missing undefined', undefined],
  ['null', null],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['object {}', {}],
]

for (const [label, epoch] of malformedEpochs) {
  const { gate, delta } = resolveAndCount(label, epoch)
  expect(label, gate.transfer === null, `transfer must be null, got ${JSON.stringify(gate.transfer)}`)
  expect(label, typeof gate.rejected === 'string' && gate.rejected.startsWith('malformed-chart-epoch:'), `rejected must be a malformed-chart-epoch code, got ${JSON.stringify(gate.rejected)}`)
  expect(label, delta.malformed === 1, `rejectedMalformed must rise by 1, rose by ${delta.malformed}`)
  expect(label, delta.expired === 0, `rejectedExpired must not count a malformed epoch, rose by ${delta.expired}`)
  expect(label, delta.future === 0, `rejectedFuture must not count a malformed epoch, rose by ${delta.future}`)
}

const expired = resolveAndCount('valid expired epoch', EXPIRED_EPOCH)
expect('valid expired epoch', expired.gate.transfer === null, 'transfer must be null for a no longer retained epoch')
expect('valid expired epoch', typeof expired.gate.rejected === 'string' && expired.gate.rejected.startsWith('expired-chart-epoch:'), `rejected must be an expired-chart-epoch code, got ${JSON.stringify(expired.gate.rejected)}`)
expect('valid expired epoch', expired.delta.expired === 1, `rejectedExpired must rise by 1, rose by ${expired.delta.expired}`)
expect('valid expired epoch', expired.delta.malformed === 0, `rejectedMalformed must not count a valid epoch, rose by ${expired.delta.malformed}`)

const retained = resolveAndCount('valid retained epoch', RETAINED_EPOCH)
expect('valid retained epoch', retained.gate.transfer !== null && retained.gate.rejected === null, `must transfer, got rejected=${JSON.stringify(retained.gate.rejected)}`)
expect('valid retained epoch', retained.delta.malformed === 0 && retained.delta.expired === 0, `no refusal counter may move, moved malformed=${retained.delta.malformed} expired=${retained.delta.expired}`)

const future = resolveAndCount('future epoch', CURRENT_EPOCH + 1)
expect('future epoch', future.delta.future === 1 && future.delta.malformed === 0, `rejectedFuture must rise by 1 alone, got future=${future.delta.future} malformed=${future.delta.malformed}`)

const verdict = failures.length === 0 ? 'PASS' : 'FAIL'
for (const failure of failures) console.error(`[chart-wire-epoch-refusal] ${failure}`)
console.log(`[chart-wire-epoch-refusal] malformed epochs ${malformedEpochs.length}, expired ${EXPIRED_EPOCH}, retained ${RETAINED_EPOCH}, current ${CURRENT_EPOCH}; stats=${JSON.stringify(stats)}`)
console.log(`RESULT: ${verdict}${failures.length ? ` (${failures.length} failed expectations)` : ' every malformed epoch counts as malformed, the expired epoch still counts as expired'}`)
process.exit(verdict === 'PASS' ? 0 : 1)
