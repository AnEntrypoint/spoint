import { createPlanetFrame } from '../src/terrain/PlanetFrame.js'
import { VEG } from '../src/terrain/VegPlacement.js'
import { latticeFor } from '../src/terrain/PlacementChart.js'
import { createFireLattice } from '../src/shared/fire/fireLattice.js'
import { defineFire, FIRE_STATE } from '../src/behaviours/fire.js'
import { FIRE_EVENT } from '../src/shared/fire/fireKernel.js'
import { FIRE_WIRE_TYPE } from '../src/shared/fire/fireWire.js'
import { ensurePacked, pack } from '../src/protocol/msgpack.js'

const failures = []
function say(line) { console.log(line) }

const HOME_FACE = 2
const CLEARED_CENTRE_OFFSET = 300
const CLEARED_RADIUS_M = 150
const LAKE_OFFSET = 300
const LAKE_RADIUS_M = 240
const ROAD_HALF_WIDTH_M = 40

function terrainHeightAt(x, z) {
  if (Math.hypot(x + LAKE_OFFSET, z) < LAKE_RADIUS_M) return -8
  return 40 + 40 * Math.sin(x / 900) * Math.cos(z / 900)
}

function terrainKindAt(x, z) { return x > 0 && Math.abs(z) < ROAD_HALF_WIDTH_M ? 'road' : 'soil' }

const sampler = {
  radius: 63600,
  heightAt(dir) { return 150 * Math.sin(dir[0] * 11) * Math.cos(dir[2] * 11) + 60 * Math.sin(dir[1] * 17 + dir[0] * 5) },
}
const frame = createPlanetFrame({ sampler, anchorDir: [0, 1, 0], offsetY: 0, reliefScale: 0.01 })
const lattice = createFireLattice(latticeFor(frame, VEG), 2)
const HALF = Math.floor(lattice.cellsPerFace / 2)

const scratchDir = [0, 0, 0]
function localXZOf(face, I, J) {
  lattice.cellCentreDir(face, I, J, scratchDir)
  const up = frame.up, east = frame.east, north = frame.north
  const du = scratchDir[0] * up[0] + scratchDir[1] * up[1] + scratchDir[2] * up[2]
  if (!(du > 0.2)) return null
  const t = frame.radius + frame.anchorHeight
  return [
    (scratchDir[0] * east[0] + scratchDir[1] * east[1] + scratchDir[2] * east[2]) / du * t,
    (scratchDir[0] * north[0] + scratchDir[1] * north[1] + scratchDir[2] * north[2]) / du * t,
  ]
}

const HOME_XZ = localXZOf(HOME_FACE, HALF, HALF)
const homeHeight = terrainHeightAt(HOME_XZ[0], HOME_XZ[1])

function cellOfPosition(p) {
  return lattice.cellOfDir(...frame.localToDir(p[0], p[2], p[1]), { face: 0, I: 0, J: 0 })
}

function makeFire(spec, role) {
  const clock = { tick: 0 }
  const broadcasts = []
  const impulses = []
  const damage = []
  const ctx = {
    time: { get tick() { return clock.tick }, get deltaTime() { return 1 / 60 }, get elapsed() { return clock.tick / 60 } },
    players: { broadcast: m => broadcasts.push(m), send: () => {}, getAll: () => [] },
    world: { sendToEntity: (id, m) => damage.push([id, m]), applyImpulse: (id, v) => impulses.push([id, v]), query: () => [] },
    terrainHeightAt,
    seaLevelAt: () => 0,
    terrainKindAt,
  }
  const fire = defineFire({ ...spec, role }, ctx, () => frame, () => null, () => null)
  return { clock, broadcasts, impulses, damage, fire, ctx }
}

function runTo(rig, t) { while (rig.clock.tick < t) { rig.clock.tick++; rig.fire.tick(1 / 60) } }

function runSteps(rig, steps, onStep) {
  const kernel = rig.fire.world.kernel
  const first = kernel.stepIndex
  let last = first
  const limit = rig.clock.tick + steps * 400 + 400
  while (kernel.stepIndex < first + steps && rig.clock.tick < limit) {
    runTo(rig, rig.clock.tick + 1)
    if (kernel.stepIndex !== last) { last = kernel.stepIndex; onStep(last) }
  }
}

