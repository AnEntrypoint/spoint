import { createPlanetFrame } from '../src/terrain/PlanetFrame.js'
import { VEG } from '../src/terrain/VegPlacement.js'
import { latticeFor } from '../src/terrain/PlacementChart.js'
import { createFireLattice } from '../src/shared/fire/fireLattice.js'
import { defineFire } from '../src/behaviours/fire.js'
import { createWindField } from '../src/shared/fire/fireWind.js'
import { createServerWeather } from '../src/sdk/ServerWeather.js'
import { FIRE_MAX_WIND_COMPONENT, FIRE_EVENT } from '../src/shared/fire/fireKernel.js'

const sampler = {
  radius: 63600,
  heightAt(dir) { return 150 * Math.sin(dir[0] * 11) * Math.cos(dir[2] * 11) + 60 * Math.sin(dir[1] * 17 + dir[0] * 5) },
}
const frame = createPlanetFrame({ sampler, anchorDir: [0, 1, 0], offsetY: 0, reliefScale: 0.01 })
const lattice = createFireLattice(latticeFor(frame, VEG), 2)
const HALF = Math.floor(lattice.cellsPerFace / 2)
const HOME_FACE = 2

const failures = []
function say(line) { console.log(line) }

function makeFire(spec, role) {
  const clock = { tick: 0 }
  const broadcasts = []
  const ctx = {
    time: { get tick() { return clock.tick }, get deltaTime() { return 1 / 60 }, get elapsed() { return clock.tick / 60 } },
    players: { broadcast: m => broadcasts.push(m), send: () => {}, getAll: () => [] },
    world: { sendToEntity: () => {}, applyImpulse: () => {} },
    terrainHeightAt: (x, z) => 40 * Math.sin(x / 900) * Math.cos(z / 900),
    seaLevelAt: () => 0,
    terrainKindAt: () => 'soil',
  }
  const fire = defineFire({ ...spec, role }, ctx, () => frame, () => null, () => null)
  return { clock, broadcasts, fire }
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

const BASE = { stepTicks: 10, regrowSteps: 400, seed: 11, leadTicks: 6, checksumEverySteps: 5, rewind: true }

function expectedWind(base, field, step) {
  const g = field(step, [0, 0, 0])
  const out = []
  for (let i = 0; i < 3; i++) {
    const v = base[i] + g[i]
    out.push(v < -FIRE_MAX_WIND_COMPONENT ? -FIRE_MAX_WIND_COMPONENT : v > FIRE_MAX_WIND_COMPONENT ? FIRE_MAX_WIND_COMPONENT : v)
  }
  return out
}

function igniteAndRun(rig, steps) {
  rig.fire.igniteCell(HOME_FACE, HALF, HALF, 3)
  runSteps(rig, steps, () => {})
}

say('== fire wind coupling witness ==')
say(`the fire carries one wind: the authoritative vector from the weather plus a seed+step gust field, clamped to +-${FIRE_MAX_WIND_COMPONENT} per axis`)

say('')
say('== 1. a steady weather wind alone, and a gust field alone ==')
{
  const steady = makeFire({ ...BASE, wind: [9, 0, -4] }, 'authority')
  igniteAndRun(steady, 6)
  say(`  weather wind [9,0,-4] alone: fire wind [${steady.fire.wind.join(',')}] at step ${steady.fire.world.kernel.stepIndex}`)
  if (steady.fire.wind.join(',') !== '9,0,-4') failures.push(`section 1: a steady wind came back as [${steady.fire.wind.join(',')}]`)

  const gustSpec = { seed: 5, amplitude: 6, periodSteps: 3 }
  const gustField = createWindField(gustSpec)
  const gusty = makeFire({ ...BASE, windField: gustSpec }, 'authority')
  const seen = []
  let mismatches = 0
  igniteAndRun(gusty, 9)
  runSteps(gusty, 6, step => {
    const want = expectedWind([0, 0, 0], gustField, step)
    if (gusty.fire.wind.join(',') !== want.join(',')) mismatches++
    if (seen.length < 6) seen.push(`${step}:[${gusty.fire.wind.join(',')}]`)
  })
  say(`  gust field alone (seed ${gustSpec.seed}, amplitude ${gustSpec.amplitude}, period ${gustSpec.periodSteps} steps): ${seen.join(' ')}`)
  say(`  every step equals the field's own value recomputed independently: ${mismatches === 0}`)
  if (mismatches > 0) failures.push(`section 1: the gust field disagreed with its own generator on ${mismatches} step(s)`)
  if (seen.length === 0) failures.push('section 1: no gust step was sampled')
}

say('')
say('== 2. both at once: the wind the fire uses is weather + gust, clamped per axis ==')
{
  const gustSpec = { seed: 21, amplitude: 10, periodSteps: 4 }
  const gustField = createWindField(gustSpec)
  const base = [7, -3, 2]
  const rig = makeFire({ ...BASE, wind: base, windField: gustSpec }, 'authority')
  const rows = []
  let mismatches = 0, nonInteger = 0, overRange = 0, saturations = 0, widest = 0
  igniteAndRun(rig, 4)
  runSteps(rig, 12, step => {
    const want = expectedWind(base, gustField, step)
    const got = rig.fire.wind
    if (got.join(',') !== want.join(',')) mismatches++
    for (let i = 0; i < 3; i++) {
      if (!Number.isInteger(got[i])) nonInteger++
      if (Math.abs(got[i]) > FIRE_MAX_WIND_COMPONENT) overRange++
      if (Math.abs(base[i] + gustField(step, [0, 0, 0])[i]) > Math.abs(widest)) widest = base[i] + gustField(step, [0, 0, 0])[i]
      if (Math.abs(got[i]) === FIRE_MAX_WIND_COMPONENT && Math.abs(base[i] + gustField(step, [0, 0, 0])[i]) > FIRE_MAX_WIND_COMPONENT) saturations++
    }
    if (rows.length < 6) rows.push(`${step}:[${got.join(',')}]`)
  })
  say(`  weather [${base.join(',')}] + gust(seed ${gustSpec.seed}, amplitude ${gustSpec.amplitude}, period ${gustSpec.periodSteps}): ${rows.join(' ')}`)
  say(`  recomputed independently on every step: ${mismatches === 0 ? 'yes' : `NO (${mismatches} step(s) differ)`}`)
  say(`  every component an integer: ${nonInteger === 0}, every component within +-${FIRE_MAX_WIND_COMPONENT}: ${overRange === 0}`)
  if (mismatches > 0) failures.push(`section 2: the composed wind disagreed with base+gust on ${mismatches} step(s)`)
  if (nonInteger > 0) failures.push(`section 2: ${nonInteger} wind component(s) were not integers`)
  if (overRange > 0) failures.push(`section 2: ${overRange} wind component(s) left the +-${FIRE_MAX_WIND_COMPONENT} range`)
  if (rows.length === 0) failures.push('section 2: no composed step was sampled')

  const extreme = makeFire({ ...BASE, wind: [FIRE_MAX_WIND_COMPONENT, -FIRE_MAX_WIND_COMPONENT, FIRE_MAX_WIND_COMPONENT], windField: { seed: 3, amplitude: FIRE_MAX_WIND_COMPONENT, periodSteps: 2 } }, 'authority')
  const extremeField = createWindField({ seed: 3, amplitude: FIRE_MAX_WIND_COMPONENT, periodSteps: 2 })
  const extremeBase = [FIRE_MAX_WIND_COMPONENT, -FIRE_MAX_WIND_COMPONENT, FIRE_MAX_WIND_COMPONENT]
  let clampedIn = 0, clampedOut = 0, saturated = 0, biggest = 0
  igniteAndRun(extreme, 4)
  runSteps(extreme, 10, step => {
    const raw = extremeBase.map((b, i) => b + extremeField(step, [0, 0, 0])[i])
    const got = extreme.fire.wind
    for (let i = 0; i < 3; i++) {
      if (Math.abs(raw[i]) > FIRE_MAX_WIND_COMPONENT) clampedIn++
      if (Math.abs(got[i]) > FIRE_MAX_WIND_COMPONENT) clampedOut++
      if (Math.abs(raw[i]) > FIRE_MAX_WIND_COMPONENT && Math.abs(got[i]) === FIRE_MAX_WIND_COMPONENT) saturated++
      if (Math.abs(raw[i]) > biggest) biggest = Math.abs(raw[i])
    }
  })
  say(`  a base already at the +-${FIRE_MAX_WIND_COMPONENT} rail plus a full-amplitude gust: ${clampedIn} component(s) asked for more than the rail (worst ${biggest}), ${saturated} clamped onto it, ${clampedOut} escaped`)
  if (clampedIn === 0) failures.push('section 2: no component ever exceeded the rail, so the clamp was never exercised')
  if (saturated !== clampedIn) failures.push(`section 2: ${clampedIn} component(s) exceeded the rail but only ${saturated} landed exactly on it, so the clamp is not saturating`)
  if (clampedOut > 0) failures.push(`section 2: ${clampedOut} component(s) escaped the +-${FIRE_MAX_WIND_COMPONENT} clamp`)
}

say('')
say('== 3. the gust moves with the step and holds between period boundaries ==')
{
  const gustSpec = { seed: 31, amplitude: 12, periodSteps: 5 }
  const rig = makeFire({ ...BASE, wind: [4, 0, 0], windField: gustSpec }, 'authority')
  const perStep = []
  igniteAndRun(rig, 4)
  runSteps(rig, 15, step => { if (perStep.length < 15) perStep.push(`${step}:[${rig.fire.wind.join(',')}]`) })
  const distinct = new Set(perStep.map(s => s.split(':')[1]))
  say(`  ${perStep.length} steps: ${perStep.slice(0, 8).join(' ')}`)
  say(`  distinct winds over 15 steps of a period-${gustSpec.periodSteps} field: ${distinct.size}`)
  if (distinct.size < 3) failures.push(`section 3: a period-${gustSpec.periodSteps} gust field produced only ${distinct.size} distinct wind(s) over 15 steps`)
  const holdField = createWindField(gustSpec)
  const holdSteps = [0, 1, 2, 3, 4].map(s => holdField(s, [0, 0, 0]).join(','))
  say(`  the generator holds one value inside a period: steps 0..4 give ${[...new Set(holdSteps)].length} value(s)`)
  if (new Set(holdSteps).size !== 1) failures.push(`section 3: the gust field changed inside a period: ${holdSteps.join(' | ')}`)
}

say('')
say('== 4. the wire carries the weather wind, never the gust: a mirror rebuilds the same wind from seed and step ==')
{
  const gustSpec = { seed: 41, amplitude: 9, periodSteps: 6 }
  const authority = makeFire({ ...BASE, wind: [2, 0, -3], windField: gustSpec }, 'authority')
  const mirror = makeFire({ ...BASE, wind: [2, 0, -3], windField: gustSpec }, 'mirror')
  let cursor = 0
  const deliver = () => {
    const fresh = authority.broadcasts.slice(cursor)
    cursor = authority.broadcasts.length
    for (const m of fresh) mirror.fire.applyRemote(m)
  }
  authority.fire.igniteCell(HOME_FACE, HALF, HALF, 3)
  deliver()
  let checked = 0, diverged = 0
  const first = authority.fire.world.kernel.stepIndex
  let last = first
  const limit = authority.clock.tick + 20 * 400 + 400
  while (authority.fire.world.kernel.stepIndex < first + 20 && authority.clock.tick < limit) {
    runTo(authority, authority.clock.tick + 1)
    deliver()
    runTo(mirror, authority.clock.tick)
    const step = authority.fire.world.kernel.stepIndex
    if (step !== last) {
      last = step
      checked++
      if (authority.fire.wind.join(',') !== mirror.fire.wind.join(',')) diverged++
    }
  }
  say(`  ${checked} step(s) checked: authority wind [${authority.fire.wind.join(',')}] vs mirror [${mirror.fire.wind.join(',')}]`)
  say(`  checksums: authority ${authority.fire.checksum()} vs mirror ${mirror.fire.checksum()}, needsResync ${mirror.fire.needsResync}`)
  if (checked === 0) failures.push('section 4: no step boundary was crossed, so the mirror comparison never ran')
  if (diverged > 0) failures.push(`section 4: the mirror's wind differed from the authority's on ${diverged} of ${checked} step(s)`)
  if (authority.fire.checksum() !== mirror.fire.checksum()) failures.push(`section 4: mirror checksum ${mirror.fire.checksum()} vs authority ${authority.fire.checksum()}`)
  if (mirror.fire.needsResync) failures.push('section 4: a mirror fed every wire row still asked for a resync')

  const windRows = authority.broadcasts.filter(m => Array.isArray(m.e)).flatMap(m => m.e).filter(r => r[0] === FIRE_EVENT.WIND)
  say(`  WIND rows on the wire over that whole run: ${windRows.length} ${JSON.stringify(windRows.slice(0, 2))}`)
  if (windRows.length > 2) failures.push(`section 4: ${windRows.length} WIND rows crossed the wire for one steady weather wind plus a seed+step gust; only a change should travel`)
}

say('')
say('== 5. a wind change on the wire moves the base and keeps the gust ==')
{
  const gustSpec = { seed: 51, amplitude: 8, periodSteps: 4 }
  const authority = makeFire({ ...BASE, wind: [1, 0, 0], windField: gustSpec }, 'authority')
  const mirror = makeFire({ ...BASE, wind: [1, 0, 0], windField: gustSpec }, 'mirror')
  authority.fire.igniteCell(HOME_FACE, HALF, HALF, 3)
  let cursor = 0
  const deliver = () => {
    const fresh = authority.broadcasts.slice(cursor)
    cursor = authority.broadcasts.length
    for (const m of fresh) mirror.fire.applyRemote(m)
  }
  deliver()
  runTo(authority, authority.clock.tick + 120)
  deliver()
  runTo(mirror, authority.clock.tick)
  const before = [authority.fire.wind.join(','), mirror.fire.wind.join(',')]
  const eventId = authority.fire.setWind([-12, 0, 6])
  let ticks = 0
  while (ticks < 400 && mirror.fire.wind.join(',') === before[1]) { runTo(authority, authority.clock.tick + 1); deliver(); runTo(mirror, authority.clock.tick); ticks++ }
  say(`  setWind([-12,0,6]) event ${eventId} delivered in ${ticks} tick(s): authority [${before[0]}] -> [${authority.fire.wind.join(',')}], mirror [${before[1]}] -> [${mirror.fire.wind.join(',')}]`)
  if (authority.fire.wind.join(',') === before[0]) failures.push(`section 5: setWind left the authority's wind at [${before[0]}]`)
  if (mirror.fire.wind.join(',') !== authority.fire.wind.join(',')) failures.push(`section 5: after the wind event the mirror reads [${mirror.fire.wind.join(',')}] against the authority's [${authority.fire.wind.join(',')}]`)
  const field = createWindField(gustSpec)
  const step = authority.fire.world.kernel.stepIndex
  const want = expectedWind([-12, 0, 6], field, step)
  say(`  that wind is the new base plus the gust at step ${step}: [${authority.fire.wind.join(',')}] vs recomputed [${want.join(',')}]`)
  if (authority.fire.wind.join(',') !== want.join(',')) failures.push(`section 5: after the wind event the authority reads [${authority.fire.wind.join(',')}], base+gust is [${want.join(',')}], so the gust was clobbered`)
  if (authority.fire.checksum() !== mirror.fire.checksum()) failures.push(`section 5: checksums split after the wind event, ${mirror.fire.checksum()} vs ${authority.fire.checksum()}`)
}

say('')
say('== 6. ServerWeather is the wind source: its clamped vector becomes the fire base ==')
{
  const weatherConfig = { serverAuthoritative: true, type: 'clear', intensity: 0, wind: [3, 0, -2] }
  const serverWeather = createServerWeather(() => weatherConfig)
  const rig = makeFire(BASE, 'authority')
  rig.fire.igniteCell(HOME_FACE, HALF, HALF, 3)
  runTo(rig, 30)
  const fromSync = serverWeather.getSyncPayload().wind
  rig.fire.setWind(fromSync)
  runTo(rig, rig.clock.tick + 60)
  say(`  weather sync wind ${JSON.stringify(fromSync)} -> fire wind [${rig.fire.wind.join(',')}] (no gust field, so base only)`)
  if (rig.fire.wind.join(',') !== fromSync.join(',')) failures.push(`section 6: the fire wind [${rig.fire.wind.join(',')}] is not the weather's ${JSON.stringify(fromSync)}`)

  serverWeather.setWind([99, -99, 4.6])
  const clamped = serverWeather.getSyncPayload().wind
  rig.fire.setWind(clamped)
  runTo(rig, rig.clock.tick + 60)
  say(`  setWind([99,-99,4.6]) clamps to ${JSON.stringify(clamped)} -> fire wind [${rig.fire.wind.join(',')}]`)
  if (rig.fire.wind.join(',') !== clamped.join(',')) failures.push(`section 6: the clamped weather wind ${JSON.stringify(clamped)} reached the fire as [${rig.fire.wind.join(',')}]`)
  if (clamped.some(c => Math.abs(c) > FIRE_MAX_WIND_COMPONENT)) failures.push(`section 6: ServerWeather handed the fire ${JSON.stringify(clamped)}, outside the +-${FIRE_MAX_WIND_COMPONENT} rail`)

  const gustSpec = { seed: 61, amplitude: 7, periodSteps: 3 }
  const gustField = createWindField(gustSpec)
  const coupled = makeFire({ ...BASE, windField: gustSpec }, 'authority')
  coupled.fire.igniteCell(HOME_FACE, HALF, HALF, 3)
  coupled.fire.setWind(clamped)
  runTo(coupled, 200)
  const step = coupled.fire.world.kernel.stepIndex
  const want = expectedWind(clamped, gustField, step)
  say(`  weather ${JSON.stringify(clamped)} over a gust field, at step ${step}: fire wind [${coupled.fire.wind.join(',')}] vs recomputed [${want.join(',')}]`)
  if (coupled.fire.wind.join(',') !== want.join(',')) failures.push(`section 6: weather plus gust gave [${coupled.fire.wind.join(',')}], recomputed [${want.join(',')}]`)
}

say('')
say('== 7. a peer that joins late from a keyframe lands on the same wind ==')
{
  const gustSpec = { seed: 71, amplitude: 11, periodSteps: 5 }
  const spec = { ...BASE, wind: [-6, 0, 4], windField: gustSpec }
  const authority = makeFire(spec, 'authority')
  authority.fire.igniteCell(HOME_FACE, HALF, HALF, 3)
  runTo(authority, 300)
  const keyframe = authority.fire.keyframeMessage()
  const joiner = makeFire(spec, 'mirror')
  joiner.clock.tick = 300
  const adopt = joiner.fire.applyRemote(keyframe)
  let cursor = 0
  for (let t = 301; t <= 600; t++) {
    runTo(authority, t)
    const fresh = authority.broadcasts.slice(cursor)
    cursor = authority.broadcasts.length
    for (const m of fresh) joiner.fire.applyRemote(m)
    runTo(joiner, t)
  }
  const aStep = authority.fire.world.kernel.stepIndex
  const jStep = joiner.fire.world.kernel.stepIndex
  say(`  authority tick ${authority.clock.tick} step ${aStep} wind [${authority.fire.wind.join(',')}] checksum ${authority.fire.checksum()}`)
  say(`  joiner from the tick-${keyframe.k[0]} keyframe (${JSON.stringify(adopt.adopted)}) step ${jStep} wind [${joiner.fire.wind.join(',')}] checksum ${joiner.fire.checksum()}`)
  if (aStep !== jStep) failures.push(`section 7: the late joiner is at step ${jStep} against the authority's ${aStep}`)
  if (authority.fire.wind.join(',') !== joiner.fire.wind.join(',')) failures.push(`section 7: late joiner wind [${joiner.fire.wind.join(',')}] vs authority [${authority.fire.wind.join(',')}]`)
  if (authority.fire.checksum() !== joiner.fire.checksum()) failures.push(`section 7: late joiner checksum ${joiner.fire.checksum()} vs authority ${authority.fire.checksum()}`)
  if (joiner.fire.needsResync) failures.push('section 7: the late joiner asked for a resync after adopting a keyframe')
}

say('')
say('== 8. degenerate wind input is refused at the spec boundary ==')
{
  const cases = [
    ['fractional component', { wind: [1.5, 0, 0] }],
    ['past the rail', { wind: [17, 0, 0] }],
    ['two components', { wind: [1, 0] }],
    ['NaN component', { wind: [NaN, 0, 0] }],
    ['wind not an array', { wind: 'breeze' }],
    ['amplitude past the rail', { windField: { amplitude: 17 } }],
    ['amplitude zero', { windField: { amplitude: 0 } }],
    ['fractional amplitude', { windField: { amplitude: 4.5 } }],
    ['period below one', { windField: { periodSteps: 0 } }],
    ['windField an array', { windField: [1, 2, 3] }],
    ['fractional seed', { windField: { seed: 1.5 } }],
  ]
  let refused = 0
  for (const [label, patch] of cases) {
    let message = 'ACCEPTED'
    try { makeFire({ ...BASE, ...patch }, 'authority') } catch (e) { message = e.message; refused++ }
    const short = message === 'ACCEPTED' ? message : message.slice(0, 90)
    say(`  ${label.padEnd(24)}: ${short}`)
  }
  if (refused !== cases.length) failures.push(`section 8: ${cases.length - refused} of ${cases.length} degenerate wind spec(s) were accepted`)

  const rig = makeFire({ ...BASE, windField: { seed: 81, amplitude: 5, periodSteps: 2 } }, 'authority')
  rig.fire.igniteCell(HOME_FACE, HALF, HALF, 3)
  runTo(rig, 40)
  let threw = 0
  for (const bad of [[1.5, 0, 0], [17, 0, 0], [NaN, 0, 0], 'breeze', [1, 0], null]) {
    try { rig.fire.setWind(bad); say(`  setWind(${JSON.stringify(bad)}): ACCEPTED`) } catch (e) { threw++ }
  }
  say(`  setWind refused ${threw} of 6 bad vector(s) at the fire boundary`)
  if (threw !== 6) failures.push(`section 8: setWind accepted ${6 - threw} of 6 invalid vector(s)`)
}

say('')
say('== wind coupling witness complete ==')
if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL ${f}`)
  say(`RESULT: FAIL (${failures.length} check(s))`)
  process.exit(1)
}
say(`RESULT: PASS -- weather wind plus a seed+step gust is one clamped wind, identical on every peer`)
