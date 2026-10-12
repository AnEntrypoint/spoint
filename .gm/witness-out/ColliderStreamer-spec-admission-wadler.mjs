import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createColliderStreamer } from '../../src/terrain/ColliderStreamer.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const href = (p) => pathToFileURL(p).href

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

const published = []
function fullSpec(extra = {}) {
  return {
    physics: {},
    frame: { radius: 6371000 },
    latticeSpec: { CHUNK: 8, GRID: 4 },
    idField: 'trunkId',
    placementsFor: () => [],
    bodyArgs: () => null,
    setColliderIds: (ids) => { published.push(new Set(ids)) },
    getCenters: () => [[0, 0]],
    ...extra,
  }
}

admits('a minimal well-formed spec', fullSpec())
admits('a spec whose only centre supplier is getCenter', fullSpec({ getCenters: undefined, getCenter: () => [0, 0] }))
admits('a fully in-domain numeric spec', fullSpec({ radius: 40, cap: 1024, bodiesPerChunk: 4, byteBudget: 4096, intervalMs: 0, rebuildAt: 0.5, maxCenters: 8 }))
admits('intervalMs 0', fullSpec({ intervalMs: 0 }))

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

refuses('an empty spec', {}, 'physics')
refuses('a spec with no physics', fullSpec({ physics: undefined }), 'physics')
refuses('a spec with no frame', fullSpec({ frame: undefined }), 'frame')
refuses('a spec with no latticeSpec', fullSpec({ latticeSpec: undefined }), 'latticeSpec')
refuses('a spec with no idField', fullSpec({ idField: undefined }), 'idField')
refuses('a spec with an empty idField', fullSpec({ idField: '' }), 'idField')
refuses('a spec with no placementsFor', fullSpec({ placementsFor: undefined }), 'placementsFor')
refuses('a spec with no bodyArgs', fullSpec({ bodyArgs: undefined }), 'bodyArgs')
refuses('a spec with no setColliderIds', fullSpec({ setColliderIds: undefined }), 'setColliderIds')
refuses('a spec carrying setColliderIds as a string', fullSpec({ setColliderIds: 'trunkIds' }), 'setColliderIds')
refuses('a spec whose getCenters is not a function', fullSpec({ getCenters: 'nowhere' }), 'getCenters')
refuses('a spec with no centre supplier at all', fullSpec({ getCenters: undefined, getCenter: undefined }), 'getCenters')

const zero = attempt({ maxCenters: 0 })
const wasTdz = zero.threw && zero.err instanceof ReferenceError
check('maxCenters 0 no longer dies on the pre-declared logTag', !wasTdz, wasTdz ? String(zero.err.message) : 'message names the field')

const d = attempt(fullSpec())
const full = attempt(fullSpec({ radius: 40, cap: 1024, bodiesPerChunk: 4, byteBudget: 4096, intervalMs: 0, rebuildAt: 0.5, maxCenters: 8 }))
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

await refusesAtStart('a malformed centre pair from getCenters', fullSpec({ getCenters: () => [[0, 0], [1, NaN]] }), 'collider centre 1 of 2 from getCenters')
await refusesAtStart('a centre that is not a pair from getCenters', fullSpec({ getCenters: () => [[0, 1, 2]] }), 'collider centre 0 of 1 from getCenters')
await refusesAtStart('a non-array return from getCenters', fullSpec({ getCenters: () => 'gone' }), 'getCenters returned')
await refusesAtStart('a malformed centre from getCenter', fullSpec({ getCenters: undefined, getCenter: () => [undefined, 0] }), 'collider centre from getCenter')

// The periodic path, on a real world, a real PhysicsWorld and a real trunk streamer.
const { loadWorldModule } = await import(href(resolve(ROOT, 'src/sdk/WorldLocator.js')))
const { PhysicsWorld } = await import(href(resolve(ROOT, 'src/physics/World.js')))
const { planetSamplerOptsOf, loadPlanetSampler } = await import(href(resolve(ROOT, 'src/terrain/TerrainPhysics.js')))
const { createPlanetFrame } = await import(href(resolve(ROOT, 'src/terrain/PlanetFrame.js')))
const { createCachedAnchorField } = await import(href(resolve(ROOT, 'src/terrain/ClimateCache.js')))
const { createTrunkColliderStreamer } = await import(href(resolve(ROOT, 'src/terrain/VegPhysics.js')))

