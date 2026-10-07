import { createPlanetFrame } from '../src/terrain/PlanetFrame.js'
import { VEG } from '../src/terrain/VegPlacement.js'
import { latticeFor } from '../src/terrain/PlacementChart.js'
import { createFireLattice } from '../src/shared/fire/fireLattice.js'
import { defineFire } from '../src/behaviours/fire.js'
import { createServerWeather } from '../src/sdk/ServerWeather.js'
import { FIRE_EVENT } from '../src/shared/fire/fireKernel.js'
import { FIRE_WIRE_TYPE } from '../src/shared/fire/fireWire.js'
import { ensurePacked, pack, unpack } from '../src/protocol/msgpack.js'
import { MSG, WIRE_PROTOCOL_VERSION } from '../src/protocol/MessageTypes.js'

const sampler = {
  radius: 63600,
  heightAt(dir) { return 150 * Math.sin(dir[0] * 11) * Math.cos(dir[2] * 11) + 60 * Math.sin(dir[1] * 17 + dir[0] * 5) },
}
const frame = createPlanetFrame({ sampler, anchorDir: [0, 1, 0], offsetY: 0, reliefScale: 0.01 })
const lattice = createFireLattice(latticeFor(frame, VEG), 2)

const HOME_FACE = 2
const HALF = Math.floor(lattice.cellsPerFace / 2)
const HOME_I = HALF
const HOME_J = HALF

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

function frontExtent(kernel, wind) {
  const snap = kernel.snapshot()
  const w = lattice.windInFaceAxes(HOME_FACE, wind[0], wind[1], wind[2], [0, 0])
  const horiz = Math.abs(w[0]) >= Math.abs(w[1])
  const sign = horiz ? (w[0] === 0 ? 1 : Math.sign(w[0])) : Math.sign(w[1])
  let down = 0, up = 0, cells = 0
  for (let i = 0; i < snap.scarCount; i++) {
    const g = snap.scar[i * 2]
    const t = g >> 6
    if (snap.tileFace[t] !== HOME_FACE) continue
    cells++
    const dI = ((snap.tileI[t] << 3) + (g & 7)) - HOME_I
    const dJ = ((snap.tileJ[t] << 3) + ((g >> 3) & 7)) - HOME_J
    const along = horiz ? dI * sign : dJ * sign
    if (along > down) down = along
    if (-along > up) up = -along
  }
  return { down, up, cells, faceWind: [w[0], w[1]] }
}

const BASE = { stepTicks: 10, regrowSteps: 400, seed: 7, leadTicks: 6, checksumEverySteps: 5, rewind: true }

await ensurePacked

