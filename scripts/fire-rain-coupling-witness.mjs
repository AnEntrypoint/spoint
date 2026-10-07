import { createPlanetFrame } from '../src/terrain/PlanetFrame.js'
import { VEG } from '../src/terrain/VegPlacement.js'
import { latticeFor } from '../src/terrain/PlacementChart.js'
import { createFireLattice } from '../src/shared/fire/fireLattice.js'
import { defineFire } from '../src/behaviours/fire.js'
import { DEFAULT_FIRE_WEATHER } from '../src/behaviours/fireSpec.js'

const sampler = {
  radius: 63600,
  heightAt(dir) { return 150 * Math.sin(dir[0] * 11) * Math.cos(dir[2] * 11) + 60 * Math.sin(dir[1] * 17 + dir[0] * 5) },
}
const frame = createPlanetFrame({ sampler, anchorDir: [0, 1, 0], offsetY: 0, reliefScale: 0.01 })
const lattice = createFireLattice(latticeFor(frame, VEG), 2)

const HOME_FACE = 2
const HOME_I = Math.floor(lattice.cellsPerFace / 2)
const HOME_J = HOME_I
const WIND = [6, 0, 0]
const STEPS = 40
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8]
const INTENSITIES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]
const SHIPPED_INTENSITY = 0.6
const TPS_GAME_PINNED_PER_INTENSITY = 200
const PINNED_INTENSITIES = [0, 0.6, 1]

const failures = []
const say = line => console.log(line)
const push = line => { failures.push(line) }

function makeRig(weatherState, seed, perIntensity = DEFAULT_FIRE_WEATHER.rainPerIntensity) {
  const clock = { tick: 0 }
  const ctx = {
    time: { get tick() { return clock.tick }, get deltaTime() { return 1 / 60 }, get elapsed() { return clock.tick / 60 } },
    players: { broadcast: () => {}, send: () => {}, getAll: () => [] },
    world: { sendToEntity: () => {}, applyImpulse: () => {} },
    terrainHeightAt: () => 0,
    seaLevelAt: () => 0,
    terrainKindAt: () => 'soil',
  }
  const spec = {
    stepTicks: 10, regrowSteps: 400, seed, leadTicks: 6, checksumEverySteps: 5, rewind: true,
    weather: { rainPerIntensity: perIntensity, source: () => weatherState },
  }
  const fire = defineFire(spec, ctx, () => frame, () => null, () => null)
  return { clock, fire }
}

function runSteps(rig, steps, onStep) {
  const kernel = rig.fire.world.kernel
  const first = kernel.stepIndex
  let last = first
  const limit = rig.clock.tick + steps * 400 + 400
  while (kernel.stepIndex < first + steps && rig.clock.tick < limit) {
    rig.clock.tick++
    rig.fire.tick(1 / 60)
    if (kernel.stepIndex !== last) { last = kernel.stepIndex; onStep(last) }
  }
}

function frontExtent(kernel, wind) {
  const snap = kernel.snapshot()
  const w = lattice.windInFaceAxes(HOME_FACE, wind[0], wind[1], wind[2], [0, 0])
  const horiz = Math.abs(w[0]) >= Math.abs(w[1])
  const dirsign = horiz ? (w[0] === 0 ? 1 : Math.sign(w[0])) : Math.sign(w[1])
  let down = 0, up = 0, cells = 0
  for (let i = 0; i < snap.scarCount; i++) {
    const g = snap.scar[i * 2]
    const t = g >> 6
    if (snap.tileFace[t] !== HOME_FACE) continue
    cells++
    const dI = ((snap.tileI[t] << 3) + (g & 7)) - HOME_I
    const dJ = ((snap.tileJ[t] << 3) + ((g >> 3) & 7)) - HOME_J
    const along = horiz ? dI * dirsign : dJ * dirsign
    if (along > down) down = along
    if (-along > up) up = -along
  }
  return { down, up, cells, span: down + up }
}

