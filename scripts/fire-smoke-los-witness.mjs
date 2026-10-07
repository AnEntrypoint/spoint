import { createPlanetFrame } from '../src/terrain/PlanetFrame.js'
import { VEG } from '../src/terrain/VegPlacement.js'
import { latticeFor } from '../src/terrain/PlacementChart.js'
import { createFireLattice } from '../src/shared/fire/fireLattice.js'
import { defineFire } from '../src/behaviours/fire.js'
import { AppContext } from '../src/apps/AppContext.js'

const PLANET_RADIUS = 63600
const TICKS_PER_STEP = 10
const GROUND_Y = 40
const EYE_HEIGHT_M = 1.6
const SMOKE_HEIGHT_M = 30
const BLOCK_DEPTH = 1
const EXPECTED_SAMPLE_CAP = 512
const HOME_FACE = 2

const sampler = {
  radius: PLANET_RADIUS,
  heightAt(dir) {
    return 150 * Math.sin(dir[0] * 11) * Math.cos(dir[2] * 11) + 60 * Math.sin(dir[1] * 17 + dir[0] * 5)
  },
}
const frame = createPlanetFrame({ sampler, anchorDir: [0, 1, 0], offsetY: 0, reliefScale: 0.01 })
const placement = latticeFor(frame, VEG)
const lattice = createFireLattice(placement, 2)
const HALF = Math.floor(lattice.cellsPerFace / 2)

const failures = []
const out = []
function say(...parts) { const line = parts.join(' '); out.push(line); console.log(line) }

function cellLocal(face, I, J) {
  const d = lattice.cellCentreDir(face, I, J, [0, 0, 0])
  const du = d[0] * frame.up[0] + d[1] * frame.up[1] + d[2] * frame.up[2]
  const t = frame.radius + frame.anchorHeight
  return [
    (d[0] * frame.east[0] + d[1] * frame.east[1] + d[2] * frame.east[2]) / du * t,
    (d[0] * frame.north[0] + d[1] * frame.north[1] + d[2] * frame.north[2]) / du * t,
  ]
}

function pointAt(face, I, J, aboveGround) {
  const [x, z] = cellLocal(face, I, J)
  return [x, GROUND_Y + aboveGround, z]
}

function makeRig(spec, role) {
  const clock = { tick: 0 }
  const broadcasts = []
  const ctx = {
    time: { get tick() { return clock.tick }, get deltaTime() { return 1 / 60 }, get elapsed() { return clock.tick / 60 } },
    players: { broadcast: m => broadcasts.push(m), send: () => {}, getAll: () => [] },
    world: { sendToEntity: () => {}, applyImpulse: () => {} },
    terrainHeightAt: () => GROUND_Y,
    seaLevelAt: () => 0,
    terrainKindAt: () => 'soil',
  }
  const fire = defineFire({ ...spec, role }, ctx, () => frame, () => null, () => null)
  return { clock, broadcasts, fire, ctx }
}

function runTo(rig, t) { while (rig.clock.tick < t) { rig.clock.tick++; rig.fire.tick(1 / 60) } }

function openGroundRaycast(origin, direction, maxDistance) {
  return { hit: false, distance: maxDistance, body: null, bodyId: null, normal: null, position: null, entityId: null }
}

function makeApp(spec) {
  const runtime = {
    currentTick: 0,
    deltaTime: 1 / 60,
    elapsed: 0,
    broadcastToPlayers: () => {},
    sendToPlayer: () => {},
    _physics: {
      _planetFrame: frame,
      _terrainStreamer: null,
      terrainHeightAt: () => GROUND_Y,
      getTerrainBodyId: () => null,
      raycast: openGroundRaycast,
    },
    weatherSource: null,
  }
  const entity = {
    id: 1, _appState: {}, position: [0, GROUND_Y, 0], rotation: [0, 0, 0, 1],
    scale: [1, 1, 1], velocity: [0, 0, 0], custom: {}, children: [], parent: null,
  }
  const ctx = new AppContext(entity, runtime)
  const fire = ctx.defineFire(spec)
  return { runtime, ctx, fire }
}