say('== 1. ServerWeather carries an authoritative wind vector ==')
const weatherConfig = { serverAuthoritative: true, type: 'clear', intensity: 0, wind: [3, 0, -2] }
const serverWeather = createServerWeather(() => weatherConfig)
const disabledWeather = createServerWeather(() => ({ serverAuthoritative: false, type: 'rain', intensity: 0.5, wind: [1, 2, 3] }))
const firstPayload = serverWeather.getSyncPayload()
const firstBroadcast = serverWeather.shouldBroadcast()
const secondBroadcast = serverWeather.shouldBroadcast()
const windSet = serverWeather.setWind([8, 0, 0])
const windPayload = serverWeather.getSyncPayload()
const windSetAgain = serverWeather.setWind([8, 0, 0])
const clampSet = serverWeather.setWind([99, -99, 4.6])
const clampPayload = serverWeather.getSyncPayload()
const badSet = serverWeather.setWind('nope')
const badPayload = serverWeather.getSyncPayload()
const disabledEnabled = disabledWeather.isEnabled()
const disabledSet = disabledWeather.setWind([5, 0, 0])
const disabledPayload = disabledWeather.getSyncPayload()
const stateSet = serverWeather.setState('rain', 0.4, [0, 0, 6])
const statePayload = serverWeather.getSyncPayload()
say(`  enabled ${serverWeather.isEnabled()}, first payload ${JSON.stringify(firstPayload)}, broadcast pending ${firstBroadcast}, again ${secondBroadcast}`)
say(`  setWind([8,0,0]) -> ${windSet}, payload ${JSON.stringify(windPayload)}, setWind([8,0,0]) again -> ${windSetAgain}`)
say(`  setWind([99,-99,4.6]) -> ${clampSet}, clamped payload ${JSON.stringify(clampPayload)}`)
say(`  setWind('nope') -> ${badSet}, payload ${JSON.stringify(badPayload)}`)
say(`  disabled: isEnabled ${disabledEnabled}, setWind([5,0,0]) -> ${disabledSet}, payload ${JSON.stringify(disabledPayload)}`)
say(`  setState('rain', 0.4, [0,0,6]) -> ${stateSet}, payload ${JSON.stringify(statePayload)}`)
const windEq = (p, v) => Array.isArray(p?.wind) && p.wind.join(',') === v.join(',')
if (serverWeather.isEnabled() !== true) failures.push(`section 1: a serverAuthoritative weather block reported isEnabled ${serverWeather.isEnabled()}`)
if (!windEq(firstPayload, [3, 0, -2])) failures.push(`section 1: the first payload carried wind ${JSON.stringify(firstPayload?.wind)}, expected [3,0,-2]`)
if (firstBroadcast !== true || secondBroadcast !== false) failures.push(`section 1: shouldBroadcast returned ${firstBroadcast} then ${secondBroadcast}, expected one pending broadcast and then none`)
if (windSet !== true || !windEq(windPayload, [8, 0, 0])) failures.push(`section 1: setWind([8,0,0]) returned ${windSet} and left wind ${JSON.stringify(windPayload?.wind)}`)
if (windSetAgain !== false) failures.push(`section 1: setting the same wind again returned ${windSetAgain}, expected false for a no-op`)
if (clampSet !== true || !windEq(clampPayload, [16, -16, 5])) failures.push(`section 1: setWind([99,-99,4.6]) returned ${clampSet} and left wind ${JSON.stringify(clampPayload?.wind)}, expected the clamped [16,-16,5]`)
if (badSet !== false || !windEq(badPayload, [16, -16, 5])) failures.push(`section 1: setWind('nope') returned ${badSet} and left wind ${JSON.stringify(badPayload?.wind)}, expected false and no change`)
if (disabledEnabled !== false || disabledSet !== false) failures.push(`section 1: a non-authoritative weather block reported isEnabled ${disabledEnabled} and setWind ${disabledSet}, expected both false`)
if (!windEq(disabledPayload, [0, 0, 0])) failures.push(`section 1: the disabled payload carried wind ${JSON.stringify(disabledPayload?.wind)}, expected [0,0,0]`)
if (stateSet !== true || statePayload.type !== 'rain' || statePayload.intensity !== 0.4 || !windEq(statePayload, [0, 0, 6])) failures.push(`section 1: setState('rain',0.4,[0,0,6]) returned ${stateSet} and left ${JSON.stringify(statePayload)}`)

say('')
say('== 2. a wind field derived from seed and step: integer only, identical on two peers ==')
const fieldSpec = { ...BASE, windField: { seed: 7, amplitude: 16, periodSteps: 7 } }
const fieldAuthority = makeFire(fieldSpec, 'authority')
fieldAuthority.fire.igniteCell(HOME_FACE, HOME_I, HOME_J, 3)
const fieldMirror = makeFire(fieldSpec, 'authority')
fieldMirror.fire.igniteCell(HOME_FACE, HOME_I, HOME_J, 3)
const fieldSamples = []
runSteps(fieldAuthority, 10, step => { if (fieldSamples.length < 10) fieldSamples.push(`step ${step}: [${fieldAuthority.fire.wind.join(',')}]`) })
say(`  authority wind per step: ${fieldSamples.join(' | ')}`)
runTo(fieldMirror, fieldAuthority.clock.tick)
say(`  authority at tick ${fieldAuthority.clock.tick}: step ${fieldAuthority.fire.world.kernel.stepIndex} wind [${fieldAuthority.fire.wind.join(',')}] checksum ${fieldAuthority.fire.checksum()}`)
say(`  second host, same spec, ticking from 0: step ${fieldMirror.fire.world.kernel.stepIndex} wind [${fieldMirror.fire.wind.join(',')}] checksum ${fieldMirror.fire.checksum()}`)
if (fieldAuthority.fire.checksum() !== fieldMirror.fire.checksum()) failures.push(`section 2: two peers on the same wind field disagree, ${fieldAuthority.fire.checksum()} vs ${fieldMirror.fire.checksum()}`)
if (fieldAuthority.fire.wind.join(',') !== fieldMirror.fire.wind.join(',')) failures.push(`section 2: wind [${fieldAuthority.fire.wind.join(',')}] vs [${fieldMirror.fire.wind.join(',')}] at the same step`)
const integerOnly = fieldSamples.every(s => s.split('[')[1].split(']')[0].split(',').every(c => Number.isInteger(+c)))
say(`  every sampled component is an integer: ${integerOnly}`)
if (fieldSamples.length === 0) failures.push('section 2: no wind sample was taken')
if (!integerOnly) failures.push('section 2: a sampled wind component is not an integer')