function weatherOf(intensity, wind) {
  return { type: intensity > 0 ? 'rain' : 'clear', intensity, wind }
}

function sweep(intensity, perIntensity) {
  const rig = makeRig(weatherOf(intensity, WIND), 7, perIntensity)
  const kernel = rig.fire.world.kernel
  rig.fire.igniteCell(HOME_FACE, HOME_I, HOME_J, 3)
  let peakActive = 0
  let liveSteps = 0
  let rainByte = 0
  let moistureEnd = 0
  let moistureAtTen = 0
  runSteps(rig, STEPS, step => {
    const snap = kernel.snapshot()
    rainByte = snap.rain
    moistureEnd = snap.moisture
    if (step === 10) moistureAtTen = snap.moisture
    if (kernel.activeCount > 0) liveSteps++
    if (kernel.activeCount > peakActive) peakActive = kernel.activeCount
  })
  const extent = frontExtent(kernel, rig.fire.wind)
  return {
    intensity, rainByte, moistureAtTen, moistureEnd, peakActive, liveSteps,
    ignitions: kernel.stats.ignitions, burnt: kernel.scarCount,
    span: extent.span, reach: extent.down, cells: extent.cells,
  }
}

function burnStepsOf(intensity, perIntensity) {
  const perSeed = []
  for (const seed of SEEDS) {
    const rig = makeRig(weatherOf(intensity, [0, 0, 0]), seed, perIntensity)
    const kernel = rig.fire.world.kernel
    rig.fire.igniteCell(HOME_FACE, HOME_I, HOME_J, 3)
    let ignitedAt = -1
    let burntAt = -1
    runSteps(rig, 16, step => {
      const cell = kernel.cellState(HOME_FACE, HOME_I, HOME_J)
      if (cell.state === 1 && ignitedAt < 0) ignitedAt = step
      if (cell.state === 2 && ignitedAt >= 0 && burntAt < 0) burntAt = step
    })
    perSeed.push(burntAt >= 0 ? burntAt - ignitedAt : -1)
  }
  return perSeed
}

function establishOf(intensity, perIntensity) {
  const perSeed = []
  for (const seed of SEEDS) {
    const rig = makeRig(weatherOf(intensity, WIND), seed, perIntensity)
    const kernel = rig.fire.world.kernel
    rig.fire.igniteCell(HOME_FACE, HOME_I, HOME_J, 3)
    runSteps(rig, 20, () => {})
    perSeed.push(kernel.stats.ignitions)
  }
  return perSeed
}

const mean = list => list.reduce((a, b) => a + b, 0) / list.length
const fmt = v => (Number.isFinite(v) ? v.toFixed(2) : String(v))

say('== fire rain coupling witness (real kernel, real defineFire, real weather source) ==')
say(`  rainPerIntensity ${DEFAULT_FIRE_WEATHER.rainPerIntensity}, wetPerStep ${DEFAULT_FIRE_WEATHER.wetPerStep}, dryPerStep ${DEFAULT_FIRE_WEATHER.dryPerStep}, maxMoisture ${DEFAULT_FIRE_WEATHER.maxMoisture}`)
say('')

const rows = INTENSITIES.map(i => sweep(i))
say('  intensity  rainByte  moist@10  moist@40  peakActive  liveSteps  ignitions  burnt  span  reach  cells')
for (const r of rows) {
  say(`  ${r.intensity.toFixed(1)}        ${String(r.rainByte).padStart(4)}      ${String(r.moistureAtTen).padStart(4)}      ${String(r.moistureEnd).padStart(4)}      ${String(r.peakActive).padStart(6)}       ${String(r.liveSteps).padStart(4)}      ${String(r.ignitions).padStart(5)}    ${String(r.burnt).padStart(4)}   ${String(r.span).padStart(4)}   ${String(r.reach).padStart(4)}   ${String(r.cells).padStart(4)}`)
}
say('')

