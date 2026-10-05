import { createPlanetFrame } from '../src/terrain/PlanetFrame.js'
import { VEG } from '../src/terrain/VegPlacement.js'
import { latticeFor } from '../src/terrain/PlacementChart.js'
import { defineFire } from '../src/behaviours/fire.js'
import { createFireLattice } from '../src/shared/fire/fireLattice.js'
import { FIRE_STATE } from '../src/shared/fire/fireKernel.js'
import { burnMaskWindow } from '../src/shared/fire/fireStageMap.js'
import { FIRE_WIRE_TYPE } from '../src/shared/fire/fireWire.js'

const PLANET_RADIUS = 63600
const ROAD_HALF_WIDTH_M = 60
const TICKS_PER_STEP = 10
const REGROW_STEPS = 400
const SEED = 7

const sampler = {
  radius: PLANET_RADIUS,
  heightAt(dir) {
    return 150 * Math.sin(dir[0] * 11) * Math.cos(dir[2] * 11) + 60 * Math.sin(dir[1] * 17 + dir[0] * 5)
  },
}

const frame = createPlanetFrame({ sampler, anchorDir: [0, 1, 0], offsetY: 0, reliefScale: 0.01 })
const placement = latticeFor(frame, VEG)
const lattice = createFireLattice(placement, 2)

function seaLevelAt() { return 0 }
function terrainHeightAt(x, z) { return 40 * Math.sin(x / 900) * Math.cos(z / 900) }
function terrainKindAt(x, z) { return Math.abs(z) <= ROAD_HALF_WIDTH_M ? 'road' : 'soil' }

function makeAppCtx({ players = [], heightAt = terrainHeightAt, kindAt = terrainKindAt } = {}) {
  const clock = { tick: 0 }
  const broadcasts = []
  const sends = []
  const impulses = []
  const ctx = {
    time: {
      get tick() { return clock.tick },
      get deltaTime() { return 1 / 60 },
      get elapsed() { return clock.tick / 60 },
    },
    players: {
      broadcast: m => broadcasts.push(m),
      send: (id, m) => sends.push({ id, m }),
      getAll: () => players,
    },
    world: {
      sendToEntity: (id, m) => sends.push({ id, m }),
      applyImpulse: (id, v) => impulses.push({ id, v }),
    },
    terrainHeightAt: heightAt,
    seaLevelAt,
    terrainKindAt: kindAt,
  }
  return { ctx, clock, broadcasts, sends, impulses }
}

function makeFire(spec, { players = [], heightAt, kindAt, role } = {}) {
  const rig = makeAppCtx({ players, heightAt, kindAt })
  const fire = defineFire({ ...spec, role }, rig.ctx, () => frame, () => null, () => null)
  return { ...rig, fire }
}

function runTo(rig, targetTick) {
  while (rig.clock.tick < targetTick) { rig.clock.tick++; rig.fire.tick(1 / 60) }
}

function cellLocal(face, I, J) {
  const d = lattice.cellCentreDir(face, I, J, [0, 0, 0])
  const du = d[0] * frame.up[0] + d[1] * frame.up[1] + d[2] * frame.up[2]
  const t = frame.radius + frame.anchorHeight
  return [
    (d[0] * frame.east[0] + d[1] * frame.east[1] + d[2] * frame.east[2]) / du * t,
    (d[0] * frame.north[0] + d[1] * frame.north[1] + d[2] * frame.north[2]) / du * t,
  ]
}

function groundAt(x, z) { return terrainHeightAt(x, z) }

const out = []
const say = (...parts) => { const line = parts.join(' '); out.push(line); console.log(line) }

say('== fire headless witness ==')
say(`planet radius ${PLANET_RADIUS} m, fire cell ${lattice.cellM.toFixed(2)} m, cells per face ${lattice.cellsPerFace}, faces ${lattice.faceCount}`)

const HOME_FACE = 2
const HOME_I = Math.floor(lattice.cellsPerFace / 2)
const HOME_J = Math.floor(lattice.cellsPerFace / 2)

const baseSpec = {
  stepTicks: TICKS_PER_STEP,
  regrowSteps: REGROW_STEPS,
  seed: SEED,
  leadTicks: 6,
  checksumEverySteps: 5,
  gameplay: { damageEveryTicks: 15 },
}

