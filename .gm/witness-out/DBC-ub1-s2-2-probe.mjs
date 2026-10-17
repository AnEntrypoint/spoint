import { EventChainManager } from '/home/user/spoint/src/game/EventChainManager.js'
const out = []
const check = (label, ok) => { out.push(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) process.exitCode = 1 }
const m = new EventChainManager()
for (const bad of [null, undefined, 42, 'x']) {
  let err = null
  try { m.addChain(bad) } catch (e) { err = e }
  check(`reject ${String(bad)} with TypeError [chain]`, err instanceof TypeError && /^\[chain\]/.test(err.message))
}
const spec = { name: 'A', actions: [] }
const before = JSON.stringify(spec)
const c1 = m.addChain(spec)
check('input spec not mutated (no id written)', JSON.stringify(spec) === before && !('id' in spec))
check('generated id on returned chain', typeof c1.id === 'string' && c1.id.startsWith('chain_'))
const logA = m.eventLogs.at(-1)
check('first add reports replaced:false', logA.details.replaced === false)
const c2 = m.addChain({ id: 'fixed_7', name: 'B' })
check('explicit id kept', c2.id === 'fixed_7')
const c3 = m.addChain({ id: 'fixed_7', name: 'C' })
check('same id re-add reports replaced:true', m.eventLogs.at(-1).details.replaced === true && c3.name === 'C')
check('chain count is 2 distinct ids after replace', m.getChains().length === 2)
out.push(`eventLog entries: ${m.eventLogs.length}`)
console.log(out.join('\n'))
console.log(process.exitCode ? 'RESULT: FAIL' : 'RESULT: PASS')