function runApp(app, ticks) { for (let i = 0; i < ticks; i++) { app.runtime.currentTick++; app.fire.tick(1 / 60) } }

const gameplaySpec = { damageEveryTicks: 15, smokeBlockDepth: BLOCK_DEPTH, smokeHeightM: SMOKE_HEIGHT_M, eyeHeightM: EYE_HEIGHT_M, targets: () => [] }
const BASE = { stepTicks: TICKS_PER_STEP, regrowSteps: 400, seed: 7, leadTicks: 6, checksumEverySteps: 5, gameplay: gameplaySpec }

function shot(from, to) {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2]
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
  return { distance, direction: [dx / distance, dy / distance, dz / distance] }
}

function plumeLengthM(climbPerMetre, rangeM) {
  if (!(climbPerMetre > 1e-6)) return EYE_HEIGHT_M <= SMOKE_HEIGHT_M ? rangeM : 0
  const exit = (SMOKE_HEIGHT_M - EYE_HEIGHT_M) / climbPerMetre
  return Math.min(rangeM, exit)
}

function countSamples(fire, fn) {
  const kernel = fire.world?.kernel
  if (!kernel) { fn(); return 0 }
  const own = Object.prototype.hasOwnProperty.call(kernel, 'smokeAt')
  const previous = kernel.smokeAt
  const real = previous.bind(kernel)
  let samples = 0
  kernel.smokeAt = (...args) => { samples++; return real(...args) }
  try {
    fn()
  } finally {
    if (own) kernel.smokeAt = previous
    else delete kernel.smokeAt
  }
  return samples
}

say('== fire smoke line-of-sight witness ==')
say(`planet radius ${PLANET_RADIUS} m, fire cell ${lattice.cellM.toFixed(2)} m, cells per face ${lattice.cellsPerFace}`)
say(`rule: a ray is blocked when its optical depth reaches smokeBlockDepth (${BLOCK_DEPTH}); depth sums smokeAt(cell)*segment/255`)
say(`over the metres of the ray that stay inside the plume: eyeHeightM ${EYE_HEIGHT_M} m above ground, plume top smokeHeightM ${SMOKE_HEIGHT_M} m`)

say('')
say('== 1. the measured rule: a flat shot through the front is absorbed, a climbing shot leaves the plume ==')
const burning = makeRig(BASE, 'authority')
burning.fire.igniteCell(HOME_FACE, HALF, HALF, 3)
runTo(burning, 14 * TICKS_PER_STEP)
const eyeFrom = pointAt(HOME_FACE, HALF - 30, HALF, EYE_HEIGHT_M)
const eyeTo = pointAt(HOME_FACE, HALF + 30, HALF, EYE_HEIGHT_M)
const flatShot = shot(eyeFrom, eyeTo)
say(`young fire after 14 steps: ${burning.fire.activeCount} active cells, shooter fires ${flatShot.distance.toFixed(0)} m across the front at ${EYE_HEIGHT_M} m`)
{
  const rows = []
  let blockedSeen = 0, clearSeen = 0, deepest = 0, monotone = true
  let previous = Infinity
  for (const climb of [0, 0.02, 0.05, 0.1, 0.2, 0.4, 1]) {
    const length = Math.hypot(flatShot.distance, climb * flatShot.distance)
    const direction = [flatShot.direction[0] * flatShot.distance / length, climb * flatShot.distance / length, flatShot.direction[2] * flatShot.distance / length]
    const depth = burning.fire.smokeDepth(eyeFrom, direction, flatShot.distance)
    const blocked = burning.fire.rayBlocked(eyeFrom, direction, flatShot.distance)
    const predicted = plumeLengthM(direction[1], flatShot.distance)
    if (blocked) blockedSeen++; else clearSeen++
    if (depth > deepest) deepest = depth
    if (depth > previous + 1e-9) monotone = false
    previous = depth
    rows.push(`climb ${String(climb).padEnd(4)}: ${predicted.toFixed(0).padStart(4)} m of ${flatShot.distance.toFixed(0)} m inside the plume, depth ${depth.toFixed(3).padStart(7)} blocked=${blocked}`)
  }
  for (const r of rows) say('  ' + r)
  if (blockedSeen === 0) failures.push(`section 1: none of the ${rows.length} rays through the burning front reached depth ${BLOCK_DEPTH}, so the block rule was never observed`)
  if (clearSeen === 0) failures.push(`section 1: every one of the ${rows.length} rays was blocked, so the plume-exit term of the rule was never observed`)
  if (!monotone) failures.push('section 1: depth grew as the ray climbed steeper, so the plume-exit term is not monotone')
  say(`  ${blockedSeen} blocked, ${clearSeen} clear, deepest depth ${deepest.toFixed(3)}`)
}

