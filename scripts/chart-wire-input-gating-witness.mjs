import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { resolveEpochTransfer, reexpressInputEntries, reexpressShot, chartWireStatsOf } = await import(pathToFileURL(path.join(ROOT, 'src/sdk/chartWire.js')).href)

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const CURRENT = 4
const transferred = []
const ledger = {
  current: { chartEpoch: CURRENT },
  transferToCurrent(epoch) {
    if (epoch < 2) throw new Error(`epoch ${epoch} is not retained`)
    transferred.push(epoch)
    return {
      point: (p) => p.map((c) => c + 10),
      vec: (v) => v.map((c) => c * 2),
      look: (yaw, pitch) => ({ yaw: yaw + 1, pitch }),
    }
  },
}
const ctx = { physics: { _planetFrame: { chartEpoch: CURRENT } }, chartEpochLedger: ledger }
const stats = chartWireStatsOf(ctx)
const snap = () => ({ future: stats.rejectedFuture, expired: stats.rejectedExpired, malformed: stats.rejectedMalformed })

const sameEpoch = resolveEpochTransfer(ctx, CURRENT)
check('a packet at the current epoch needs no transfer and is not rejected', sameEpoch.transfer === null && sameEpoch.rejected === null && transferred.length === 0)

const before = snap()
const stale = resolveEpochTransfer(ctx, 3)
check('a retained stale epoch resolves to a transfer to the current chart', stale.transfer !== null && stale.rejected === null && transferred.join(',') === '3', `rejected=${stale.rejected}`)
check('a retained stale epoch moves no refusal counter', JSON.stringify(snap()) === JSON.stringify(before))

const entries = [{ data: { yaw: 0.5, pitch: 0.25 } }, { data: { yaw: 1, pitch: -0.1 } }]
reexpressInputEntries(stale.transfer, entries)
const yaws = entries.map((e) => e.data.yaw)
const pitches = entries.map((e) => e.data.pitch)
check('stale input yaw is re-expressed through the transfer', Math.abs(yaws[0] - 1.5) < 1e-12 && Math.abs(yaws[1] - 2) < 1e-12, `yaw=${yaws.join(',')}`)
check('stale input pitch passes through the look transfer unchanged', Math.abs(pitches[0] - 0.25) < 1e-12 && Math.abs(pitches[1] + 0.1) < 1e-12, `pitch=${pitches.join(',')}`)

const shot = { origin: [1, 2, 3], point: [0, 0, 0], direction: [0.5, 0, 0.5], dir: [1, 1, 1], damage: 7 }
reexpressShot(stale.transfer, shot)
check('a stale shot origin and point are re-expressed as points', shot.origin.join(',') === '11,12,13' && shot.point.join(',') === '10,10,10', `origin=${shot.origin} point=${shot.point}`)
check('a stale shot direction and dir are re-expressed as vectors', shot.direction.join(',') === '1,0,1' && shot.dir.join(',') === '2,2,2', `direction=${shot.direction} dir=${shot.dir}`)
check('a non-geometry shot field is left alone', shot.damage === 7)

const futureBefore = snap()
const future = resolveEpochTransfer(ctx, CURRENT + 1)
check('a future epoch is refused with a future-chart-epoch code and no transfer', future.transfer === null && future.rejected === `future-chart-epoch:${CURRENT + 1}>${CURRENT}`, `rejected=${future.rejected}`)
check('a future epoch counts once as rejectedFuture and asks the ledger for nothing', stats.rejectedFuture === futureBefore.future + 1 && !transferred.includes(CURRENT + 1), `future=${stats.rejectedFuture}`)

const expiredBefore = snap()
const expired = resolveEpochTransfer(ctx, 1)
check('an expired epoch is refused with an expired-chart-epoch code and no transfer', expired.transfer === null && String(expired.rejected).startsWith('expired-chart-epoch:1:'), `rejected=${expired.rejected}`)
check('an expired epoch counts once as rejectedExpired and not as future', stats.rejectedExpired === expiredBefore.expired + 1 && stats.rejectedFuture === futureBefore.future + 1)

const failed = checks.filter((c) => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`)
  process.exit(1)
}
console.log('RESULT: PASS a stale input and shot are re-expressed through the epoch transfer, the current epoch needs none, and a future or expired epoch is refused with its own code and counter')
process.exit(0)