say('')
say('== 3. wind biases the front: downwind reach vs upwind reach ==')
for (const wind of [[12, 0, 0], [0, 0, 0]]) {
  const rig = makeFire({ ...BASE, wind }, 'authority')
  rig.fire.igniteCell(HOME_FACE, HOME_I, HOME_J, 3)
  runSteps(rig, 24, () => {})
  const kernel = rig.fire.world.kernel
  const extent = frontExtent(kernel, rig.fire.wind)
  const ratio = extent.up === 0 ? Infinity : extent.down / extent.up
  say(`  wind [${wind.join(',')}] -> face wind [${extent.faceWind.join(',')}], ${extent.cells} scarred cells, downwind ${extent.down} cells, upwind ${extent.up} cells, ratio ${ratio === Infinity ? 'inf' : ratio.toFixed(2)}, step ${kernel.stepIndex}, checksum ${rig.fire.checksum()}`)
  if (extent.cells === 0) failures.push(`section 3: wind [${wind.join(',')}] scarred no cell, so the front bias was never observed`)
  const still = wind[0] === 0 && wind[1] === 0 && wind[2] === 0
  if (still && Math.abs(extent.down - extent.up) > 1) failures.push(`section 3: wind [${wind.join(',')}] should spread evenly but reached ${extent.down} downwind vs ${extent.up} upwind`)
  if (!still && extent.down <= extent.up) failures.push(`section 3: wind [${wind.join(',')}] reached ${extent.down} downwind and ${extent.up} upwind, so the front is not biased downwind`)
}