say('')
say('== 1. lattice and neighbour contiguity ==')
{
  let checked = 0, crossed = 0
  const a = { face: 0, I: 0, J: 0 }
  const edges = [0, 1, lattice.cellsPerFace - 2, lattice.cellsPerFace - 1]
  for (let f = 0; f < lattice.faceCount; f++) {
    for (const I of edges) {
      for (const J of edges) {
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
          lattice.walk(f, I, J, di, dj, a)
          if (a.face !== f) crossed++
          checked++
        }
      }
    }
  }
  say(`walked ${checked} steps across cube-face boundaries, ${crossed} landed on another face, none threw`)
  const trunkId = 123456789
  const c = lattice.cellOfPlacementId(trunkId, { face: 0, I: 0, J: 0 })
  say(`trunk ${trunkId} -> fire cell face ${c.face} I ${c.I} J ${c.J} (integer arithmetic, no float)`)
}

say('')
say('== 2. authority determinism and authority/mirror parity over the wire ==')
{
  const spec = { ...baseSpec, wind: [3, 0, 1] }
  const mk = () => makeFire(spec, { role: 'authority' })
  const runA = mk()
  const runB = mk()
  runA.fire.igniteCell(HOME_FACE, HOME_I, HOME_J, 3)
  runB.fire.igniteCell(HOME_FACE, HOME_I, HOME_J, 3)
  const mirrorRig = makeFire({ ...spec, role: 'mirror' })
  let mismatches = 0, compared = 0, wireEvents = 0, wireBytes = 0
  for (let block = 1; block <= 60; block++) {
    const target = block * TICKS_PER_STEP * 4
    runTo(runA, target)
    runTo(runB, target)
    for (const m of runA.broadcasts.splice(0)) {
      if (m.e) { wireEvents += m.e.length; wireBytes += JSON.stringify(m).length; mirrorRig.fire.applyRemote({ type: FIRE_WIRE_TYPE, e: m.e }) }
      else if (m.c) mirrorRig.fire.applyRemote(m)
    }
    runTo(mirrorRig, target)
    compared++
    if (runA.fire.checksum() !== runB.fire.checksum()) mismatches++
    if (runA.fire.checksum() !== mirrorRig.fire.checksum()) mismatches++
  }
  say(`two independent authorities: ${compared} comparisons, ${mismatches} mismatches`)
  say(`authority fire checksum ${runA.fire.checksum()}, mirror checksum ${mirrorRig.fire.checksum()}`)
  say(`wire: ${wireEvents} event rows, ${wireBytes} B of JSON, active cells ${runA.fire.activeCount}, tiles ${runA.fire.world.kernel.tileCount}, ignitions ${runA.fire.stats.ignitions}`)
  say(`mirror timeline stats ${JSON.stringify(mirrorRig.fire.world.timeline.stats)}`)
}

say('')
say('== 3. rain extinguishes and moisture raises the ignition threshold ==')
{
  const spec = { ...baseSpec }
  const dry = makeFire(spec, {})
  dry.fire.igniteCell(HOME_FACE, HOME_I, HOME_J, 1)
  runTo(dry, 120 * TICKS_PER_STEP)
  const dryIgnitions = dry.fire.stats.ignitions

  const table = []
  for (const rain of [0, 60, 120, 200, 255]) {
    const run = makeFire(spec, {})
    if (rain !== 0) run.fire.setRain(rain)
    run.fire.igniteCell(HOME_FACE, HOME_I, HOME_J, 1)
    runTo(run, 120 * TICKS_PER_STEP)
    table.push(`rain ${String(rain).padStart(3)}: ${String(run.fire.stats.ignitions).padStart(6)} ignitions, ${String(run.fire.activeCount).padStart(5)} burning`)
  }
  say(`clear baseline over 120 steps: ${dryIgnitions} ignitions`)
  for (const row of table) say('  ' + row)

  const moist = makeFire(spec, {})
  moist.fire.setMoisture(200)
  moist.fire.igniteCell(HOME_FACE, HOME_I, HOME_J, 1)
  runTo(moist, 120 * TICKS_PER_STEP)
  say(`moisture 200 over 120 steps: ${moist.fire.stats.ignitions} ignitions vs ${dryIgnitions} dry (threshold lifted)`)
}