const clear = rows[0]
const shipped = rows.find(r => Math.abs(r.intensity - SHIPPED_INTENSITY) < 1e-9)
const heavy = rows[rows.length - 1]

say('== 1. the rain byte is the honest linear image of the weather intensity ==')
for (const r of rows) {
  const expected = Math.round(r.intensity * DEFAULT_FIRE_WEATHER.rainPerIntensity)
  if (r.rainByte !== expected) push(`section 1: intensity ${r.intensity} produced rain byte ${r.rainByte}, expected ${expected}`)
}
const byteList = rows.map(r => r.rainByte)
const ascending = byteList.every((v, i) => i === 0 || v > byteList[i - 1])
say(`  rain bytes ${byteList.join(' ')}: strictly ascending ${ascending}`)
if (!ascending) push(`section 1: the rain byte is not strictly ascending in intensity (${byteList.join(' ')})`)
say(`  shipped intensity ${SHIPPED_INTENSITY} -> rain byte ${shipped.rainByte}`)

say('')
say('== 2. clear weather establishes a front ==')
say(`  peak active ${clear.peakActive}, ignitions ${clear.ignitions}, burnt ${clear.burnt} cell(s), front span ${clear.span} cell(s), downwind reach ${clear.reach}`)
if (clear.peakActive === 0) push('section 2: clear weather produced no active cell, so no baseline front exists')
if (clear.span < 8) push(`section 2: clear weather front span ${clear.span} cell(s), expected at least 8`)

say('')
say('== 3. moderate rain (the shipped 0.6) slows and shrinks the front but still sustains one ==')
say(`  peak active ${shipped.peakActive} vs clear ${clear.peakActive} (${fmt(shipped.peakActive / clear.peakActive)} of clear), span ${shipped.span} vs ${clear.span} (${fmt(shipped.span / clear.span)}), ignitions ${shipped.ignitions} vs ${clear.ignitions}`)
if (shipped.peakActive === 0) push(`section 3: rain ${SHIPPED_INTENSITY} left peak active cells at 0, so the shipped weather nullifies fire`)
if (shipped.span === 0) push(`section 3: rain ${SHIPPED_INTENSITY} produced no front at all (span 0 cell(s))`)
if (shipped.liveSteps < clear.liveSteps) push(`section 3: rain ${SHIPPED_INTENSITY} kept fire alive for ${shipped.liveSteps} step(s) vs ${clear.liveSteps} clear, so it shortened the fire instead of only slowing it`)
if (shipped.peakActive < clear.peakActive * 0.25) push(`section 3: rain ${SHIPPED_INTENSITY} peak active ${shipped.peakActive} is under a quarter of the clear ${clear.peakActive}, so the shipped weather still nullifies fire`)
if (shipped.burnt < clear.burnt * 0.25) push(`section 3: rain ${SHIPPED_INTENSITY} burnt ${shipped.burnt} cell(s), under a quarter of the clear ${clear.burnt}`)
if (shipped.peakActive > clear.peakActive) push(`section 3: rain ${SHIPPED_INTENSITY} grew the fire (peak ${shipped.peakActive} vs clear ${clear.peakActive}), so rain is not suppressing`)
if (shipped.burnt > clear.burnt) push(`section 3: rain ${SHIPPED_INTENSITY} burnt ${shipped.burnt} cell(s) vs clear ${clear.burnt}, so rain is not suppressing`)

