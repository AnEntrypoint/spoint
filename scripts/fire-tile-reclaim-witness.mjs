import { createPlanetFrame } from '../src/terrain/PlanetFrame.js'
import { VEG } from '../src/terrain/VegPlacement.js'
import { latticeFor } from '../src/terrain/PlacementChart.js'
import { createFireLattice } from '../src/shared/fire/fireLattice.js'
import { createFireKernel, FIRE_EVENT } from '../src/shared/fire/fireKernel.js'
import { defineFire } from '../src/behaviours/fire.js'
import { encodeFireKeyframe, decodeFireKeyframe } from '../src/shared/fire/fireKeyframe.js'

function say(line) { console.log(line) }

let failures = 0
function expect(ok, line) { if (!ok) { failures++; say(`  FAIL ${line}`) } }

const HOME_FACE = 2
const PATCH_REACH = 40
const PATCH_SPACING = 40
const FIRES = 20
const REGROW_STEPS = 30
const MAX_TILES = 4096

function build(regrowSteps, windowSteps = 5, extra = null) {
  const sampler = {
    radius: 63600,
    heightAt(dir) { return 150 * Math.sin(dir[0] * 11) * Math.cos(dir[2] * 11) + 60 * Math.sin(dir[1] * 17 + dir[0] * 5) },
  }
  const frame = createPlanetFrame({ sampler, anchorDir: [0, 1, 0], offsetY: 0, reliefScale: 0.01 })
  const lattice = createFireLattice(latticeFor(frame, VEG), 2)
  const clock = { tick: 0 }
  const ctx = {
    time: { get tick() { return clock.tick }, get deltaTime() { return 1 / 60 }, get elapsed() { return clock.tick / 60 } },
    players: { broadcast: () => {}, send: () => {}, getAll: () => [] },
    world: { sendToEntity: () => {}, applyImpulse: () => {} },
    terrainHeightAt: () => 40,
    seaLevelAt: () => 0,
    terrainKindAt: () => 'soil',
  }
  const fire = defineFire({
    stepTicks: 10, maxTiles: MAX_TILES, maxActiveCells: 262144, softActiveCells: 131072, windowSteps,
    regrowSteps, seed: 5, leadTicks: 4, checksumEverySteps: 1, rewind: true, role: 'authority',
    ...(extra === null ? {} : extra),
  }, ctx, () => frame, () => null, () => null)
  return { fire, kernel: fire.world.kernel, clock, lattice, half: Math.floor(lattice.cellsPerFace / 2), span: Math.floor(lattice.cellsPerFace / 6) }
}

function runTo(clock, fire, t) { while (clock.tick < t) { clock.tick++; fire.tick(1 / 60) } }

function ignitePatch(fire, half, centreI, centreJ) {
  let cells = 0
  for (let dI = -PATCH_REACH; dI <= PATCH_REACH; dI += PATCH_SPACING) {
    for (let dJ = -PATCH_REACH; dJ <= PATCH_REACH; dJ += PATCH_SPACING) {
      if (fire.igniteCell(HOME_FACE, half + centreI + dI, half + centreJ + dJ, 1) !== null) cells++
    }
  }
  return cells
}

function drownAndRegrow(clock, fire, kernel, cap) {
  let ticks = 0
  let peak = kernel.tileCount
  let freeSeen = kernel.freeTileCount
  const note = () => {
    if (kernel.tileCount > peak) peak = kernel.tileCount
    if (kernel.freeTileCount > freeSeen) freeSeen = kernel.freeTileCount
  }
  runTo(clock, fire, clock.tick + 200)
  note()
  fire.setRain(255)
  while (kernel.activeCount > 0 && ticks++ < cap) {
    runTo(clock, fire, clock.tick + 1)
    note()
  }
  fire.setRain(0)
  let regrowTicks = 0
  while (kernel.scarCount > 0 && regrowTicks++ < cap) { runTo(clock, fire, clock.tick + 1); note() }
  let settleTicks = 0
  while (kernel.scarCount === 0 && kernel.liveTileCount > 0 && settleTicks++ < cap) { runTo(clock, fire, clock.tick + 1); note() }
  return { ticks: ticks + regrowTicks + settleTicks + 200, burnTicks: ticks, regrowTicks, settleTicks, peak, freeSeen }
}