function rowsOf(rig) { return rig.broadcasts.filter(m => Array.isArray(m.e)).flatMap(m => m.e) }

function wireBytes(row) { return pack({ type: FIRE_WIRE_TYPE, e: [row] }).byteLength }

const STATE_NAMES = ['unburnt', 'burning', 'burnt']
function stateName(code) { return `${code} (${STATE_NAMES[code]})` }

function countStates(kernel, centre, radiusM, minM = 0) {
  const out = { unburnt: 0, burning: 0, burnt: 0 }
  const reach = Math.ceil(radiusM / lattice.cellM)
  const c = cellOfPosition([centre[0], 0, centre[1]])
  for (let dI = -reach; dI <= reach; dI++) {
    for (let dJ = -reach; dJ <= reach; dJ++) {
      const p = localXZOf(c.face, c.I + dI, c.J + dJ)
      if (p === null) continue
      const d = Math.hypot(p[0] - centre[0], p[1] - centre[1])
      if (d > radiusM || d < minM) continue
      out[STATE_NAMES[kernel.stateCodeAt(c.face, c.I + dI, c.J + dJ)]]++
    }
  }
  return out
}

const BASE = { stepTicks: 10, regrowSteps: 400, seed: 31, leadTicks: 6, checksumEverySteps: 5, rewind: true }

await ensurePacked

say(`cell size ${lattice.cellM} m, home cell (${HOME_FACE},${HALF},${HALF}) at local [${HOME_XZ.map(v => v.toFixed(0)).join(',')}] height ${homeHeight.toFixed(1)} m`)

say('')
say('== 1. incendiary rounds ignite through the combat hit hook ==')
const incendiary = makeFire({ ...BASE, gameplay: {} }, 'authority')
const hitPosition = [HOME_XZ[0] + 120, terrainHeightAt(HOME_XZ[0] + 120, HOME_XZ[1]), HOME_XZ[1]]
const hitHook = incendiary.fire.incendiaryHit({ radiusM: 24 })
hitHook(null, { position: hitPosition, shooterId: 7 })
runSteps(incendiary, 1, () => {})
const hitCell = cellOfPosition(hitPosition)
say(`  hit at [${hitPosition.map(v => v.toFixed(0)).join(',')}] radius 24 m -> one step later the impact cell is ${stateName(incendiary.fire.world.kernel.stateCodeAt(hitCell.face, hitCell.I, hitCell.J))}`)
runSteps(incendiary, 11, () => {})
const incendiaryKernel = incendiary.fire.world.kernel
const incendiaryRows = rowsOf(incendiary).filter(r => r[0] === FIRE_EVENT.IGNITE_AREA)
say(`  IGNITE_AREA row ${JSON.stringify(incendiaryRows[0])} (${incendiaryRows.length} row(s), ${incendiaryRows.length > 0 ? wireBytes(incendiaryRows[0]) : 0} B on the wire)`)
say(`  12 steps later: ${incendiaryKernel.activeCount} burning cells, impact cell ${stateName(incendiaryKernel.stateCodeAt(hitCell.face, hitCell.I, hitCell.J))}, checksum ${incendiary.fire.checksum()}`)
const incendiaryMirror = makeFire({ ...BASE, gameplay: {} }, 'mirror')
let incendiaryCursor = 0
for (const m of incendiary.broadcasts) incendiaryMirror.fire.applyRemote(m)
incendiaryCursor = incendiary.broadcasts.length
runTo(incendiaryMirror, incendiary.clock.tick)
say(`  mirror fed those rows: step ${incendiaryMirror.fire.world.kernel.stepIndex} checksum ${incendiaryMirror.fire.checksum()} vs authority ${incendiary.fire.checksum()}, needsResync ${incendiaryMirror.fire.needsResync}`)
if (incendiaryMirror.fire.checksum() !== incendiary.fire.checksum()) failures.push(`section 1: the mirror diverged on the incendiary rows, ${incendiaryMirror.fire.checksum()} vs authority ${incendiary.fire.checksum()}`)
if (incendiaryMirror.fire.needsResync) failures.push('section 1: the mirror that was fed every incendiary row asked for a resync')