say('')
say('== 4. rain from the weather halts the front; clear resumes it on unburnt fuel ==')
const weatherState = { type: 'clear', intensity: 0, wind: [10, 0, 0] }
const rainSpec = { ...BASE, weather: { source: () => weatherState } }
const authority = makeFire(rainSpec, 'authority')
const mirror = makeFire(rainSpec, 'mirror')
authority.fire.igniteCell(HOME_FACE, HOME_I, HOME_J, 3)
let cursor = 0
const wireRainRows = []
function deliver() {
  const fresh = authority.broadcasts.slice(cursor)
  cursor = authority.broadcasts.length
  for (const m of fresh) {
    for (const row of m.e ?? []) if (row[0] === FIRE_EVENT.RAIN) wireRainRows.push(row)
    mirror.fire.applyRemote(m)
  }
}
function runBoth(steps, onStep) {
  const first = kernel.stepIndex
  let last = first
  const limit = authority.clock.tick + steps * 400 + 400
  while (kernel.stepIndex < first + steps && authority.clock.tick < limit) {
    runTo(authority, authority.clock.tick + 1)
    deliver()
    runTo(mirror, authority.clock.tick)
    if (kernel.stepIndex !== last) { last = kernel.stepIndex; onStep(last) }
  }
}
const kernel = authority.fire.world.kernel
let prevIgnitions = kernel.stats.ignitions
function measure(steps) {
  const out = []
  runBoth(steps, step => { out.push(`${step}:+${kernel.stats.ignitions - prevIgnitions}`); prevIgnitions = kernel.stats.ignitions })
  return out
}
runBoth(12, () => {})
prevIgnitions = kernel.stats.ignitions
const beforeRain = measure(4)
say(`  clear sky, new ignitions per step: ${beforeRain.join(' ')}`)
weatherState.type = 'rain'
weatherState.intensity = 1
const afterRain = measure(10)
const firstZeroIndex = afterRain.findIndex(s => s.endsWith(':+0'))
say(`  rain ${weatherState.intensity} -> rain byte rows ${JSON.stringify(wireRainRows.slice(0, 2))} (${wireRainRows.length} row(s), ${wireRainRows.length > 0 ? pack({ type: FIRE_WIRE_TYPE, e: [wireRainRows[0]] }).byteLength : 0} B on the msgpack wire), new ignitions per step: ${afterRain.join(' ')}`)
say(`  first step with no new ignition: ${firstZeroIndex < 0 ? 'none' : afterRain[firstZeroIndex]} (${firstZeroIndex + 1} step(s) after the rain event), active cells ${kernel.activeCount}`)
say(`  mirror at the same tick: step ${mirror.fire.world.kernel.stepIndex} checksum ${mirror.fire.checksum()} vs authority ${authority.fire.checksum()}, needsResync ${mirror.fire.needsResync}`)
if (mirror.fire.checksum() !== authority.fire.checksum()) failures.push(`section 4: the mirror diverged mid-rain, ${mirror.fire.checksum()} vs authority ${authority.fire.checksum()}`)
if (mirror.fire.needsResync) failures.push('section 4: the mirror that was fed every row asked for a resync')
weatherState.type = 'clear'
weatherState.intensity = 0
const afterClear = measure(6)
say(`  clear again, moisture ${authority.fire.weather.moisture}, rain byte ${authority.fire.weather.rain}: ${afterClear.join(' ')} (${kernel.activeCount} active cells)`)
const freshCell = [HOME_FACE, HOME_I + 60, HOME_J + 60]
authority.fire.igniteCell(freshCell[0], freshCell[1], freshCell[2], 4)
deliver()
runTo(mirror, authority.clock.tick)
const afterReignite = measure(6)
say(`  a fresh ignition on unburnt fuel after the rain: ${afterReignite.join(' ')}`)
say(`  mirror followed the whole weather run: checksum ${mirror.fire.checksum()} vs authority ${authority.fire.checksum()}, needsResync ${mirror.fire.needsResync}`)
const stepCounts = rows => rows.map(r => Number(r.split(':+')[1]))
const clearCounts = stepCounts(beforeRain)
const rainCounts = stepCounts(afterRain)
const clearAgainCounts = stepCounts(afterClear)
const reigniteCounts = stepCounts(afterReignite)
if (clearCounts.some(n => n <= 0)) failures.push(`section 4: clear sky ran a step with no new ignition (${beforeRain.join(' ')})`)
if (!rainCounts.includes(0)) failures.push(`section 4: heavy rain never halted new ignitions (${afterRain.join(' ')})`)
if (rainCounts.slice(-4).some(n => n !== 0)) failures.push(`section 4: rain was still igniting ${rainCounts.slice(-4).join(',')} cell(s) per step at the end of the rain window, so it never halted the front`)
if (rainCounts[rainCounts.length - 1] >= clearCounts[clearCounts.length - 1]) failures.push(`section 4: the last rain step ignited ${rainCounts[rainCounts.length - 1]} cell(s), not fewer than the last clear step's ${clearCounts[clearCounts.length - 1]}`)
if (clearAgainCounts.some(n => n !== 0)) failures.push(`section 4: clearing the sky alone restarted ignition while moisture was still ${authority.fire.weather.moisture} (${afterClear.join(' ')})`)
if (reigniteCounts.some((n, i) => i > 0 && n < reigniteCounts[i - 1])) failures.push(`section 4: a fresh ignition on unburnt fuel did not grow monotonically (${afterReignite.join(' ')})`)
if (reigniteCounts[reigniteCounts.length - 1] <= reigniteCounts[0]) failures.push(`section 4: a fresh ignition on unburnt fuel stalled at ${reigniteCounts.join(',')} new cell(s) per step`)
if (mirror.fire.checksum() !== authority.fire.checksum()) failures.push(`section 4: the mirror diverged over the weather run, ${mirror.fire.checksum()} vs authority ${authority.fire.checksum()}`)
if (mirror.fire.needsResync) failures.push('section 4: the mirror that was fed every row ended the run needing a resync')