say('')
say('== 4. firebreaks: road, water and cleared discs never ignite ==')
{
  const dryHeightAt = (x, z) => 40 * Math.sin(x / 900) * Math.cos(z / 900) + 50
  const spec = { ...baseSpec, firebreaks: { kinds: ['road', 'river'], water: true, cleared: [] } }
  const rig = makeFire(spec, { heightAt: dryHeightAt })
  const probe = { face: 0, I: 0, J: 0 }
  const transect = []
  for (let d = -40; d <= 40; d += 2) {
    lattice.walk(HOME_FACE, HOME_I + d, HOME_J, 0, 0, probe)
    const [x, z] = cellLocal(probe.face, probe.I, probe.J)
    transect.push({ face: probe.face, I: probe.I, J: probe.J, x, z })
  }
  const zs = transect.map(t => t.z)
  const isBreak = t => terrainKindAt(t.x, t.z) === 'road' || dryHeightAt(t.x, t.z) < seaLevelAt(t.x, t.z)
  say(`transect of ${transect.length} cells along +I, chart-local z ${Math.min(...zs).toFixed(0)}..${Math.max(...zs).toFixed(0)} m, road band |z| <= ${ROAD_HALF_WIDTH_M} m`)
  rig.fire.igniteCell(HOME_FACE, HOME_I - 40, HOME_J, 1)
  runTo(rig, 260 * TICKS_PER_STEP)
  const k = rig.fire.world.kernel
  let breakCells = 0, fuelCells = 0, burntBreak = 0, burntFuel = 0
  for (const t of transect) {
    const burnt = k.stateCodeAt(t.face, t.I, t.J) !== FIRE_STATE.UNBURNT
    if (isBreak(t)) { breakCells++; if (burnt) burntBreak++ } else { fuelCells++; if (burnt) burntFuel++ }
  }
  say(`${breakCells} firebreak cells (road or below sea level), ${fuelCells} open fuel cells`)
  say(`after the front crossed the road: ${burntBreak} firebreak cells burnt, ${burntFuel}/${fuelCells} open cells burnt`)
  say(`whole run: ${rig.fire.stats.ignitions} ignitions, ${rig.fire.activeCount} active`)
}

say('')
say('== 5. explosion, incendiary hit and extinguish on the wire ==')
{
  const players = [{ id: 1, state: { position: [0, 0, 0], health: 100, velocity: [0, 0, 0] } }]
  const targets = () => players.map(p => ({ id: p.id, position: p.state.position, holder: p.state, entity: false }))
  const spec = { ...baseSpec, gameplay: { damageEveryTicks: 15, targets } }
  const rig = makeFire(spec, { players })
  const [hx, hz] = cellLocal(HOME_FACE, HOME_I, HOME_J)
  players[0].state.position = [hx, groundAt(hx, hz) + 1, hz]
  rig.fire.igniteCell(HOME_FACE, HOME_I, HOME_J, 1)
  runTo(rig, 30 * TICKS_PER_STEP)
  runTo(rig, rig.clock.tick + 1)
  rig.broadcasts.length = 0
  const blastAt = [hx + 20, groundAt(hx, hz) + 1, hz]
  rig.fire.explode(blastAt, { radiusM: 40, igniteRadiusM: 12, damage: 60, source: 9 })
  runTo(rig, rig.clock.tick + 1)
  const blastRows = rig.broadcasts.filter(m => m.e).flatMap(m => m.e)
  const blastBytes = JSON.stringify({ type: FIRE_WIRE_TYPE, e: blastRows }).length
  say(`explode emitted ${blastRows.length} row(s): ${JSON.stringify(blastRows)} = ${blastBytes} B`)
  rig.broadcasts.length = 0
  const hit = rig.fire.incendiaryHit({ radiusM: 0 })
  hit(rig.ctx, { position: blastAt, shooterId: 5 })
  runTo(rig, rig.clock.tick + 1)
  const incendRows = rig.broadcasts.filter(m => m.e).flatMap(m => m.e)
  say(`incendiaryHit emitted ${JSON.stringify(incendRows)} = ${JSON.stringify({ type: FIRE_WIRE_TYPE, e: incendRows }).length} B`)
  runTo(rig, 18 * TICKS_PER_STEP)
  say(`player inside the fire at step 18: health ${players[0].state.health}, burning=${rig.fire.isBurning(1)}, velocity ${players[0].state.velocity.map(v => v.toFixed(2)).join(',')}`)
  runTo(rig, 90 * TICKS_PER_STEP)
  say(`player at step 90: health ${players[0].state.health}, burning=${rig.fire.isBurning(1)}`)
  rig.broadcasts.length = 0
  rig.fire.extinguish(blastAt, 40)
  runTo(rig, rig.clock.tick + 1)
  const extRows = rig.broadcasts.filter(m => m.e).flatMap(m => m.e)
  say(`extinguish emitted ${JSON.stringify(extRows)}`)
  const before = rig.fire.activeCount
  runTo(rig, rig.clock.tick + 20 * TICKS_PER_STEP)
  say(`active cells ${before} -> ${rig.fire.activeCount} after the extinguish event`)
}