say('')
say('== 2. smokeBlockDepth is the whole rule: the verdict flips exactly at the measured depth ==')
{
  const depth = burning.fire.smokeDepth(eyeFrom, flatShot.direction, flatShot.distance)
  const rows = []
  let flips = 0, last = null
  for (const threshold of [0.25, 0.5, 1, 2, 4, 8, 16, 64]) {
    const rig = makeRig({ ...BASE, gameplay: { ...gameplaySpec, smokeBlockDepth: threshold } }, 'authority')
    rig.fire.igniteCell(HOME_FACE, HALF, HALF, 3)
    runTo(rig, 14 * TICKS_PER_STEP)
    const blocked = rig.fire.rayBlocked(eyeFrom, flatShot.direction, flatShot.distance)
    if (last !== null && blocked !== last) flips++
    last = blocked
    rows.push(`smokeBlockDepth ${String(threshold).padEnd(5)}: blocked=${blocked} (depth ${depth.toFixed(3)})`)
  }
  for (const r of rows) say('  ' + r)
  if (flips !== 1) failures.push(`section 2: the verdict changed ${flips} time(s) across a rising threshold over a fixed depth ${depth.toFixed(3)}; it must flip exactly once`)
}

say('')
say('== 3. a plume that tops out below the eye carries no smoke at all (exact boundary) ==')
{
  const rows = []
  let wrong = 0
  for (const plume of [0.5, 1.5999, 1.6, 2]) {
    const rig = makeRig({ ...BASE, gameplay: { ...gameplaySpec, smokeHeightM: plume } }, 'authority')
    rig.fire.igniteCell(HOME_FACE, HALF, HALF, 3)
    runTo(rig, 14 * TICKS_PER_STEP)
    let worstDepth = 0, blockedCount = 0
    for (const climb of [0, 0.1, 0.4, 1]) {
      const length = Math.hypot(flatShot.distance, climb * flatShot.distance)
      const direction = [flatShot.direction[0] * flatShot.distance / length, climb * flatShot.distance / length, flatShot.direction[2] * flatShot.distance / length]
      const depth = rig.fire.smokeDepth(eyeFrom, direction, flatShot.distance)
      if (depth > worstDepth) worstDepth = depth
      if (rig.fire.rayBlocked(eyeFrom, direction, flatShot.distance)) blockedCount++
    }
    const wantBlocking = plume >= EYE_HEIGHT_M
    const gotBlocking = worstDepth > 0
    if (wantBlocking !== gotBlocking || (gotBlocking && blockedCount < 1) || (!gotBlocking && blockedCount !== 0)) wrong++
    rows.push(`plume top ${String(plume).padEnd(7)} vs eye ${EYE_HEIGHT_M}: worst depth ${worstDepth.toFixed(3).padStart(7)}, ${blockedCount} of 4 rays blocked${wantBlocking === gotBlocking ? '' : ' (wrong side of the boundary)'}`)
  }
  for (const r of rows) say('  ' + r)
  if (wrong > 0) failures.push(`section 3: the eye-versus-plume-top boundary came out wrong on ${wrong} of ${rows.length} plume heights`)
  const quiet = makeRig(BASE, 'authority')
  const quietDepth = quiet.fire.smokeDepth(eyeFrom, flatShot.direction, flatShot.distance)
  const quietBlocked = quiet.fire.rayBlocked(eyeFrom, flatShot.direction, flatShot.distance)
  say(`a world that was never ignited: depth ${quietDepth}, blocked=${quietBlocked}`)
  if (quietDepth !== 0 || quietBlocked) failures.push(`section 3: a fire that was never lit reported depth ${quietDepth} blocked=${quietBlocked}`)
}