const gcNow = typeof globalThis.gc === 'function' ? globalThis.gc : null
function heapUsed() { if (gcNow === null) return null; gcNow(); gcNow(); return process.memoryUsage().heapUsed }

say('== 1. per-tile reclamation: 20 successive fires return every tile slot ==')
const { fire, kernel, clock, half, span } = build(REGROW_STEPS)
const heapStart = heapUsed()
let leaked = 0, worstWater = 0, ignited = 0, totalTicks = 0
let withoutReclaim = 0, withoutTiles = 0
const perFire = []
for (let f = 0; f < FIRES; f++) {
  const centreI = ((f % 5) - 2) * span
  const centreJ = (Math.floor(f / 5) - 1) * span
  const peak = kernel.tileCount
  ignited += ignitePatch(fire, half, centreI, centreJ)
  const w = drownAndRegrow(clock, fire, kernel, 3000)
  totalTicks += w.ticks
  const live = kernel.liveTileCount
  if (live !== 0) leaked++
  if (w.peak > worstWater) worstWater = w.peak
  if (w.freeSeen === 0) withoutReclaim++
  if (w.peak === 0) withoutTiles++
  perFire.push(`${peak}->${live}`)
}
const heapEnd = heapUsed()
say(`  ${FIRES} fires at disjoint patches, ${ignited} ignition point(s): tile slots before->after each fire ${perFire.join(' ')}`)
say(`  fires that left a live tile behind: ${leaked}, high-water tile slots ${worstWater} of ${MAX_TILES}, deniedTiles ${kernel.stats.deniedTiles}`)
say(`  ${totalTicks} ticks of burning, drowning, regrowing and settling, ${heapEnd === null ? 'heap not sampled without --expose-gc' : `heap delta ${heapEnd - heapStart} B`}, live ${kernel.liveTileCount} of ${kernel.tileCount} slots at the end`)
expect(ignited === FIRES * 9, `${ignited} of ${FIRES * 9} ignition points accepted`)
expect(withoutTiles === 0, `${withoutTiles} fire(s) never allocated a tile slot`)
expect(withoutReclaim === 0, `${withoutReclaim} fire(s) never put a slot on the free list, so per-tile reclaim never ran and the 0 below would be the whole-field reset`)
expect(leaked === 0, `${leaked} fire(s) left a live tile behind`)
expect(worstWater > 0 && worstWater < MAX_TILES, `high-water tile slots ${worstWater} of ${MAX_TILES}`)
expect(kernel.stats.deniedTiles === 0, `${kernel.stats.deniedTiles} tile allocation(s) denied`)

say('== 2. slots are freed one tile at a time, while other tiles are still held ==')
const two = build(REGROW_STEPS)
ignitePatch(two.fire, two.half, -two.span, 0)
runTo(two.clock, two.fire, two.clock.tick + 200)
ignitePatch(two.fire, two.half, two.span, 0)
runTo(two.clock, two.fire, two.clock.tick + 200)
const beforeRain = two.kernel.liveTileCount
two.fire.setRain(255)
let guard = 0
while (two.kernel.activeCount > 0 && guard++ < 3000) runTo(two.clock, two.fire, two.clock.tick + 1)
two.fire.setRain(0)
say(`  two patches ${2 * two.span} cells apart: ${beforeRain} live tile(s) while both burned, ${two.kernel.scarCount} scar(s) after the rain`)
let sawSplit = 0
for (let s = 0; s < 8; s++) {
  runTo(two.clock, two.fire, two.clock.tick + 150)
  const live = two.kernel.liveTileCount, free = two.kernel.freeTileCount
  if (live > 0 && free > 0) sawSplit++
  say(`  +${(s + 1) * 150} ticks: live ${live}, free slots ${free}, scars ${two.kernel.scarCount}`)
}
say(`  checks where free slots and live tiles coexisted: ${sawSplit} of 8 (a whole-field reset would free them all at once)`)
expect(beforeRain > 0, `the two patches held ${beforeRain} live tile(s) before the rain`)
expect(sawSplit >= 1, `free slots and live tiles never coexisted (${sawSplit} of 8), which is what a whole-field reset looks like`)

