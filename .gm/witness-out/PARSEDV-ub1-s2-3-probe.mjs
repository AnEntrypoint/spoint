import { defineStatsSystem } from '/workspace/spoint/src/game/StatsSystem.js'
import { EventChainManager } from '/workspace/spoint/src/game/EventChainManager.js'

const stats = defineStatsSystem({}, {})
const pid = 1
const stat = Object.keys(stats.getStats(pid)).find((k) => k !== 'level' && k !== 'xp')
const ecm = new EventChainManager()
const out = { statsStat: stat ?? null }
const refuse = (name, fn) => {
  const r = fn()
  out[name] = r
}
const pick = (r) => (r && typeof r === 'object' ? r.reason : r)

out.addXP = { wrapper: stats.addXP(pid, -1), result: stats.addXPResult(pid, -1) }
out.applyBonus = {
  unknownStat: { wrapper: stats.applyBonus(pid, 'noSuchStat', 1), result: stats.applyBonusResult(pid, 'noSuchStat', 1) },
  invalidAmount: { wrapper: stats.applyBonus(pid, stat, Number.NaN), result: stats.applyBonusResult(pid, stat, Number.NaN) },
  zeroAmount: { wrapper: stats.applyBonus(pid, stat, 0), result: stats.applyBonusResult(pid, stat, 0) },
}
out.equipItem = { wrapper: stats.equipItem(pid, 'no-such-item'), result: stats.equipItemResult(pid, 'no-such-item') }
out.saveLoadout = { wrapper: stats.saveLoadout(pid, '   '), result: stats.saveLoadoutResult(pid, '   ') }
out.loadLoadout = { wrapper: stats.loadLoadout(pid, 'missing'), result: stats.loadLoadoutResult(pid, 'missing') }

const trig = (t, ev, ctx) => ecm._matchesTriggerResult(t, ev, ctx)
const cases = {
  noTrigger: [null, 'onTimer', {}],
  typeMismatch: [{ type: 'onTimer' }, 'onCollision', {}],
  entityMismatch: [{ type: 'onCollision', entityId: 'a' }, 'onCollision', { entityId: 'b' }],
  zoneMismatch: [{ type: 'onEnterZone', zoneId: 'z1' }, 'onEnterZone', { zoneId: 'z2' }],
  targetEntityMismatch: [{ type: 'onCollision', targetEntityId: 't1' }, 'onCollision', { targetEntityId: 't2' }],
  timerMismatch: [{ type: 'onTimer', timerId: 'k1' }, 'onTimer', { timerId: 'k2' }],
}
out.eventChain = {}
for (const [name, [t, ev, c]] of Object.entries(cases)) {
  const r = trig(t, ev, c)
  out.eventChain[name] = { wrapper: ecm._matchesTrigger(t, ev, c), result: r }
}
out.eventChainMatchControl = ecm._matchesTrigger({ type: 'onTimer', timerId: 'k' }, 'onTimer', { timerId: 'k' })
void refuse; void pick
console.log(JSON.stringify(out, null, 2))
const reasons = [
  out.addXP.result.reason,
  out.applyBonus.unknownStat.result.reason,
  out.applyBonus.invalidAmount.result.reason,
  out.applyBonus.zeroAmount.result.reason,
  out.equipItem.result.reason,
  out.saveLoadout.result.reason,
  out.loadLoadout.result.reason,
  ...Object.values(out.eventChain).map((x) => x.result.reason),
]
const wrappersFalse = [
  out.addXP.wrapper, out.applyBonus.unknownStat.wrapper, out.applyBonus.invalidAmount.wrapper,
  out.applyBonus.zeroAmount.wrapper, out.equipItem.wrapper, out.saveLoadout.wrapper, out.loadLoadout.wrapper,
  ...Object.values(out.eventChain).map((x) => x.wrapper),
].every((v) => v === false)
const ok = wrappersFalse && new Set(reasons).size === reasons.length && reasons.every((r) => typeof r === 'string')
console.log(`PARSEDV-ub1-s2-3 ${ok ? 'PASS' : 'FAIL'} reasons=${reasons.length} distinct=${new Set(reasons).size} wrappersFalse=${wrappersFalse}`)
process.exit(ok ? 0 : 1)