say('')
say('== 2. an extinguisher and a water drop put the fire out, over the wire ==')
const extinguishRig = makeFire(BASE, 'authority')
const centrePosition = [HOME_XZ[0], homeHeight, HOME_XZ[1]]
extinguishRig.fire.igniteArea(centrePosition, 80, 2)
runSteps(extinguishRig, 3, () => {})
const wetKernel = extinguishRig.fire.world.kernel
const beforeExtinguish = countStates(wetKernel, HOME_XZ, 40)
const beforeRing = countStates(wetKernel, HOME_XZ, 200, 40)
const extinguishId = extinguishRig.fire.extinguish(centrePosition, 40)
runSteps(extinguishRig, 2, () => {})
const afterExtinguish = countStates(wetKernel, HOME_XZ, 40)
const afterRing = countStates(wetKernel, HOME_XZ, 200, 40)
const extinguishRows = rowsOf(extinguishRig).filter(r => r[0] === FIRE_EVENT.EXTINGUISH)
say(`  inside 40 m before: ${JSON.stringify(beforeExtinguish)} -> after: ${JSON.stringify(afterExtinguish)}`)
say(`  the ring from 40 m to 200 m kept going: ${JSON.stringify(beforeRing)} -> ${JSON.stringify(afterRing)}`)
say(`  EXTINGUISH row ${JSON.stringify(extinguishRows[0])} (${extinguishRows.length} row(s), ${extinguishRows.length > 0 ? wireBytes(extinguishRows[0]) : 0} B), event id ${extinguishId}, checksum ${extinguishRig.fire.checksum()}`)
const extinguishMirror = makeFire(BASE, 'mirror')
for (const m of extinguishRig.broadcasts) extinguishMirror.fire.applyRemote(m)
runTo(extinguishMirror, extinguishRig.clock.tick)
say(`  mirror fed those rows: checksum ${extinguishMirror.fire.checksum()} vs authority ${extinguishRig.fire.checksum()}, needsResync ${extinguishMirror.fire.needsResync}`)
if (extinguishMirror.fire.checksum() !== extinguishRig.fire.checksum()) failures.push(`section 2: the mirror diverged on the extinguish rows, ${extinguishMirror.fire.checksum()} vs authority ${extinguishRig.fire.checksum()}`)
if (extinguishMirror.fire.needsResync) failures.push('section 2: the mirror that was fed every extinguish row asked for a resync')

say('')
say('== 3. an explosion ignites, damages and pushes ==')
const blastPosition = [HOME_XZ[0] + 200, terrainHeightAt(HOME_XZ[0] + 200, HOME_XZ[1] + 60), HOME_XZ[1] + 60]
const targets = [
  { id: 'crate-1', position: [blastPosition[0] + 8, blastPosition[1], blastPosition[2]], holder: {}, entity: true },
  { id: 'player-1', position: [blastPosition[0] + 12, blastPosition[1], blastPosition[2]], holder: { health: 100, velocity: [0, 0, 0] } },
]
const blastRig = makeFire({ ...BASE, gameplay: { targets: () => targets } }, 'authority')
const explodeId = blastRig.fire.explode(blastPosition, { radiusM: 30, igniteRadiusM: 12, damage: 60, source: 3 })
const blastCell = cellOfPosition(blastPosition)
runSteps(blastRig, 1, () => {})
say(`  one step after the blast the impact cell is ${stateName(blastRig.fire.world.kernel.stateCodeAt(blastCell.face, blastCell.I, blastCell.J))}`)
runSteps(blastRig, 7, () => {})
say(`  explode 30 m damage 60 ignite 12 m -> event id ${explodeId}, ${blastRig.damage.length} damage message(s) ${JSON.stringify(blastRig.damage.slice(0, 2))}`)
say(`  impulses applied: ${blastRig.impulses.length} ${JSON.stringify(blastRig.impulses.slice(0, 1))}`)
say(`  player health ${targets[1].holder.health} of 100, velocity [${targets[1].holder.velocity.map(v => v.toFixed(2)).join(',')}]`)
const blastKernel = blastRig.fire.world.kernel
say(`  state at the blast cell ${stateName(blastKernel.stateCodeAt(blastCell.face, blastCell.I, blastCell.J))}, burning cells ${blastKernel.activeCount}`)

