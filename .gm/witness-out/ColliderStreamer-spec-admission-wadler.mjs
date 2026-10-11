import { createColliderStreamer } from '../../src/terrain/ColliderStreamer.js'

const lines = []
let failing = 0
function check(name, ok, detail) {
  lines.push(`  [${ok ? 'PASS' : 'FAIL'}] ${name} -- ${detail}`)
  if (!ok) failing++
}
function attempt(spec) {
  try { const s = createColliderStreamer(spec); return { threw: false, streamer: s } }
  catch (e) { return { threw: true, err: e } }
}
function refuses(label, spec, field) {
  const r = attempt(spec)
  const msg = r.threw ? String(r.err && r.err.message) : 'no throw'
  const referenceBug = r.threw && r.err instanceof ReferenceError
  const named = r.threw && !referenceBug && msg.includes(field)
  check(`${label} is refused at the parse boundary and names "${field}"`, named, msg)
}
function admits(label, spec) {
  const r = attempt(spec)
  check(`${label} is admitted`, !r.threw, r.threw ? String(r.err && r.err.message) : 'no throw')
  return r
}

admits('an empty spec', { physics: {} })
admits('a spec that omits every numeric field', { physics: {}, getCenter: () => [0, 0] })
admits('a fully in-domain numeric spec', { physics: {}, radius: 40, cap: 1024, bodiesPerChunk: 4, byteBudget: 4096, intervalMs: 0, rebuildAt: 0.5, maxCenters: 8 })
admits('intervalMs 0', { physics: {}, intervalMs: 0 })

refuses('radius 0', { radius: 0 }, 'radius')
refuses('radius negative', { radius: -5 }, 'radius')
refuses('radius NaN', { radius: NaN }, 'radius')
refuses('cap 0', { cap: 0 }, 'cap')
refuses('cap negative', { cap: -1 }, 'cap')
refuses('bodiesPerChunk 0', { bodiesPerChunk: 0 }, 'bodiesPerChunk')
refuses('byteBudget 0', { byteBudget: 0 }, 'byteBudget')
refuses('intervalMs as a string', { intervalMs: 'fast' }, 'intervalMs')
refuses('rebuildAt NaN', { rebuildAt: NaN }, 'rebuildAt')
refuses('maxCenters 0', { maxCenters: 0 }, 'maxCenters')
refuses('maxCenters 0.5', { maxCenters: 0.5 }, 'maxCenters')

const zero = attempt({ maxCenters: 0 })
const wasTdz = zero.threw && zero.err instanceof ReferenceError
check('maxCenters 0 no longer dies on the pre-declared logTag', !wasTdz, wasTdz ? String(zero.err.message) : 'message names the field')

const d = attempt({ physics: {} })
const full = attempt({ physics: {}, radius: 40, cap: 1024, bodiesPerChunk: 4, byteBudget: 4096, intervalMs: 0, rebuildAt: 0.5, maxCenters: 8 })
check('every admitted spec is startable', !d.threw && typeof d.streamer.start === 'function' && !full.threw && typeof full.streamer.start === 'function', 'start is a function on both')

async function startOutcome(spec) {
  const r = attempt(spec)
  if (r.threw) return { threw: true, msg: String(r.err && r.err.message) }
  const p = r.streamer.start()
  p.catch(() => {})
  const settled = await Promise.race([
    p.then(() => null, (e) => e),
    new Promise((res) => setTimeout(() => res(new Error('witness timeout: start() did not settle in 2s')), 2000)),
  ])
  return { threw: settled !== null, msg: settled === null ? 'no throw' : String(settled && settled.message) }
}
async function refusesAtStart(label, spec, needle) {
  const o = await startOutcome(spec)
  check(`${label} is refused when the ring is built and names "${needle}"`, o.threw && o.msg.includes(needle), o.msg)
}

await refusesAtStart('a malformed centre pair from getCenters', { physics: {}, getCenters: () => [[0, 0], [1, NaN]] }, 'collider centre 1 of 2 from getCenters')
await refusesAtStart('a centre that is not a pair from getCenters', { physics: {}, getCenters: () => [[0, 1, 2]] }, 'collider centre 0 of 1 from getCenters')
await refusesAtStart('a non-array return from getCenters', { physics: {}, getCenters: () => 'gone' }, 'getCenters returned')
await refusesAtStart('a malformed centre from getCenter', { physics: {}, getCenter: () => [undefined, 0] }, 'collider centre from getCenter')

const wellFormed = await startOutcome({ physics: {}, getCenters: () => [[0, 0]] })
check('a well-formed centre is admitted and reaches the ring build', !wellFormed.msg.includes('collider centre'), wellFormed.msg)

console.log(lines.join('\n'))
console.log(`failing checks: ${failing}`)
console.log(`RESULT: ${failing === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failing === 0 ? 0 : 1)