say('')
say('== 4. sightBlocked is the same rule as the shot query on every segment ==')
{
  const samples = []
  let agreements = 0, disagreements = 0, blockedSeen = 0
  for (let d = -30; d <= 30; d += 3) {
    for (const climb of [0, 0.1, 0.3]) {
      const to = pointAt(HOME_FACE, HALF + d, HALF, EYE_HEIGHT_M + climb * Math.abs(d) * lattice.cellM)
      const s = shot(eyeFrom, to)
      if (!(s.distance > 1)) continue
      const bySegment = burning.fire.sightBlocked(eyeFrom, to)
      const byRay = burning.fire.rayBlocked(eyeFrom, s.direction, s.distance)
      if (bySegment === byRay) agreements++; else disagreements++
      if (bySegment) blockedSeen++
      samples.push(s.distance)
    }
  }
  say(`${samples.length} segments ${Math.min(...samples).toFixed(0)}..${Math.max(...samples).toFixed(0)} m: ${agreements} agreement(s), ${disagreements} disagreement(s), ${blockedSeen} blocked`)
  if (disagreements > 0) failures.push(`section 4: sightBlocked and rayBlocked disagreed on ${disagreements} of ${samples.length} segments`)
  if (blockedSeen === 0) failures.push(`section 4: sightBlocked never blocked one of ${samples.length} segments through the front`)
}

