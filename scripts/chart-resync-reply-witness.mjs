import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const href = (p) => pathToFileURL(path.join(ROOT, p)).href
const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}
const frameAt = (epoch) => ({ radius: 1000, offsetY: 0, anchorHeight: 0, chartEpoch: epoch, east: [1, 0, 0], up: [0, 1, 0], north: [0, 0, 1] })

const { createChartResyncReply, chartWireStatsOf } = await import(href('src/sdk/chartWire.js'))
const RETAINED = [2, 3, 4]
const ledger = {
  current: frameAt(4),
  chartAt(epoch) {
    if (!RETAINED.includes(epoch)) throw new Error(`epoch ${epoch} is not retained`)
    return frameAt(epoch)
  },
}
const withLedger = { physics: { _planetFrame: frameAt(4) }, chartEpochLedger: ledger, tickSystem: { currentTick: 77 } }
const withoutLedger = { physics: { _planetFrame: frameAt(4) }, tickSystem: { currentTick: 77 } }
const stats = chartWireStatsOf(withLedger)
const counts = () => ({ served: stats.resyncServed, expired: stats.resyncExpired })

const b1 = counts()
const served = createChartResyncReply(withLedger, 2)
check('a stale retained client gets the from-chart and the current chart at the current epoch', served.epoch === 4 && served.tick === 77 && served.from.e === 2 && served.to.e === 4 && served.resync === undefined, JSON.stringify({ epoch: served.epoch, from: served.from && served.from.e, to: served.to && served.to.e, resync: served.resync }))
check('a served resync counts once as resyncServed', counts().served === b1.served + 1 && counts().expired === b1.expired)

const b2 = counts()
const expired = createChartResyncReply(withLedger, 1)
check('an unretained stale client gets resync:true with the current chart and no from-chart', expired.resync === true && expired.to.e === 4 && expired.from === undefined, JSON.stringify({ resync: expired.resync, to: expired.to && expired.to.e, from: expired.from }))
check('an expired resync counts once as resyncExpired and not as served', counts().expired === b2.expired + 1 && counts().served === b2.served)

const b3 = counts()
const current = createChartResyncReply(withLedger, 4)
check('a client already at the current epoch gets the resync form with the current chart', current.resync === true && current.to.e === 4 && current.from === undefined)
check('a current-epoch resync moves no resync counter', JSON.stringify(counts()) === JSON.stringify(b3))

const b4 = counts()
const noLedger = createChartResyncReply(withoutLedger, 2)
check('with no chart ledger the reply is resync:true with the live chart', noLedger.resync === true && noLedger.to.e === 4 && noLedger.from === undefined, JSON.stringify(noLedger && { resync: noLedger.resync, to: noLedger.to && noLedger.to.e }))
check('with no chart ledger no resync counter moves', JSON.stringify(counts()) === JSON.stringify(b4))

check('with no chart at all the reply is null', createChartResyncReply({ physics: {}, tickSystem: { currentTick: 0 } }, 2) === null)

const failed = checks.filter((c) => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`)
  process.exit(1)
}
console.log('RESULT: PASS CHART_REANCHOR resync reply: a stale retained client gets the from-chart and the current chart, an unretained or expired client gets resync:true, the served and expired counters count once each, and a current-epoch or chart-less reply moves no counter')
