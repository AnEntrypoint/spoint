import { createPlanetFrame } from '../src/terrain/PlanetFrame.js'
import { VEG } from '../src/terrain/VegPlacement.js'
import { latticeFor } from '../src/terrain/PlacementChart.js'
import { defineFire } from '../src/behaviours/fire.js'
import { createFireLattice } from '../src/shared/fire/fireLattice.js'
import { FIRE_STATE } from '../src/shared/fire/fireKernel.js'
import { burnMaskWindow } from '../src/shared/fire/fireStageMap.js'
import { FIRE_WIRE_TYPE } from '../src/shared/fire/fireWire.js'
import { createKeyframeEncoder, encodeFireKeyframe, decodeFireKeyframe, keyframeToBase64, keyframeFromBase64 } from '../src/shared/fire/fireKeyframe.js'

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
const failures = []
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
  if (compared === 0) failures.push('section 2: no authority/mirror checksum comparison was made')
  if (mismatches > 0) failures.push(`section 2: ${mismatches} mismatch(es) over ${compared} comparisons between two authorities and the mirror`)
  if (wireEvents === 0) failures.push('section 2: no fire event row reached the wire')
  if (runA.fire.stats.ignitions === 0) failures.push('section 2: the authority never ignited a cell, so the parity run observed nothing')
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
  if (breakCells === 0 || fuelCells === 0) failures.push(`section 4: transect sampled ${breakCells} firebreak cell(s) and ${fuelCells} open fuel cell(s)`)
  if (burntFuel === 0) failures.push(`section 4: the front never burnt any of the ${fuelCells} open fuel cells, so the firebreak check observed nothing`)
  if (burntBreak > 0) failures.push(`section 4: ${burntBreak} firebreak cell(s) burnt`)
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
say('== 9. rewind: a late event and repeated rollbacks replay to the straight-run checksum ==')
{
  const spec = { ...baseSpec, wind: [3, 0, 1] }
  const rewindSpec = { ...spec, rewind: true }
  const CHECK_EVERY = 40
  const HORIZON = 1200
  let seed = 12345
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }

  const straight = makeFire(spec, { role: 'authority' })
  straight.fire.igniteCell(HOME_FACE, HOME_I, HOME_J, 3)
  runTo(straight, 1)
  const ignitionMsg = straight.broadcasts.find(m => m.e && m.e.length > 0)
  const marks = []
  for (let t = CHECK_EVERY; t <= HORIZON; t += CHECK_EVERY) { runTo(straight, t); marks.push([t, straight.fire.checksum()]) }

  const late = makeFire(rewindSpec, { role: 'authority' })
  const lateStartTick = late.fire.world.timeline.startTick
  runTo(late, 30)
  const lateApply = late.fire.applyRemote(ignitionMsg)
  let lateMismatch = 0, lateCompared = 0
  for (const [t, sum] of marks) { runTo(late, t); lateCompared++; if (late.fire.checksum() !== sum) lateMismatch++ }

  const JOIN_TICK = 300
  const stale = makeFire(rewindSpec, { role: 'authority' })
  void stale.fire.world
  runTo(stale, JOIN_TICK)
  const staleApply = stale.fire.applyRemote(ignitionMsg)
  const authorityAt = t => marks.find(m => m[0] === t)[1]
  runTo(stale, JOIN_TICK + 100)
  runTo(straight, JOIN_TICK + 100)

  const rolled = makeFire(rewindSpec, { role: 'authority' })
  rolled.fire.igniteCell(HOME_FACE, HOME_I, HOME_J, 3)
  let rollbacks = 0, refused = 0, rollMismatch = 0, rollCompared = 0
  for (const [t, sum] of marks) {
    const back = Math.max(1, t - Math.floor(rnd() * 70) - 1)
    const r = rolled.fire.rewindTo(back)
    if (r.ok) { rollbacks++; rolled.clock.tick = back } else refused++
    runTo(rolled, t)
    rollCompared++
    if (rolled.fire.checksum() !== sum) rollMismatch++
  }

  say(`straight run: ${marks.length} checkpoints over ${HORIZON} ticks, final checksum ${straight.fire.checksum()}, active ${straight.fire.activeCount}`)
  say(`ignition delivered late at sim tick 30 (inside the ${rewindSpec.windowSteps ?? 4}-step window): applyRemote ${JSON.stringify(lateApply)}`)
  say(`  late run (world created at tick ${lateStartTick}): ${lateCompared} checkpoints, ${lateMismatch} mismatch(es), timeline stats ${JSON.stringify(late.fire.world.timeline.stats)}`)
  if (lateCompared === 0) failures.push('section 9: the late-event run made no checkpoint comparison')
  if (lateMismatch > 0) failures.push(`section 9: late event run diverged from the straight run on ${lateMismatch} of ${lateCompared} checkpoints`)
  say(`  ${rollbacks} rollbacks (${refused} refused, beyond window): ${rollCompared} checkpoints, ${rollMismatch} mismatch(es), timeline stats ${JSON.stringify(rolled.fire.world.timeline.stats)}`)
  if (rollCompared === 0) failures.push('section 9: the rollback run made no checkpoint comparison')
  if (rollMismatch > 0) failures.push(`section 9: rollback run diverged from the straight run on ${rollMismatch} of ${rollCompared} checkpoints`)
  say(`  a peer that joins at tick ${JOIN_TICK} is beyond the window: applyRemote ${JSON.stringify(staleApply)}, checksum at ${JOIN_TICK + 100} ${stale.fire.checksum()} vs authority ${authorityAt(JOIN_TICK + 100)}`)
}

