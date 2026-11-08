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

const { createChartWireStats, chartWireStatsOf, resolveEpochTransfer, createChartResyncReply } = await import(href('src/sdk/chartWire.js'))
const { createRelocationHandlers } = await import(href('src/sdk/Relocation.js'))
const { MSG } = await import(href('src/protocol/MessageTypes.js'))
const KEYS = ['staleInputPackets', 'staleShots', 'rejectedMalformed', 'rejectedFuture', 'rejectedExpired', 'rejectedTeleports', 'resyncServed', 'resyncExpired']
const fresh = createChartWireStats()
check('a fresh counter set has exactly the eight named counters, all zero', JSON.stringify(Object.keys(fresh).sort()) === JSON.stringify([...KEYS].sort()) && KEYS.every((k) => fresh[k] === 0))

const ledger = { current: frameAt(4), chartAt(epoch) { if (epoch !== 2) throw new Error(`epoch ${epoch} is not retained`); return frameAt(epoch) }, transferToCurrent(epoch) { if (epoch !== 3) throw new Error(`epoch ${epoch} is not retained`); return { point: (p) => p, vec: (v) => v, look: (y, p) => ({ yaw: y, pitch: p }) } } }
const ctxA = { physics: { _planetFrame: frameAt(4) }, chartEpochLedger: ledger, tickSystem: { currentTick: 1 }, connections: { send() {} } }
const s1 = chartWireStatsOf(ctxA)
check('chartWireStatsOf returns the same counter set for the same physics', chartWireStatsOf(ctxA) === s1)
const other = chartWireStatsOf({ physics: { _planetFrame: frameAt(4) } })
check('a different physics gets its own zeroed counter set', other !== s1 && other.rejectedFuture === 0 && other.resyncServed === 0)

resolveEpochTransfer(ctxA, 'x')
resolveEpochTransfer(ctxA, 9)
resolveEpochTransfer(ctxA, 1)
createChartResyncReply(ctxA, 2)
createChartResyncReply(ctxA, 0)
const handlers = createRelocationHandlers(ctxA)
handlers[MSG.TELEPORT]({ reqId: 7, op: 'to', chartEpoch: 3, x: 0, z: 0 }, 'client-1')

const seen = chartWireStatsOf(ctxA)
const expected = { staleInputPackets: 0, staleShots: 0, rejectedMalformed: 1, rejectedFuture: 1, rejectedExpired: 1, rejectedTeleports: 1, resyncServed: 1, resyncExpired: 1 }
check('a fresh read of the same physics shows every driven counter at its expected value', JSON.stringify(seen) === JSON.stringify(expected), JSON.stringify(seen))
check('rejectedTeleports rises through the real Relocation handler on a stale teleport epoch', seen.rejectedTeleports === 1)

const failed = checks.filter((c) => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`)
  process.exit(1)
}
console.log('RESULT: PASS the chart wire counters are per physics and move only on their own refusal or resync path, including through the real Relocation handler')
process.exit(0)