say('== 3. a tile held by a scar is not freed, and is freed the step the scar regrows ==')
const held = build(1000000)
ignitePatch(held.fire, held.half, 0, 0)
const hw = drownAndRegrow(held.clock, held.fire, held.kernel, 3000)
say(`  regrowSteps 1000000: ${held.kernel.liveTileCount} live tile(s) and ${held.kernel.scarCount} scar(s) after ${hw.ticks} ticks (the scar holds them)`)
const freed = build(REGROW_STEPS)
ignitePatch(freed.fire, freed.half, 0, 0)
const fw = drownAndRegrow(freed.clock, freed.fire, freed.kernel, 3000)
say(`  regrowSteps ${REGROW_STEPS}: ${freed.kernel.liveTileCount} live tile(s) and ${freed.kernel.scarCount} scar(s) after ${fw.ticks} ticks (freed as they regrew)`)
expect(held.kernel.liveTileCount > 0 && held.kernel.scarCount > 0, `a scar that never regrows must hold its tile, got ${held.kernel.liveTileCount} live tile(s) and ${held.kernel.scarCount} scar(s)`)
expect(hw.freeSeen === 0, `${hw.freeSeen} slot(s) reached the free list although no scar ever regrew`)
expect(freed.kernel.liveTileCount === 0 && freed.kernel.scarCount === 0, `regrown scars must release every tile, got ${freed.kernel.liveTileCount} live tile(s) and ${freed.kernel.scarCount} scar(s)`)
expect(fw.freeSeen > 0, `the regrowing fire released no slot to the free list`)

say('== 4. rewind across a reclaim: a kernel that rewinds over reclaimed slots matches one that never did ==')
const rw = build(REGROW_STEPS, 64)
for (let f = 0; f < 2; f++) ignitePatch(rw.fire, rw.half, (f === 0 ? -1 : 1) * rw.span, 0)
const sums = new Map()
let maxFree = 0, firstReclaim = -1
for (let i = 0; i < 800; i++) {
  runTo(rw.clock, rw.fire, rw.clock.tick + 1)
  if (i === 200) rw.fire.setRain(255)
  if (i === 300) rw.fire.setRain(0)
  if (rw.kernel.freeTileCount > 0 && firstReclaim < 0) firstReclaim = rw.clock.tick
  if (rw.kernel.freeTileCount > maxFree) maxFree = rw.kernel.freeTileCount
  if (rw.clock.tick % 10 === 0) sums.set(rw.clock.tick, rw.kernel.checksum())
}
const endTick = rw.clock.tick
const snaps = rw.fire.world.timeline.snapshotTicks.filter(t => sums.has(t)).sort((a, b) => a - b)
const markAt = target => { let best = -1; for (const t of snaps) if (t <= target && t > best) best = t; return best }
const marks = [...new Set([markAt(firstReclaim - 30), markAt(firstReclaim + 120), snaps[snaps.length - 1]])].filter(t => t > 0 && t < endTick)
say(`  ${sums.size} boundary checksums over ${endTick} ticks, ${maxFree} slot(s) reclaimed at the high-water mark, first reclaimed at tick ${firstReclaim}`)
let bad = 0
for (const t of marks) {
  const r = rw.fire.world.timeline.rewindTo(t)
  const rewound = rw.kernel.checksum()
  rw.clock.tick = t
  runTo(rw.clock, rw.fire, endTick)
  const replayed = rw.kernel.checksum()
  const ok = r.ok && rewound === sums.get(t) && replayed === sums.get(endTick)
  if (!ok) bad++
  say(`  rewind to ${t} (${t < firstReclaim ? 'before' : 'after'} the first reclaim): ok ${r.ok}, checksum ${rewound} vs ${sums.get(t)}, replayed to ${endTick} ${replayed} vs ${sums.get(endTick)} ${ok ? 'OK' : 'MISMATCH'}`)
}
say(`  ${marks.length - bad} of ${marks.length} rewinds bit-equal to the straight run`)
expect(sums.size > 1, `${sums.size} boundary checksums recorded`)
expect(new Set(sums.values()).size > 1, `all ${sums.size} boundary checksums are identical, so a rewind comparison cannot see a change`)
expect(maxFree > 0 && firstReclaim > 0, `${maxFree} slot(s) reclaimed, first at tick ${firstReclaim}`)
expect(marks.length >= 2, `${marks.length} rewind mark(s), need at least one each side of the first reclaim`)
expect(bad === 0, `${bad} of ${marks.length} rewinds diverged from the straight run`)