say('')
say('== 4b. the same rule on a ray that crosses a cube-face boundary, where the query samples instead of walking cells ==')
{
  let picked = null
  for (const [startI, delta, radius] of [[8, -14, 8], [4, -6, 8], [16, -24, 8], [2, -4, 6]]) {
    const across = { face: 0, I: 0, J: 0 }
    lattice.walk(HOME_FACE, startI, HALF, delta, 0, across)
    if (across.face === HOME_FACE) continue
    const rig = makeRig(BASE, 'authority')
    rig.fire.igniteCell(HOME_FACE, startI, HALF, radius)
    runTo(rig, 14 * TICKS_PER_STEP)
    const a = pointAt(HOME_FACE, startI, HALF, EYE_HEIGHT_M)
    const b = pointAt(across.face, across.I, across.J, EYE_HEIGHT_M)
    const s = shot(a, b)
    const depth = rig.fire.smokeDepth(a, s.direction, s.distance)
    if (depth > 0) { picked = { rig, a, b, s, depth, across, startI, delta }; break }
  }
  if (!picked) {
    failures.push('section 4b: no cross-face ray over burning cells could be built, so the sampled path was never exercised')
  } else {
    const { rig, a, b, s, depth, across, startI, delta } = picked
    const bySegment = rig.fire.sightBlocked(a, b)
    const byRay = rig.fire.rayBlocked(a, s.direction, s.distance)
    say(`  ${s.distance.toFixed(1)} m from face ${HOME_FACE} cell I ${startI} to face ${across.face} cell ${across.I},${across.J}: depth ${depth.toFixed(3)}, sightBlocked ${bySegment}, rayBlocked ${byRay}`)
    if (bySegment !== byRay) failures.push(`section 4b: sightBlocked (${bySegment}) and rayBlocked (${byRay}) disagreed across a face boundary`)
    if (byRay !== (depth >= BLOCK_DEPTH)) failures.push(`section 4b: the cross-face verdict ${byRay} does not follow the rule over depth ${depth.toFixed(3)}`)
    let stable = true
    for (let i = 0; i < 200; i++) if (rig.fire.smokeDepth(a, s.direction, s.distance) !== depth) stable = false
    say(`  200 repeats of that cross-face query: ${stable ? 'identical every time' : 'DRIFTED'}`)
    if (!stable) failures.push('section 4b: the cross-face smoke query is not reproducible')

    const far = { face: 0, I: 0, J: 0 }
    lattice.walk(HOME_FACE, HALF, HALF, -9000, 0, far)
    const farTo = pointAt(far.face, far.I, far.J, EYE_HEIGHT_M)
    const farShot = shot(eyeFrom, farTo)
    const nearCount = countSamples(rig.fire, () => rig.fire.smokeDepth(eyeFrom, farShot.direction, farShot.distance / 100))
    const midCount = countSamples(rig.fire, () => rig.fire.smokeDepth(eyeFrom, farShot.direction, farShot.distance / 10))
    const farCount = countSamples(rig.fire, () => rig.fire.smokeDepth(eyeFrom, farShot.direction, farShot.distance))
    const uncapped = Math.ceil(farShot.distance / (lattice.cellM * 0.5))
    let best = Infinity
    for (let k = 0; k < 5; k++) {
      const t = process.hrtime.bigint()
      for (let i = 0; i < 200; i++) rig.fire.smokeDepth(eyeFrom, farShot.direction, farShot.distance)
      const ns = Number(process.hrtime.bigint() - t) / 200
      if (ns < best) best = ns
    }
    say(`  a ${(farShot.distance / 1000).toFixed(0)} km ray that crosses a boundary samples ${nearCount}/${midCount}/${farCount} cell(s) at a hundredth, a tenth and the full range, against ${uncapped} half-cell step(s) for an uncapped walk`)
    say(`  ${(best / 1000).toFixed(2)} us per query (best of 5 x 200) is an observation, not a gate`)
    if (!(nearCount > 0 && midCount > 0 && farCount > 0)) failures.push(`section 4b: the cross-face path read ${nearCount}/${midCount}/${farCount} cell(s) over the three ranges, so the sample count was never measured`)
    if (midCount < nearCount) failures.push(`section 4b: the sample count fell from ${nearCount} to ${midCount} as the ray grew 10x, so the counts are not tracking the sampled path`)
    if (nearCount >= EXPECTED_SAMPLE_CAP) failures.push(`section 4b: the shortest ray already sampled ${nearCount} cell(s), so no range short enough to sit under the ${EXPECTED_SAMPLE_CAP} cap is exercised and the cap cannot be seen holding`)
    if (midCount !== EXPECTED_SAMPLE_CAP) failures.push(`section 4b: a ray ten times longer sampled ${midCount} cell(s), where a walk that saturates stops at exactly ${EXPECTED_SAMPLE_CAP}`)
    if (farCount !== EXPECTED_SAMPLE_CAP) failures.push(`section 4b: the full ${(farShot.distance / 1000).toFixed(0)} km ray sampled ${farCount} cell(s), where a walk that saturates stops at exactly ${EXPECTED_SAMPLE_CAP}`)
    if (!(farCount < uncapped)) failures.push(`section 4b: the full ray sampled ${farCount} cell(s) against ${uncapped} half-cell step(s), so nothing capped the walk`)
  }
}