say('')
say('== 5. two peers that start ticking at different ticks agree at the same step with a varying wind field ==')
const lateSpec = { ...BASE, windField: { seed: 11, amplitude: 16, periodSteps: 5 }, weather: { source: () => weatherState } }
const lateAuthority = makeFire(lateSpec, 'authority')
lateAuthority.fire.igniteCell(HOME_FACE, HOME_I, HOME_J, 3)
runTo(lateAuthority, 300)
const lateKeyframe = lateAuthority.fire.keyframeMessage()
const lateJoiner = makeFire(lateSpec, 'mirror')
lateJoiner.clock.tick = 300
const lateAdopt = lateJoiner.fire.applyRemote(lateKeyframe)
let lateCursor = 0
for (let t = 301; t <= 600; t++) {
  runTo(lateAuthority, t)
  const fresh = lateAuthority.broadcasts.slice(lateCursor)
  lateCursor = lateAuthority.broadcasts.length
  for (const m of fresh) lateJoiner.fire.applyRemote(m)
  runTo(lateJoiner, t)
}
const lateKernel = lateAuthority.fire.world.kernel
say(`  authority: tick ${lateAuthority.clock.tick} step ${lateKernel.stepIndex} wind [${lateAuthority.fire.wind.join(',')}] checksum ${lateAuthority.fire.checksum()}`)
say(`  joiner that started ticking at tick 300 from the tick-${lateKeyframe.k[0]} keyframe (${JSON.stringify(lateAdopt.adopted)}): step ${lateJoiner.fire.world.kernel.stepIndex} wind [${lateJoiner.fire.wind.join(',')}] checksum ${lateJoiner.fire.checksum()}`)
if (lateAuthority.fire.checksum() !== lateJoiner.fire.checksum()) failures.push(`section 5: a peer that started ticking at tick 300 disagrees at tick ${lateAuthority.clock.tick}, ${lateJoiner.fire.checksum()} vs authority ${lateAuthority.fire.checksum()}`)
if (lateKernel.stepIndex !== lateJoiner.fire.world.kernel.stepIndex) failures.push(`section 5: step ${lateJoiner.fire.world.kernel.stepIndex} on the late joiner vs ${lateKernel.stepIndex} on the authority`)
if (lateAuthority.fire.wind.join(',') !== lateJoiner.fire.wind.join(',')) failures.push(`section 5: wind [${lateJoiner.fire.wind.join(',')}] on the late joiner vs [${lateAuthority.fire.wind.join(',')}] on the authority`)
const aExtent = frontExtent(lateKernel, lateAuthority.fire.wind)
const jExtent = frontExtent(lateJoiner.fire.world.kernel, lateJoiner.fire.wind)
say(`  front at the same step: authority downwind ${aExtent.down}/upwind ${aExtent.up} over ${aExtent.cells} cells, joiner downwind ${jExtent.down}/upwind ${jExtent.up} over ${jExtent.cells} cells`)
if (aExtent.cells === 0 || jExtent.cells === 0) failures.push(`section 5: front extent sampled ${aExtent.cells} authority cell(s) and ${jExtent.cells} joiner cell(s)`)
if (aExtent.down !== jExtent.down || aExtent.up !== jExtent.up || aExtent.cells !== jExtent.cells) failures.push(`section 5: front extent authority ${aExtent.down}/${aExtent.up} over ${aExtent.cells} vs joiner ${jExtent.down}/${jExtent.up} over ${jExtent.cells}`)
const windRows = lateAuthority.broadcasts.filter(m => Array.isArray(m.e)).flatMap(m => m.e).filter(row => row[0] === FIRE_EVENT.WIND)
say(`  wind events on the wire during that run: ${windRows.length} (a seed+step field needs none), weather events total ${lateAuthority.broadcasts.filter(m => Array.isArray(m.e)).flatMap(m => m.e).filter(row => row[0] === FIRE_EVENT.WIND || row[0] === FIRE_EVENT.RAIN || row[0] === FIRE_EVENT.MOISTURE).length}`)