say('')
say('== 6. smoke: a flat shot is absorbed, a steep shot over the plume passes ==')
{
  const spec = { ...baseSpec, gameplay: { damageEveryTicks: 15, smokeBlockDepth: 1, smokeHeightM: 30, eyeHeightM: 1.6 } }
  const rig = makeFire(spec, {})
  rig.fire.igniteCell(HOME_FACE, HOME_I, HOME_J, 1)
  runTo(rig, 14 * TICKS_PER_STEP)
  const [ox, oz] = cellLocal(HOME_FACE, HOME_I - 30, HOME_J)
  const oy = groundAt(ox, oz) + 1.6
  const [tx, tz] = cellLocal(HOME_FACE, HOME_I + 30, HOME_J)
  const ty = groundAt(tx, tz) + 1.6
  const dx = tx - ox, dz = tz - oz
  const flat = Math.hypot(dx, dz)
  say(`young fire after 14 steps: ${rig.fire.activeCount} active cells, shooter outside it firing ${flat.toFixed(0)} m at chart-local ${ox.toFixed(0)},${oz.toFixed(0)}`)
  const results = []
  for (const climb of [0, 0.05, 0.1, 0.2, 0.4]) {
    const len = Math.hypot(dx, climb * flat, dz)
    const dir = [dx / len, climb * flat / len, dz / len]
    const depth = rig.fire.smokeDepth([ox, oy, oz], dir, flat)
    results.push(`slope ${String(climb).padEnd(4)}: depth ${depth.toFixed(2)} blocked=${rig.fire.rayBlocked([ox, oy, oz], dir, flat)}`)
  }
  for (const r of results) say('  ' + r)
  const t0 = process.hrtime.bigint()
  const dir = [dx / flat, 0, dz / flat]
  for (let i = 0; i < 1000; i++) rig.fire.smokeDepth([ox, oy, oz], dir, flat)
  const perRayNs = Number(process.hrtime.bigint() - t0) / 1000
  say(`1000 busy rays at ${perRayNs.toFixed(0)} ns/ray`)
  const quiet = makeFire(spec, {})
  const t1 = process.hrtime.bigint()
  for (let i = 0; i < 1000; i++) quiet.fire.smokeDepth([ox, oy, oz], dir, flat)
  say(`1000 quiet rays at ${(Number(process.hrtime.bigint() - t1) / 1000).toFixed(0)} ns/ray`)
  let best = Infinity
  for (let batch = 0; batch < 5; batch++) {
    const s = process.hrtime.bigint()
    for (let i = 0; i < 1000; i++) rig.fire.smokeDepth([ox, oy, oz], dir, flat)
    const ns = Number(process.hrtime.bigint() - s) / 1000
    if (ns < best) best = ns
  }
  say(`busy rays min of 5 batches of 1000: ${best.toFixed(0)} ns/ray over ${flat.toFixed(0)} m (host CPU shared with other lanes)`)
}