say('')
say('== 4. firebreak cells never ignite: cleared ground, roads and water ==')
const breakSpec = {
  ...BASE,
  firebreaks: { cleared: [{ center: [HOME_XZ[0] + CLEARED_CENTRE_OFFSET, HOME_XZ[1]], radiusM: CLEARED_RADIUS_M }], kinds: ['road', 'river'], water: true },
}
const breakRig = makeFire(breakSpec, 'authority')
breakRig.fire.igniteCell(HOME_FACE, HALF, HALF, 1)
runSteps(breakRig, 90, () => {})
const breakKernel = breakRig.fire.world.kernel
let breakCells = 0, breakIgnited = 0, openCells = 0, openIgnited = 0
for (let dI = -80; dI <= 80; dI++) {
  for (let dJ = -80; dJ <= 80; dJ++) {
    const p = localXZOf(HOME_FACE, HALF + dI, HALF + dJ)
    if (p === null) continue
    const cleared = Math.hypot(p[0] - (HOME_XZ[0] + CLEARED_CENTRE_OFFSET), p[1] - HOME_XZ[1]) <= CLEARED_RADIUS_M
    const road = terrainKindAt(p[0], p[1]) === 'road'
    const water = terrainHeightAt(p[0], p[1]) < 0
    const state = breakKernel.stateCodeAt(HOME_FACE, HALF + dI, HALF + dJ)
    if (cleared || road || water) { breakCells++; if (state !== FIRE_STATE.UNBURNT) breakIgnited++ }
    else { openCells++; if (state !== FIRE_STATE.UNBURNT) openIgnited++ }
  }
}
say(`  ${breakKernel.stats.steps} steps, ${breakKernel.activeCount} burning cells, ${breakKernel.scarCount} scarred cells`)
say(`  sampled ${breakCells} firebreak cell(s) (cleared circle, road, lake): ${breakIgnited} of them ever ignited`)
say(`  sampled ${openCells} open cell(s) beside them: ${openIgnited} ignited, so the front did reach the breaks`)
if (breakCells === 0) failures.push('section 4: no firebreak cell was sampled')
if (openIgnited === 0) failures.push(`section 4: none of the ${openCells} open cell(s) ignited, so the firebreak check observed nothing`)
if (breakIgnited > 0) failures.push(`section 4: ${breakIgnited} of ${breakCells} firebreak cell(s) ignited`)

say('')
say('== 5. tps-game ships the fire integration behind a flag that is off ==')
const worldModule = await import('../apps/world/tps-game.js')
const defaultWorld = worldModule.default
const tpsEntry = defaultWorld.entities.find(e => e.app === 'tps-game')
say(`  defaultWorld tps-game config ${JSON.stringify(tpsEntry.config)}`)
const { tpsGameServer } = await import('../apps/tps-game/server-app.js')
function flagRun(cfg) {
  const calls = []
  const ctx = {
    config: cfg,
    state: {},
    time: { tick: 0 },
    players: { broadcast: () => {}, send: () => {}, getAll: () => [], playAnimation: () => {} },
    world: { query: () => [], sendToEntity: () => {}, applyImpulse: () => {} },
    defineCombat: () => ({ tick: () => {}, setup: async () => {}, flush: async () => {}, handle: () => {} }),
    defineFire: spec => { calls.push(spec); return { tick: () => {}, rayBlocked: () => false, ignite: () => 0 } },
    onShutdown: () => {},
    terrainHeightAt,
    seaLevelAt: () => 0,
    terrainKindAt,
  }
  tpsGameServer.update(ctx, 1 / 60)
  return calls.length
}
const offCalls = flagRun({ fire: { enabled: false } })
const onCalls = flagRun({ fire: { enabled: true } })
const noConfigCalls = flagRun({})
say(`  update with config.fire.enabled false: ${offCalls} defineFire call(s)`)
say(`  update with config.fire.enabled true: ${onCalls} defineFire call(s)`)
say(`  update with no fire config at all: ${noConfigCalls} defineFire call(s)`)
if (onCalls !== 1) failures.push(`section 5: config.fire.enabled true produced ${onCalls} defineFire call(s), expected 1`)
if (offCalls !== 0) failures.push(`section 5: config.fire.enabled false produced ${offCalls} defineFire call(s), expected 0`)
if (noConfigCalls !== 0) failures.push(`section 5: no fire config produced ${noConfigCalls} defineFire call(s), expected 0`)

say('')
say('== combat witness complete ==')
if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL ${f}`)
  process.exit(1)
}