say('')
say('== 10. the rollback hook costs nothing per tick until a fire exists ==')
{
  const spec = { ...baseSpec, rewind: true }
  const idle = makeFire(spec, {})
  const N_IDLE = 200000
  const N_BUSY = 2000
  let idleBest = Infinity
  for (let b = 0; b < 5; b++) {
    const s = process.hrtime.bigint()
    for (let i = 0; i < N_IDLE; i++) { idle.clock.tick++; idle.fire.tick(1 / 60) }
    const ns = Number(process.hrtime.bigint() - s) / N_IDLE
    if (ns < idleBest) idleBest = ns
  }
  const idleState = `simTick ${idle.fire.simTick}, active ${idle.fire.activeCount}, rewinds ${idle.fire.rollbackStats.rewinds}`
  say(`defineFire with no world: ${idleBest.toFixed(1)} ns per fire.tick over ${N_IDLE} ticks (${idleState})`)

  const busy = makeFire(spec, {})
  busy.fire.igniteCell(HOME_FACE, HOME_I, HOME_J, 3)
  runTo(busy, 40 * TICKS_PER_STEP)
  const busyChecksumAt400 = busy.fire.checksum()
  let busyBest = Infinity
  const busyActive = busy.fire.activeCount
  const busyTiles = busy.fire.world.kernel.snapshot().tileCount
  for (let b = 0; b < 5; b++) {
    const s = process.hrtime.bigint()
    for (let i = 0; i < N_BUSY; i++) { busy.clock.tick++; busy.fire.tick(1 / 60) }
    const ns = Number(process.hrtime.bigint() - s) / N_BUSY
    if (ns < busyBest) busyBest = ns
  }

  const plain = makeFire({ ...baseSpec }, {})
  plain.fire.igniteCell(HOME_FACE, HOME_I, HOME_J, 3)
  runTo(plain, 40 * TICKS_PER_STEP)
  const plainChecksumAt400 = plain.fire.checksum()
  let plainBest = Infinity
  for (let b = 0; b < 5; b++) {
    const s = process.hrtime.bigint()
    for (let i = 0; i < N_BUSY; i++) { plain.clock.tick++; plain.fire.tick(1 / 60) }
    const ns = Number(process.hrtime.bigint() - s) / N_BUSY
    if (ns < plainBest) plainBest = ns
  }
  say(`burning fire (${busyActive} active cells over ${busyTiles} tiles): ${plainBest.toFixed(1)} ns per fire.tick with no snapshots, ${busyBest.toFixed(1)} ns with a boundary snapshot every ${TICKS_PER_STEP} ticks (checksum at 400 ${plainChecksumAt400} vs ${busyChecksumAt400})`)
  const rolledBusy = makeFire(spec, {})
  rolledBusy.fire.igniteCell(HOME_FACE, HOME_I, HOME_J, 3)
  runTo(rolledBusy, 40 * TICKS_PER_STEP)
  const back = rolledBusy.clock.tick - 12
  const r = rolledBusy.fire.rewindTo(back)
  rolledBusy.clock.tick = back
  runTo(rolledBusy, back + 12)
  say(`rewound 12 ticks mid-burn at tick ${back}: ok=${r.ok}, checksum after replay ${rolledBusy.fire.checksum()} vs straight run ${busyChecksumAt400}, timeline ${JSON.stringify(rolledBusy.fire.world.timeline.stats)}`)
}