say('')
say('== 4. heavy rain suppresses the front ==')
say(`  peak active ${heavy.peakActive} vs clear ${clear.peakActive} (${fmt(heavy.peakActive / clear.peakActive)}), span ${heavy.span} vs ${clear.span} (${fmt(heavy.span / clear.span)}), moisture ${heavy.moistureEnd}`)
if (heavy.burnt > clear.burnt * 0.1) push(`section 4: rain 1.0 burnt ${heavy.burnt} cell(s), more than a tenth of the clear ${clear.burnt}, so heavy rain is not suppressing`)
if (heavy.peakActive > clear.peakActive * 0.5) push(`section 4: rain 1.0 peak active ${heavy.peakActive} is more than half the clear ${clear.peakActive}, so heavy rain is not suppressing`)
if (heavy.burnt > shipped.burnt) push(`section 4: rain 1.0 burnt ${heavy.burnt} cell(s) vs ${shipped.burnt} at rain ${SHIPPED_INTENSITY}, so more rain burns more`)

say('')
say('== 4b. suppression is monotone in intensity: more rain never spreads fire further ==')
for (let i = 1; i < rows.length; i++) {
  const prev = rows[i - 1], cur = rows[i]
  if (cur.burnt > prev.burnt) push(`section 4b: rain ${cur.intensity.toFixed(1)} burnt ${cur.burnt} cell(s), more than rain ${prev.intensity.toFixed(1)}'s ${prev.burnt}`)
  if (cur.peakActive > prev.peakActive) push(`section 4b: rain ${cur.intensity.toFixed(1)} peak active ${cur.peakActive}, more than rain ${prev.intensity.toFixed(1)}'s ${prev.peakActive}`)
}
say(`  burnt area by intensity: ${rows.map(r => r.burnt).join(' ')}`)
say(`  peak active by intensity: ${rows.map(r => r.peakActive).join(' ')}`)
say(`  monotone non-increasing in intensity: ${rows.every((r, i) => i === 0 || (r.burnt <= rows[i - 1].burnt && r.peakActive <= rows[i - 1].peakActive))}`)

say('')
say('== 5. rain does not consume the fuel of a burning cell ==')
const clearBurn = burnStepsOf(0)
const heavyBurn = burnStepsOf(1)
say(`  steps from ignition to burnt over seeds ${SEEDS.join(',')}`)
say(`    clear:   ${clearBurn.join(' ')} -> mean ${fmt(mean(clearBurn))}`)
say(`    rain 1.0: ${heavyBurn.join(' ')} -> mean ${fmt(mean(heavyBurn))}`)
if (clearBurn.some(v => v < 0)) push(`section 5: a seed never reached BURNT under clear weather (${clearBurn.join(' ')})`)
if (heavyBurn.some(v => v < 0)) push(`section 5: a seed never reached BURNT under rain 1.0 (${heavyBurn.join(' ')})`)
if (mean(heavyBurn) < mean(clearBurn) - 0.25) push(`section 5: rain 1.0 burnt a cell out in ${fmt(mean(heavyBurn))} step(s) vs ${fmt(mean(clearBurn))} clear, so rain is consuming fuel instead of suppressing spread`)

say('')
say('== 6. one ignition (what a single shot does) still takes hold at the shipped intensity ==')
const establishClear = establishOf(0)
const establishShipped = establishOf(SHIPPED_INTENSITY)
const establishHeavy = establishOf(1)
const took = list => list.filter(v => v >= 10).length
say(`  ignitions from one cell over 20 steps, seeds ${SEEDS.join(',')}`)
say(`    clear:    ${establishClear.join(' ')} -> ${took(establishClear)}/${SEEDS.length} took hold`)
say(`    rain 0.6: ${establishShipped.join(' ')} -> ${took(establishShipped)}/${SEEDS.length} took hold`)
say(`    rain 1.0: ${establishHeavy.join(' ')} -> ${took(establishHeavy)}/${SEEDS.length} took hold`)
if (took(establishShipped) < SEEDS.length - 1) push(`section 6: only ${took(establishShipped)} of ${SEEDS.length} single ignitions took hold at the shipped rain ${SHIPPED_INTENSITY} (${establishShipped.join(' ')})`)
if (mean(establishShipped) < mean(establishClear) * 0.25) push(`section 6: rain ${SHIPPED_INTENSITY} cut a single ignition to ${fmt(mean(establishShipped))} ignition(s) vs ${fmt(mean(establishClear))} clear, below a quarter of clear`)
if (mean(establishShipped) > mean(establishClear)) push(`section 6: rain ${SHIPPED_INTENSITY} grew a single ignition to ${fmt(mean(establishShipped))} vs ${fmt(mean(establishClear))} clear, so rain is not suppressing`)
if (took(establishHeavy) > 1) push(`section 6: ${took(establishHeavy)} of ${SEEDS.length} single ignitions took hold under rain 1.0 (${establishHeavy.join(' ')}), so heavy rain is not suppressing`)