say('')
say('== 7. stage map: tile-granular upload and trunk slot values ==')
{
  const spec = { ...baseSpec }
  const rig = makeFire(spec, {})
  const stage = rig.fire.stageMap({ slotsAcross: 16, slotsDown: 16 })
  const watched = []
  for (let dj = -6; dj <= 6; dj++) for (let di = -6; di <= 6; di++) {
    const p = lattice.walk(HOME_FACE, HOME_I + di, HOME_J + dj, 0, 0, { face: 0, I: 0, J: 0 })
    stage.acquire(p.face, p.I >> 3, p.J >> 3)
    watched.push([p.face, p.I, p.J])
  }
  say(`watching ${stage.watchedTiles} tiles (${watched.length} cells) in a ${stage.width}x${stage.height} RGBA stage texture`)
  rig.fire.igniteCell(HOME_FACE, HOME_I, HOME_J, 1)
  let peakTiles = 0, peakBytes = 0, totalBytes = 0, steps = 0
  const idleStart = process.hrtime.bigint()
  stage.sync()
  const idleUs = Number(process.hrtime.bigint() - idleStart) / 1000
  runTo(rig, 12 * TICKS_PER_STEP)
  stage.sync()
  const youngMask = new Uint8Array(128 * 128)
  const youngLit = burnMaskWindow(rig.fire.world.kernel, HOME_FACE, HOME_I - 64, HOME_J - 64, 128, 128, youngMask)
  say(`burn mask 128x128 after 12 steps: ${youngLit} of ${youngMask.length} cells lit`)
  for (let block = 1; block <= 80; block++) {
    runTo(rig, block * TICKS_PER_STEP * 3)
    const changed = stage.sync()
    steps++
    totalBytes += changed * 256
    if (changed > peakTiles) peakTiles = changed
    if (changed * 256 > peakBytes) peakBytes = changed * 256
  }
  say(`${steps} syncs: mean ${(totalBytes / steps / 1024).toFixed(1)} KiB per step, peak ${peakTiles} tiles ${peakBytes} B, no-change sync ${idleUs.toFixed(0)} us`)
  say(`stage stats ${JSON.stringify(stage.stats)}`)
  const trunkId = (HOME_FACE * placement.cellsPerFace + HOME_I * 2) * placement.cellsPerFace + HOME_J * 2
  const cell = lattice.cellOfPlacementId(trunkId, { face: 0, I: 0, J: 0 })
  const slotValue = stage.slotValueOfTrunk(trunkId)
  const texel = stage.texelOf(slotValue, { x: 0, y: 0 })
  say(`trunk ${trunkId} -> cell face ${cell.face} I ${cell.I} J ${cell.J} -> slot value ${slotValue} -> texel ${texel.x},${texel.y}`)
}

say('')
say('== 8. charred trunks lose their colliders and get them back after regrowth ==')
{
  const spec = { ...baseSpec, regrowSteps: 120 }
  const trunkIds = []
  const seen = new Set()
  for (let dj = -10; dj <= 10; dj++) for (let di = -10; di <= 10; di++) {
    const p = lattice.walk(HOME_FACE, HOME_I + di, HOME_J + dj, 0, 0, { face: 0, I: 0, J: 0 })
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) {
      const id = (p.face * placement.cellsPerFace + p.I * 2 + a) * placement.cellsPerFace + p.J * 2 + b
      if (seen.has(id)) continue
      seen.add(id); trunkIds.push(id)
    }
  }
  let excludeFn = null
  const live = new Set(trunkIds)
  const probe = {
    sweeps: 0,
    refreshes: 0,
    setExclude(fn) { excludeFn = fn },
    sweepExcluded() { this.sweeps++; for (const id of [...live]) if (excludeFn(id)) live.delete(id) },
    refresh() { this.refreshes++; for (const id of trunkIds) if (!excludeFn(id)) live.add(id) },
  }
  const rig = makeAppCtx({})
  const fire = defineFire(spec, rig.ctx, () => frame, () => null, () => probe)
  const trunkRig = { ...rig, fire }
  fire.igniteCell(HOME_FACE, HOME_I, HOME_J, 1)
  const startLive = live.size
  runTo(trunkRig, 80 * TICKS_PER_STEP)
  const charredNow = trunkIds.filter(id => fire.isTrunkCharred(id)).length
  const midLive = live.size
  runTo(trunkRig, 400 * TICKS_PER_STEP)
  const charredLater = trunkIds.filter(id => fire.isTrunkCharred(id)).length
  const endLive = live.size
  say(`${trunkIds.length} tracked trunks: live colliders ${startLive} -> ${midLive} at ${charredNow} charred -> ${endLive} at ${charredLater} charred`)
  say(`streamer saw ${probe.sweeps} sweepExcluded and ${probe.refreshes} refresh calls; regrowSteps ${spec.regrowSteps}`)
}

say('')
say('== witness complete ==')