say('')
say('== 11. late join: a mirror adopts the authority keyframe, a starved mirror detects divergence and resyncs ==')
{
  const spec = { ...baseSpec, wind: [3, 0, 1], rewind: true }
  const JOIN_TICK = 300
  const SECOND_IGNITION_TICK = 340
  const HORIZON = 420
  const AFTER = 480

  const authority = makeFire(spec, { role: 'authority' })
  authority.fire.igniteCell(HOME_FACE, HOME_I, HOME_J, 3)
  runTo(authority, 150)
  const earlyKeyframe = authority.fire.keyframeMessage()
  runTo(authority, JOIN_TICK)
  const staleIgnition = authority.broadcasts.find(m => m.e && m.e.length > 0)
  const keyframe = authority.fire.keyframeMessage()
  const keyframeStaleness = JOIN_TICK - keyframe.k[0]
  const earlyStaleness = JOIN_TICK - earlyKeyframe.k[0]
  const keyframeBytes = keyframeFromBase64(keyframe.k[2]).byteLength

  let encodeBestMs = Infinity, decodeBestMs = Infinity, roundTripStable = true
  for (let b = 0; b < 5; b++) {
    let s = process.hrtime.bigint()
    const bytes = encodeFireKeyframe({ tick: JOIN_TICK, snapshot: authority.fire.world.kernel.snapshot(), log: [] })
    const text = keyframeToBase64(bytes)
    const encodeMs = Number(process.hrtime.bigint() - s) / 1e6
    if (encodeMs < encodeBestMs) encodeBestMs = encodeMs
    s = process.hrtime.bigint()
    const back = decodeFireKeyframe(keyframeFromBase64(text))
    const decodeMs = Number(process.hrtime.bigint() - s) / 1e6
    if (decodeMs < decodeBestMs) decodeBestMs = decodeMs
    if (keyframeToBase64(encodeFireKeyframe(back)) !== text) roundTripStable = false
  }

  const joiner = makeFire({ ...spec, role: 'mirror' }, { role: 'mirror' })
  joiner.clock.tick = JOIN_TICK
  const staleApply = joiner.fire.applyRemote(staleIgnition)
  const adopted = joiner.fire.applyRemote(keyframe)

  const lateJoiner = makeFire({ ...spec, role: 'mirror' }, { role: 'mirror' })
  lateJoiner.clock.tick = JOIN_TICK
  const lateAdopted = lateJoiner.fire.applyRemote(earlyKeyframe)

  const starved = makeFire({ ...spec, role: 'mirror' }, { role: 'mirror' })
  starved.clock.tick = JOIN_TICK
  starved.fire.applyRemote(keyframe)

  const tampered = makeFire({ ...spec, role: 'mirror' }, { role: 'mirror' })
  tampered.clock.tick = JOIN_TICK
  tampered.fire.applyRemote(keyframe)
  const tamperedSnapshot = tampered.fire.world.kernel.snapshot()
  let touchedCell = -1
  for (let i = 0; i < tamperedSnapshot.state.length; i++) if (tamperedSnapshot.state[i] !== 0) { touchedCell = i; break }
  tamperedSnapshot.heat[touchedCell] = (tamperedSnapshot.heat[touchedCell] + 999) & 0xffff
  tampered.fire.world.kernel.restore(tamperedSnapshot)
  const tamperedAtJoin = tampered.fire.checksum()

  let cursor = authority.broadcasts.length
  let deliveredRows = 0, deliveredChecksums = 0
  for (let t = JOIN_TICK + 1; t <= HORIZON; t++) {
    runTo(authority, t)
    if (t === SECOND_IGNITION_TICK) authority.fire.igniteCell(HOME_FACE, HOME_I + 40, HOME_J - 25, 5)
    const fresh = authority.broadcasts.slice(cursor)
    cursor = authority.broadcasts.length
    for (const m of fresh) {
      joiner.fire.applyRemote(m)
      lateJoiner.fire.applyRemote(m)
      if (m.e) deliveredRows++
      if (m.c) { deliveredChecksums++; starved.fire.applyRemote(m); tampered.fire.applyRemote(m) }
    }
    runTo(joiner, t)
    runTo(lateJoiner, t)
    runTo(starved, t)
    runTo(tampered, t)
  }
  const authorityAtHorizon = authority.fire.checksum()
  const joinerAtHorizon = joiner.fire.checksum()
  const lateJoinerAtHorizon = lateJoiner.fire.checksum()
  const atHorizon = `simTick ${lateJoiner.fire.simTick} step ${lateJoiner.fire.world.kernel.stepIndex} active ${lateJoiner.fire.world.kernel.activeCount}`
  const starvedAtHorizon = starved.fire.checksum()
  const starvedNeedsResync = starved.fire.needsResync
  const starvedDivergence = { ...starved.fire.resyncStats }
  const tamperedAtHorizon = tampered.fire.checksum()
  const tamperedNeedsResync = tampered.fire.needsResync
  const tamperedDivergence = { ...tampered.fire.resyncStats }

  const request = starved.fire.requestResync()
  void authority.fire.applyRemote(request)
  const resyncMsg = authority.broadcasts[authority.broadcasts.length - 1]
  const starvedAdopt = starved.fire.applyRemote(resyncMsg)
  void authority.fire.applyRemote(tampered.fire.requestResync())
  const tamperedResyncMsg = authority.broadcasts[authority.broadcasts.length - 1]
  const tamperedAdopt = tampered.fire.applyRemote(tamperedResyncMsg)

  let cursor2 = authority.broadcasts.length
  for (let t = HORIZON + 1; t <= AFTER; t++) {
    runTo(authority, t)
    const fresh = authority.broadcasts.slice(cursor2)
    cursor2 = authority.broadcasts.length
    for (const m of fresh) { joiner.fire.applyRemote(m); lateJoiner.fire.applyRemote(m); starved.fire.applyRemote(m); tampered.fire.applyRemote(m) }
    runTo(joiner, t)
    runTo(lateJoiner, t)
    runTo(starved, t)
    runTo(tampered, t)
  }

  const corrupt = keyframe.k[2].slice(0, 40) + (keyframe.k[2][40] === 'A' ? 'B' : 'A') + keyframe.k[2].slice(41)
  let corruptError = 'accepted'
  try { decodeFireKeyframe(keyframeFromBase64(corrupt)) } catch (err) { corruptError = err.message }
  let shortError = 'accepted'
  try { decodeFireKeyframe(new Uint8Array(8)) } catch (err) { shortError = err.message }
  let wrongTypeError = 'accepted'
  try { decodeFireKeyframe(keyframe.k[2]) } catch (err) { wrongTypeError = err.message }

  const sizes = []
  for (const horizon of [300, 1000, 3000, 6000]) {
    const host = makeFire(spec, { role: 'authority' })
    host.fire.igniteCell(HOME_FACE, HOME_I, HOME_J, 3)
    runTo(host, horizon)
    const kernel = host.fire.world.kernel
    const snapshot = kernel.snapshot()
    let bytes = null, encodeMs = Infinity, slices = 0, firstSliceMs = 0, worstSliceMs = Infinity
    for (let b = 0; b < 3; b++) {
      const encodeStart = process.hrtime.bigint()
      const oneShot = createKeyframeEncoder({ tick: horizon, snapshot, logOf: () => [] }).finish()
      const ms = Number(process.hrtime.bigint() - encodeStart) / 1e6
      if (ms < encodeMs) { encodeMs = ms; bytes = oneShot }
      const sliced = createKeyframeEncoder({ tick: horizon, snapshot, logOf: () => [] })
      let n = 0, first = 0, worst = 0
      while (!sliced.done) {
        const s = process.hrtime.bigint()
        sliced.advance(1)
        const sliceMs = Number(process.hrtime.bigint() - s) / 1e6
        if (n === 0) first = sliceMs
        else if (sliceMs > worst) worst = sliceMs
        n++
      }
      if (worst < worstSliceMs) { worstSliceMs = worst; firstSliceMs = first; slices = n }
    }
    const servedStart = process.hrtime.bigint()
    const served = host.fire.keyframeMessage()
    const serveMs = Number(process.hrtime.bigint() - servedStart) / 1e6
    const cachedStart = process.hrtime.bigint()
    host.fire.keyframeMessage()
    const cachedMs = Number(process.hrtime.bigint() - cachedStart) / 1e6
    const kf = { type: FIRE_WIRE_TYPE, k: [horizon, host.fire.checksum(), keyframeToBase64(bytes)] }
    const mirror = makeFire({ ...spec, role: 'mirror' }, { role: 'mirror' })
    mirror.clock.tick = horizon
    let adoptBestMs = Infinity
    let matched = true
    for (let b = 0; b < 3; b++) {
      const s = process.hrtime.bigint()
      const r = mirror.fire.applyRemote(kf)
      const ms = Number(process.hrtime.bigint() - s) / 1e6
      if (ms < adoptBestMs) adoptBestMs = ms
      if (r.adopted.hash !== kf.k[1]) matched = false
    }
    sizes.push({
      tick: horizon, tiles: kernel.tileCount, scars: kernel.scarCount, active: kernel.activeCount,
      bytes: bytes.byteLength, encodeMs: Number(encodeMs.toFixed(2)), slices, firstSliceMs: Number(firstSliceMs.toFixed(2)), worstSliceMs: Number(worstSliceMs.toFixed(2)),
      servedTick: served === null ? null : served.k[0], serveMs: Number(serveMs.toFixed(2)), cachedMs: Number(cachedMs.toFixed(3)),
      adoptMs: Number(adoptBestMs.toFixed(2)), matched,
    })
  }

  const tickCosts = []
  for (const sliceMs of [1, 20]) {
    const host = makeFire({ ...spec, keyframeSliceMs: sliceMs }, { role: 'authority' })
    host.fire.igniteCell(HOME_FACE, HOME_I, HOME_J, 3)
    runTo(host, 3000)
    const kernel = host.fire.world.kernel
    const N = 400
    let best = null
    for (let w = 0; w < 3; w++) {
      const before = host.fire.keyframeStats
      let worstStep = 0, worstSlice = 0, sum = 0, steps = 0
      for (let t = 0; t < N; t++) {
        const stepBefore = kernel.stepIndex
        const slicesBefore = host.fire.keyframeStats.slices
        const s = process.hrtime.bigint()
        host.clock.tick++
        host.fire.tick(1 / 60)
        const ms = Number(process.hrtime.bigint() - s) / 1e6
        const after = host.fire.keyframeStats
        if (after.slices > slicesBefore && after.lastSliceMs > worstSlice) worstSlice = after.lastSliceMs
        if (kernel.stepIndex !== stepBefore) { steps++; if (ms > worstStep) worstStep = ms }
        sum += ms
      }
      const now = host.fire.keyframeStats
      const window = {
        tiles: kernel.tileCount, steps, tickMs: Number(sum.toFixed(1)), worstStepMs: Number(worstStep.toFixed(2)),
        jobs: now.jobs - before.jobs, slices: now.slices - before.slices,
        encodeMs: Number((now.ms - before.ms).toFixed(1)), worstSliceMs: Number(worstSlice.toFixed(2)),
      }
      if (best === null || window.worstSliceMs < best.worstSliceMs) best = window
    }
    tickCosts.push({ sliceMs, ...best })
  }

  say(`keyframe at tick ${JOIN_TICK}: ${keyframeBytes} B (${keyframe.k[2].length} base64 chars), encode ${encodeBestMs.toFixed(2)} ms, decode ${decodeBestMs.toFixed(2)} ms, byte-identical re-encode ${roundTripStable}`)
  say(`  the served keyframe lags the authority by ${keyframeStaleness} ticks (its tick ${keyframe.k[0]} at join tick ${JOIN_TICK})`)
  say(`  joining at tick ${JOIN_TICK} without it: ${JSON.stringify(staleApply)}`)
  say(`  adopting it: ${JSON.stringify(adopted.adopted)}, checksum ${adopted.adopted.hash} vs authority ${keyframe.k[1]}`)
  say(`  a second joiner adopting the keyframe from tick ${earlyKeyframe.k[0]} (${earlyStaleness} ticks stale): ${JSON.stringify(lateAdopted.adopted)}, checksum ${lateAdopted.adopted.hash} vs authority ${earlyKeyframe.k[1]}`)
  say(`  fed ${deliveredRows} event row(s) and ${deliveredChecksums} checksum row(s) to tick ${HORIZON}: joiner ${joinerAtHorizon} vs late joiner ${lateJoinerAtHorizon} vs authority ${authorityAtHorizon}, resync ${JSON.stringify(joiner.fire.resyncStats)}`)
  say(`  late joiner caught up from tick ${earlyKeyframe.k[0]} to tick ${HORIZON}: ${atHorizon}`)
  say(`  mirror starved of those rows: checksum ${starvedAtHorizon} vs authority ${authorityAtHorizon}, needsResync ${starvedNeedsResync}, resync ${JSON.stringify(starvedDivergence)}`)
  say(`  mirror with cell ${touchedCell} heat tampered at tick ${JOIN_TICK} (checksum ${tamperedAtJoin}): checksum ${tamperedAtHorizon} vs authority ${authorityAtHorizon}, needsResync ${tamperedNeedsResync}, resync ${JSON.stringify(tamperedDivergence)}`)
  say(`  requestResync ${JSON.stringify(request)} -> authority answered ${resyncMsg.k?.[0]}/${resyncMsg.k?.[1]}, adopted ${JSON.stringify(starvedAdopt.adopted)}; tampered adopted ${JSON.stringify(tamperedAdopt.adopted)}`)
  say(`  after resync at tick ${AFTER}: starved ${starved.fire.checksum()} vs tampered ${tampered.fire.checksum()} vs joiner ${joiner.fire.checksum()} vs late joiner ${lateJoiner.fire.checksum()} vs authority ${authority.fire.checksum()}, needsResync ${starved.fire.needsResync}/${tampered.fire.needsResync}`)
  say(`  rejected payloads: corrupt ${corruptError} | short ${shortError} | string ${wrongTypeError}`)
  for (const s of sizes) say(`  keyframe at tick ${s.tick}: ${s.tiles} tiles, ${s.scars} scars, ${s.active} active, ${s.bytes} B, one-shot encode ${s.encodeMs} ms, sliced into ${s.slices} slices of 1 ms budget (first ${s.firstSliceMs} ms, worst later ${s.worstSliceMs} ms), served tick ${s.servedTick} encoded for the wire in ${s.serveMs} ms and re-served in ${s.cachedMs} ms, adopt ${s.adoptMs} ms, checksum matches authority ${s.matched}`)
  for (const c of tickCosts) say(`  best of 3 windows of 400 authority ticks over ${c.tiles} tiles (${c.steps} step ticks, ${c.tickMs} ms of fire.tick in total, worst step tick ${c.worstStepMs} ms) with keyframeSliceMs ${c.sliceMs}: ${c.jobs} keyframe jobs took ${c.encodeMs} ms over ${c.slices} slices, worst slice ${c.worstSliceMs} ms`)
}

say('')
say('== witness complete ==')
if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL ${f}`)
  process.exit(1)
}