say('')
say('== 7. the value apps/tps-game/shared.js pins is the one the shipped world runs, so it is swept too ==')
const pinnedRows = PINNED_INTENSITIES.map(i => sweep(i, TPS_GAME_PINNED_PER_INTENSITY))
say(`  rainPerIntensity ${TPS_GAME_PINNED_PER_INTENSITY} (pinned by the tps-game FIRE_SPEC)`)
say('  intensity  rainByte  peakActive  ignitions  burnt  span')
for (const r of pinnedRows) {
  say(`  ${r.intensity.toFixed(1)}        ${String(r.rainByte).padStart(4)}      ${String(r.peakActive).padStart(6)}       ${String(r.ignitions).padStart(5)}    ${String(r.burnt).padStart(4)}   ${String(r.span).padStart(4)}`)
}
const pinnedClear = pinnedRows[0], pinnedShipped = pinnedRows[1], pinnedHeavy = pinnedRows[2]
const pinnedClearBurn = burnStepsOf(0, TPS_GAME_PINNED_PER_INTENSITY)
const pinnedHeavyBurn = burnStepsOf(1, TPS_GAME_PINNED_PER_INTENSITY)
say(`  steps from ignition to burnt: clear ${fmt(mean(pinnedClearBurn))}, rain 1.0 ${fmt(mean(pinnedHeavyBurn))}`)
if (pinnedShipped.peakActive === 0) push(`section 7: the pinned value left rain ${SHIPPED_INTENSITY} at 0 peak active cell(s), so the shipped world still sees no fire`)
if (pinnedShipped.peakActive < pinnedClear.peakActive * 0.25) push(`section 7: the pinned value leaves rain ${SHIPPED_INTENSITY} peak active ${pinnedShipped.peakActive}, under a quarter of the clear ${pinnedClear.peakActive}`)
if (pinnedShipped.burnt < pinnedClear.burnt * 0.25) push(`section 7: the pinned value leaves rain ${SHIPPED_INTENSITY} burnt ${pinnedShipped.burnt} cell(s), under a quarter of the clear ${pinnedClear.burnt}`)
if (pinnedShipped.peakActive > pinnedClear.peakActive) push(`section 7: the pinned value makes rain ${SHIPPED_INTENSITY} grow the fire (peak ${pinnedShipped.peakActive} vs clear ${pinnedClear.peakActive})`)
if (pinnedHeavy.burnt > pinnedShipped.burnt) push(`section 7: the pinned value burns more at rain 1.0 (${pinnedHeavy.burnt}) than at rain ${SHIPPED_INTENSITY} (${pinnedShipped.burnt})`)
if (mean(pinnedHeavyBurn) < mean(pinnedClearBurn) - 0.25) push(`section 7: the pinned value lets rain eat fuel: ${fmt(mean(pinnedHeavyBurn))} step(s) vs ${fmt(mean(pinnedClearBurn))} clear`)

say('')
say('== rain coupling witness complete ==')
if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL ${f}`)
  say(`RESULT: FAIL (${failures.length} check(s))`)
  process.exit(1)
}
say('RESULT: PASS -- rain slows and shrinks the front, never eats the fuel, and the shipped intensity still burns')