say('== 5. determinism: two independent runs of the same scenario agree step for step ==')
function scenarioChecksums() {
  const run = build(REGROW_STEPS)
  const out = []
  let last = run.kernel.stepIndex
  for (let f = 0; f < 3; f++) {
    ignitePatch(run.fire, run.half, (f - 1) * run.span, 0)
    runTo(run.clock, run.fire, run.clock.tick + 200)
    run.fire.setRain(255)
    let g = 0
    while (run.kernel.activeCount > 0 && g++ < 3000) {
      runTo(run.clock, run.fire, run.clock.tick + 1)
      if (run.kernel.stepIndex !== last) { last = run.kernel.stepIndex; out.push(run.kernel.checksum()) }
    }
    run.fire.setRain(0)
    g = 0
    while (run.kernel.scarCount > 0 && g++ < 3000) {
      runTo(run.clock, run.fire, run.clock.tick + 1)
      if (run.kernel.stepIndex !== last) { last = run.kernel.stepIndex; out.push(run.kernel.checksum()) }
    }
  }
  return out
}
const a = scenarioChecksums()
const b = scenarioChecksums()
let disagree = 0
for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) disagree++
say(`  ${a.length} vs ${b.length} step checksums, ${disagree} disagreement(s), final ${a[a.length - 1]} vs ${b[b.length - 1]}`)
expect(a.length > 0 && a.length === b.length, `${a.length} vs ${b.length} step checksums sampled`)
expect(new Set(a).size > 1, `all ${a.length} step checksums are identical, so the comparison cannot see a divergence`)
expect(disagree === 0, `${disagree} of ${Math.min(a.length, b.length)} step checksums disagreed`)

say('== 6. a rewind that drops tile slots leaves no reclaim pointing at a slot the kernel no longer holds ==')
const host = build(REGROW_STEPS)
const rawClasses = [
  { igniteHeat: 0, burnRate: 0, heatOut: 0, fuel: 0, spotChance: 0, spotHeat: 0, smoke: 0, damage: 0 },
  { igniteHeat: 90, burnRate: 1500, heatOut: 500, fuel: 3000, spotChance: 0, spotHeat: 0, smoke: 40, damage: 6 },
]
const at = ((host.half >> 3) << 3) + 7
const bare = createFireKernel({
  lattice: host.lattice, fuelClassAt: (face, I, J) => (((I >> 3) + (J >> 3)) & 1) === 0 ? 1 : 0,
  classes: rawClasses, seed: 5, stepTicks: 10, maxTiles: MAX_TILES,
  softActiveCells: 131072, maxActiveCells: 262144, regrowSteps: REGROW_STEPS, undo: true,
})
const empty = bare.takeDelta()
bare.queueEvent({ kind: FIRE_EVENT.IGNITE, tick: 10, face: HOME_FACE, I: at, J: at, id: 1 })
for (let t = 10; t <= 12; t++) bare.tick(t)
const grown = bare.tileCount
bare.undoDelta(empty)
const dropped = bare.tileCount
const resumeAt = performance.now()
for (let t = 20; t <= 60; t++) bare.tick(t)
const resumeMs = performance.now() - resumeAt
say(`  ${grown} tile slot(s) grown from one ignition, ${dropped} after the rewind, ${resumeMs.toFixed(1)} ms to tick on from there: tileCount ${bare.tileCount}, live ${bare.liveTileCount}, active ${bare.activeCount}`)
expect(grown > 0, `the fast-burning fire held ${grown} tile slot(s) before the rewind`)
expect(dropped === 0, `the rewind left ${dropped} tile slot(s) live, so it never dropped one a reclaim was still pointing at`)
expect(resumeMs < 5000, `40 ticks after the rewind took ${resumeMs.toFixed(1)} ms`)