say('')
say('== 6. the WEATHER_SYNC wind is an additive field: old payloads and old readers still work ==')
const legacyShape = { type: 'clear', intensity: 0 }
const legacy = makeFire({ ...BASE, wind: [6, 0, 0], weather: { source: () => legacyShape } }, 'authority')
legacy.fire.igniteCell(HOME_FACE, HOME_I, HOME_J, 3)
runTo(legacy, 200)
const legacyRows = legacy.broadcasts.filter(m => Array.isArray(m.e)).flatMap(m => m.e)
say(`  old payload {type,intensity} with no wind: fire wind [${legacy.fire.wind.join(',')}] (the spec wind [6,0,0] is kept), WIND rows ${legacyRows.filter(r => r[0] === FIRE_EVENT.WIND).length}, checksum ${legacy.fire.checksum()}`)
const modernShape = { type: 'clear', intensity: 0, wind: [6, 0, 0] }
const modern = makeFire({ ...BASE, weather: { source: () => modernShape } }, 'authority')
modern.fire.igniteCell(HOME_FACE, HOME_I, HOME_J, 3)
runTo(modern, 200)
const modernRows = modern.broadcasts.filter(m => Array.isArray(m.e)).flatMap(m => m.e).filter(r => r[0] === FIRE_EVENT.WIND)
say(`  new payload with wind [6,0,0]: fire wind [${modern.fire.wind.join(',')}], WIND rows ${JSON.stringify(modernRows.slice(0, 1))} (${modernRows.length} row(s))`)
const roundTrip = unpack(pack({ type: 'rain', intensity: 0.5, wind: [3, -4, 5] }))
const oldRoundTrip = unpack(pack({ type: 'rain', intensity: 0.5 }))
say(`  a wind-bearing payload still reads as an old one: type ${roundTrip.type}, intensity ${roundTrip.intensity} (extra key wind ${JSON.stringify(roundTrip.wind)})`)
say(`  an old payload carries no wind key: ${JSON.stringify(oldRoundTrip)}`)
say(`  WIRE_PROTOCOL_VERSION ${WIRE_PROTOCOL_VERSION} unchanged, WEATHER_SYNC 0x${MSG.WEATHER_SYNC.toString(16)}`)
if (legacy.fire.wind.join(',') !== '6,0,0') failures.push(`section 6: an old payload with no wind key left the fire at wind [${legacy.fire.wind.join(',')}], expected the spec wind [6,0,0]`)
if (modern.fire.wind.join(',') !== '6,0,0') failures.push(`section 6: a payload carrying wind [6,0,0] left the fire at [${modern.fire.wind.join(',')}]`)
if (modernRows.length === 0) failures.push('section 6: a payload carrying wind produced no WIND row on the fire wire')
if (roundTrip.wind?.join(',') !== '3,-4,5') failures.push(`section 6: a wind-bearing payload round-tripped as wind ${JSON.stringify(roundTrip.wind)}, expected [3,-4,5]`)
if (roundTrip.type !== 'rain' || roundTrip.intensity !== 0.5) failures.push(`section 6: a wind-bearing payload round-tripped as ${JSON.stringify(roundTrip)}, expected type rain and intensity 0.5`)
if ('wind' in oldRoundTrip) failures.push(`section 6: an old payload with no wind round-tripped with a wind key: ${JSON.stringify(oldRoundTrip)}`)

say('')
say('== weather witness complete ==')
if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL ${f}`)
  say(`RESULT: FAIL (${failures.length} check(s))`)
  process.exit(1)
}
say('RESULT: PASS -- wind, rain and moisture drive the fire and stay additive on the wire')