const loaded = await loadWorldModule(resolve(ROOT, 'apps/world/tps-game.js'))
const tcfg = loaded.terrain
const sampler = await loadPlanetSampler(planetSamplerOptsOf(tcfg))
const frame = createPlanetFrame({ sampler, anchorDir: tcfg.anchorDir || [0, 1, 0], offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
const anchorField = createCachedAnchorField(sampler.anchorField, frame)
const physics = new PhysicsWorld({ gravity: [0, -18, 0] })
await physics.init()
const drain = () => { if (typeof physics.drainBodyQueue === 'function') physics.drainBodyQueue() }

const realError = console.error
const capture = (into) => { console.error = (...args) => { into.push(args.map((a) => (a && a.stack ? a.stack : String(a))).join(' ')) } }

let wentBad = false
const trunk = createTrunkColliderStreamer({
  physics, getCenters: () => (wentBad ? [[0, NaN]] : [[0, 0]]), frame, anchorField,
  worldSeed: tcfg.seed | 0, intervalMs: 20, radius: 64, cap: 8, maxCenters: 1,
})
await trunk.start()
drain()
const bootRing = trunk.liveCount
check('a well-formed centre builds a real boot ring instead of dying mid-rebuild on a missing sink', bootRing > 0 && trunk.centreFault === null, `${bootRing} collider(s) resident, centreFault ${trunk.centreFault === null ? 'null' : 'set'}`)

const faultLogs = []
capture(faultLogs)
wentBad = true
await new Promise((r) => setTimeout(r, 200))
console.error = realError
const refusals = faultLogs.filter((l) => l.includes('centre supplier refused'))
check('a centre supplier that goes bad after boot reports the refusal instead of swallowing it', refusals.length >= 1, refusals.length ? refusals[0].split('\n')[0] : `no refusal in ${faultLogs.length} error line(s)`)
check('the refusal is reported once and the poll stops instead of rescheduling every interval', refusals.length === 1, `${refusals.length} refusal(s) over 200ms of a 20ms poll`)
check('the halted streamer keeps the refusal itself, so the halt is observable and not only a log line', trunk.centreFault !== null && trunk.centreFault.error instanceof TypeError, trunk.centreFault ? `${String(trunk.centreFault.error).slice(0, 160)} with ${trunk.centreFault.resident} resident` : 'centreFault is null')
check('the ring built before the supplier went bad is still resident, not torn down by the halt', bootRing > 0 && trunk.liveCount === bootRing, `${trunk.liveCount} of ${bootRing} still resident`)
trunk.stop()
drain()

let controlCentre = [0, 0]
const control = createTrunkColliderStreamer({
  physics, getCenters: () => [controlCentre], frame, anchorField,
  worldSeed: tcfg.seed | 0, intervalMs: 20, radius: 64, cap: 8, maxCenters: 1,
})
await control.start()
drain()
const controlLogs = []
capture(controlLogs)
controlCentre = [300, 0]
await new Promise((r) => setTimeout(r, 300))
console.error = realError
const followed = control.centers.length === 1 && Math.abs(control.centers[0][0] - 300) < 1
check('a well-formed supplier keeps the poll alive and follows its centre instead of halting', control.centreFault === null && controlLogs.length === 0 && followed, `centre ${JSON.stringify(control.centers)}, centreFault ${control.centreFault === null ? 'null' : 'set'}, ${controlLogs.length} error line(s)`)
control.stop()
drain()

console.log(lines.join('\n'))
console.log(`failing checks: ${failing}`)
console.log(`RESULT: ${failing === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failing === 0 ? 0 : 1)