say('== 7. a tampered keyframe is rejected at the decode boundary instead of parsed into tiles ==')
const kf = build(REGROW_STEPS)
ignitePatch(kf.fire, kf.half, 0, 0)
runTo(kf.clock, kf.fire, kf.clock.tick + 120)
const wire = encodeFireKeyframe({ tick: kf.clock.tick, snapshot: kf.kernel.snapshot() })
const HEADER_BYTES = 24
const HASH_SEED = 0x811c9dc5, HASH_PRIME = 0x01000193
function fnv1a(bytes) {
  let h = HASH_SEED
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, HASH_PRIME) }
  return h >>> 0
}
function reseal(bytes) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(12, fnv1a(bytes.subarray(HEADER_BYTES)), true)
  return bytes
}
const good = decodeFireKeyframe(wire)
const sealed = decodeFireKeyframe(reseal(Uint8Array.from(wire)))
say(`  ${wire.byteLength} B keyframe decodes to ${good.snapshot.tileCount} tile(s), and re-sealing its own checksum still decodes to ${sealed.snapshot.tileCount}`)
expect(good.snapshot.tileCount > 0, `the encoded keyframe carries ${good.snapshot.tileCount} tile(s)`)
expect(sealed.snapshot.tileCount === good.snapshot.tileCount, `re-sealing the checksum changed the decode from ${good.snapshot.tileCount} to ${sealed.snapshot.tileCount} tiles`)
let rejected = 0, accepted = 0, crashed = 0
const crashes = []
for (const value of [0x7fffffff, 255, 6]) {
  for (let off = 0; off + 4 <= wire.byteLength; off += 4) {
    const copy = Uint8Array.from(wire)
    new DataView(copy.buffer, copy.byteOffset, copy.byteLength).setUint32(off, value, true)
    try {
      decodeFireKeyframe(reseal(copy))
      accepted++
    } catch (e) {
      const message = String(e && e.message)
      if (message.startsWith('[fireKeyframe]')) rejected++
      else { crashed++; if (crashes.length < 3) crashes.push(message) }
    }
  }
}
say(`  ${rejected + accepted + crashed} tampered keyframes (every 4-byte word resealed to 0x7fffffff, 255 and 6): ${rejected} rejected with a named fireKeyframe error, ${accepted} accepted, ${crashed} failing with anything else ${crashes.join(' | ')}`)
expect(rejected > 0, `no tampered keyframe was rejected, so the decode boundary was never exercised`)
expect(crashed === 0, `${crashed} tampered keyframe(s) failed with something other than a named fireKeyframe rejection: ${crashes.join(' | ')}`)
const badFace = kf.kernel.snapshot()
badFace.tileFace[0] = 6
let faceReject = null
try { decodeFireKeyframe(encodeFireKeyframe({ tick: kf.clock.tick, snapshot: badFace })) } catch (e) { faceReject = String(e && e.message) }
say(`  a tile face of 6 (no cube face, not the free sentinel) is rejected: ${faceReject}`)
expect(faceReject !== null, `a keyframe carrying cube face 6 decoded without complaint`)
const sentinelFace = kf.kernel.snapshot()
sentinelFace.tileFace[0] = 255
const sentinel = decodeFireKeyframe(encodeFireKeyframe({ tick: kf.clock.tick, snapshot: sentinelFace }))
say(`  the free-tile sentinel still decodes: ${sentinel.snapshot.tileCount} tile(s), face of tile 0 ${sentinel.snapshot.tileFace[0]}`)
expect(sentinel.snapshot.tileFace[0] === 255, `the decoded free-tile sentinel reads ${sentinel.snapshot.tileFace[0]}`)

if (failures > 0) { say(`${failures} check(s) failed`); process.exitCode = 1 }