say('')
say('== 5. AppContext.canSee is gated by the smoke: an AI loses the sightline the shot loses ==')
{
  const app = makeApp(BASE)
  const activeBefore = app.fire.activeCount
  const blind = app.ctx.canSee(eyeFrom, eyeTo)
  runApp(app, 1)
  app.fire.igniteCell(HOME_FACE, HALF, HALF, 3)
  runApp(app, 14 * TICKS_PER_STEP)
  const throughFire = app.ctx.canSee(eyeFrom, eyeTo)
  const alongTheFront = app.ctx.canSee(pointAt(HOME_FACE, HALF - 30, HALF - 60, EYE_HEIGHT_M), pointAt(HOME_FACE, HALF + 30, HALF - 60, EYE_HEIGHT_M))
  const depthNow = app.fire.smokeDepth(eyeFrom, flatShot.direction, flatShot.distance)
  say(`with the fire defined but not yet lit: canSee ${blind} (active ${activeBefore})`)
  say(`after 14 steps of burning: canSee across the front ${throughFire}, depth ${depthNow.toFixed(3)}, active ${app.fire.activeCount}`)
  say(`a chord that misses the front: canSee ${alongTheFront}`)
  if (blind !== true) failures.push(`section 5: canSee returned ${blind} with no fire burning, so the gate is blocking sightlines on its own`)
  if (throughFire !== false) failures.push(`section 5: canSee still sees through smoke of depth ${depthNow.toFixed(3)} across the burning front`)
  if (alongTheFront !== true) failures.push('section 5: canSee blocked a chord that never crosses the fire, so the gate is not reading the smoke')

  app.fire.extinguish(cellLocal(HOME_FACE, HALF, HALF).concat([GROUND_Y]), 400)
  let ticks = 0
  while (app.fire.activeCount > 0 && ticks < 4000) { app.runtime.currentTick++; app.fire.tick(1 / 60); ticks++ }
  const afterExtinguish = app.ctx.canSee(eyeFrom, eyeTo)
  say(`after extinguish (${ticks} ticks to ${app.fire.activeCount} active cells): canSee ${afterExtinguish}`)
  if (afterExtinguish !== true) failures.push(`section 5: canSee still blocked ${afterExtinguish} after the fire was extinguished`)
}

say('')
say('== 6. degenerate input at the sightline gate ==')
{
  const app = makeApp(BASE)
  app.fire.igniteCell(HOME_FACE, HALF, HALF, 3)
  runApp(app, 14 * TICKS_PER_STEP)
  const cases = [
    ['same point', app.ctx.canSee(eyeFrom, eyeFrom.slice()), true],
    ['NaN origin', app.ctx.canSee([NaN, 0, 0], eyeTo), false],
    ['NaN target', app.ctx.canSee(eyeFrom, [0, NaN, 0]), false],
    ['missing target', app.ctx.canSee(eyeFrom, undefined), false],
    ['two-component vector', app.ctx.canSee([eyeFrom[0], eyeFrom[1]], eyeTo), false],
    ['beyond maxDistance', app.ctx.canSee(eyeFrom, eyeTo, { maxDistance: 1 }), false],
    ['within maxDistance', app.ctx.canSee(eyeFrom, eyeTo, { maxDistance: flatShot.distance * 2 }), false],
  ]
  for (const [label, got, want] of cases) {
    say(`  ${label.padEnd(22)}: ${got}${got === want ? '' : ` (expected ${want})`}`)
    if (got !== want) failures.push(`section 6: canSee on ${label} returned ${got}, expected ${want}`)
  }
  const degenerateFire = [
    ['sightBlocked same point', app.fire.sightBlocked(eyeFrom, eyeFrom.slice()), false],
    ['sightBlocked NaN', app.fire.sightBlocked([NaN, 1, 2], eyeTo), false],
    ['sightBlocked missing arg', app.fire.sightBlocked(eyeFrom, null), false],
    ['sightBlocked no args', app.fire.sightBlocked(), false],
    ['rayBlocked zero length', app.fire.rayBlocked(eyeFrom, [0, 0, 0], 0), false],
  ]
  for (const [label, got, want] of degenerateFire) {
    say(`  ${label.padEnd(22)}: ${got}${got === want ? '' : ` (expected ${want})`}`)
    if (got !== want) failures.push(`section 6: ${label} returned ${got}, expected ${want}`)
  }
}

say('')
say('== 7. the same query is bit-identical when repeated, and one query costs this much ==')
{
  const first = burning.fire.smokeDepth(eyeFrom, flatShot.direction, flatShot.distance)
  let stable = true
  for (let i = 0; i < 1000; i++) if (burning.fire.smokeDepth(eyeFrom, flatShot.direction, flatShot.distance) !== first) stable = false
  say(`1000 repeats of the same ${flatShot.distance.toFixed(0)} m query: depth ${first.toFixed(6)} every time ${stable}`)
  if (!stable) failures.push('section 7: the smoke query returned different depths for the same ray')

  const quiet = makeRig(BASE, 'authority')
  const measure = (label, fn, batches = 5, per = 1000) => {
    let best = Infinity
    for (let b = 0; b < batches; b++) {
      const s = process.hrtime.bigint()
      for (let i = 0; i < per; i++) fn()
      const ns = Number(process.hrtime.bigint() - s) / per
      if (ns < best) best = ns
    }
    say(`  ${label.padEnd(38)}: ${(best / 1000).toFixed(2)} us per query (best of ${batches} x ${per})`)
    return best
  }
  measure('smokeDepth through the burning front', () => burning.fire.smokeDepth(eyeFrom, flatShot.direction, flatShot.distance))
  measure('smokeDepth with nothing burning', () => quiet.fire.smokeDepth(eyeFrom, flatShot.direction, flatShot.distance))
  measure('rayBlocked through the burning front', () => burning.fire.rayBlocked(eyeFrom, flatShot.direction, flatShot.distance))
  measure('sightBlocked through the burning front', () => burning.fire.sightBlocked(eyeFrom, eyeTo))
  const appRig = makeApp(BASE)
  runApp(appRig, 1)
  appRig.fire.igniteCell(HOME_FACE, HALF, HALF, 3)
  runApp(appRig, 14 * TICKS_PER_STEP)
  const appBlocked = appRig.ctx.canSee(eyeFrom, eyeTo)
  measure('AppContext.canSee across the front', () => appRig.ctx.canSee(eyeFrom, eyeTo), 5, 500)
  say(`  canSee across the front reports ${appBlocked} (smoke alone, no geometry in the way)`)
  const busySamples = countSamples(burning.fire, () => burning.fire.smokeDepth(eyeFrom, flatShot.direction, flatShot.distance))
  const quietSamples = countSamples(quiet.fire, () => quiet.fire.smokeDepth(eyeFrom, flatShot.direction, flatShot.distance))
  say(`  the busy query read ${busySamples} cell(s) and the quiet one ${quietSamples} (timings above are an observation, not a gate)`)
  if (busySamples === 0 || quietSamples !== 0) failures.push(`section 7: a smoke query sampled ${busySamples} cell(s) over the burning front and ${quietSamples} over a quiet world, so the measurement saw nothing`)
  const segmentSamples = countSamples(burning.fire, () => burning.fire.sightBlocked(eyeFrom, eyeTo))
  const canSeeSamples = countSamples(appRig.fire, () => appRig.ctx.canSee(eyeFrom, eyeTo))
  say(`  sightBlocked read ${segmentSamples} cell(s) and canSee ${canSeeSamples} (timings above are an observation, not a gate)`)
  if (segmentSamples === 0 || canSeeSamples === 0) failures.push(`section 7: sightBlocked sampled ${segmentSamples} cell(s) and canSee ${canSeeSamples} over the burning front, so the sightline gate read no smoke`)
}

say('')
say('== witness complete ==')
if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL ${f}`)
  say(`RESULT: FAIL (${failures.length} check(s))`)
  process.exit(1)
}
say(`RESULT: PASS -- smoke blocks the shot and the AI sightline at depth ${BLOCK_DEPTH}, eyeHeightM ${EYE_HEIGHT_M}, plume ${SMOKE_HEIGHT_M} m`)
