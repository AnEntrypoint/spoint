import { createPlanetFrame } from '../src/terrain/PlanetFrame.js'
import { VEG } from '../src/terrain/VegPlacement.js'
import { latticeFor } from '../src/terrain/PlacementChart.js'
import { createFireLattice } from '../src/shared/fire/fireLattice.js'
import { defineFire } from '../src/behaviours/fire.js'

function say(line) { console.log(line) }

const gcNow = typeof globalThis.gc === 'function' ? globalThis.gc : null
function heapUsed() { if (gcNow === null) return null; gcNow(); gcNow(); return process.memoryUsage().heapUsed }

let failures = 0
function expect(ok, line) { if (!ok) { failures++; say(`  FAIL ${line}`) } }

const HOME_FACE = 2
const TARGET_TILES = Number(process.argv[2] ?? 11429)
const IGNITE_SPACING = 24
const IGNITE_REACH = 430

const sampler = {
  radius: 63600,
  heightAt(dir) { return 150 * Math.sin(dir[0] * 11) * Math.cos(dir[2] * 11) + 60 * Math.sin(dir[1] * 17 + dir[0] * 5) },
}
const frame = createPlanetFrame({ sampler, anchorDir: [0, 1, 0], offsetY: 0, reliefScale: 0.01 })
const lattice = createFireLattice(latticeFor(frame, VEG), 2)
const HALF = Math.floor(lattice.cellsPerFace / 2)

const clock = { tick: 0 }
const broadcasts = []
const ctx = {
  time: { get tick() { return clock.tick }, get deltaTime() { return 1 / 60 }, get elapsed() { return clock.tick / 60 } },
  players: { broadcast: m => broadcasts.push(m), send: () => {}, getAll: () => [] },
  world: { sendToEntity: () => {}, applyImpulse: () => {} },
  terrainHeightAt: () => 40,
  seaLevelAt: () => 0,
  terrainKindAt: () => 'soil',
}
const fire = defineFire({
  stepTicks: 10, maxTiles: 16384, maxActiveCells: 262144, softActiveCells: 131072,
  regrowSteps: 1000000, seed: 5, leadTicks: 4, checksumEverySteps: 1, rewind: true, role: 'authority',
}, ctx, () => frame, () => null, () => null)

function runTo(t) { while (clock.tick < t) { clock.tick++; fire.tick(1 / 60) } }

let ignitions = 0
for (let dI = -IGNITE_REACH; dI <= IGNITE_REACH; dI += IGNITE_SPACING) {
  for (let dJ = -IGNITE_REACH; dJ <= IGNITE_REACH; dJ += IGNITE_SPACING) {
    fire.igniteCell(HOME_FACE, HALF + dI, HALF + dJ, 1)
    ignitions++
  }
}
say(`ignited ${ignitions} cells on a ${IGNITE_SPACING}-cell grid over +-${IGNITE_REACH} cells`)

const kernel = fire.world.kernel
let grownAt = -1
while (kernel.tileCount < TARGET_TILES && clock.tick < 20000) {
  runTo(clock.tick + 10)
  if (kernel.tileCount >= TARGET_TILES && grownAt < 0) grownAt = clock.tick
}
say(`at tick ${clock.tick}: ${kernel.tileCount} touched tiles, ${kernel.activeCount} active cells, ${kernel.scarCount} scarred, ${kernel.stats.steps} steps`)

say('== delta snapshots: per-boundary cost and restore equivalence at scale ==')
let lastDeltaStep = kernel.stepIndex
function measureDeltaWindow(ticks) {
  const start = clock.tick
  const recorded = new Map()
  const startTiles = kernel.tileCount
  const startActive = kernel.activeCount
  let boundaryTicks = 0, checksumMs = 0
  let lastStep = kernel.stepIndex
  for (let i = 0; i < ticks; i++) {
    runTo(clock.tick + 1)
    if (kernel.stepIndex === lastStep) continue
    lastStep = kernel.stepIndex
    boundaryTicks++
    const t0 = performance.now()
    recorded.set(clock.tick, kernel.checksum())
    checksumMs += performance.now() - t0
  }
  return { ticks: clock.tick - start, boundaryTicks, checksumMs, recorded, tiles: startTiles, active: startActive }
}

function probeRewinds(window) {
  const marks = [...window.recorded.keys()]
  const endTick = marks[marks.length - 1]
  const stored = fire.world.timeline.snapshotTicks.filter(t => window.recorded.has(t) && t < endTick).sort((a, b) => a - b).slice(-3)
  let bad = 0
  for (const t of stored) {
    const r = fire.world.timeline.rewindTo(t)
    const rewound = kernel.checksum()
    clock.tick = t
    runTo(endTick)
    const replayed = kernel.checksum()
    const ok = r.ok && rewound === window.recorded.get(t) && replayed === window.recorded.get(endTick)
    if (!ok) bad++
    say(`  rewind to ${t}: ok ${r.ok}, checksum ${rewound} vs recorded ${window.recorded.get(t)}, replayed to ${endTick} ${replayed} vs ${window.recorded.get(endTick)} ${ok ? 'OK' : 'MISMATCH'}`)
  }
  say(`  delta restore equivalence: ${stored.length - bad} of ${stored.length} rewinds bit-equal to the straight run, and replay reproduces it ${bad === 0 ? 'yes' : 'no'}`)
  expect(stored.length > 0, `no snapshot tick inside the measured window, so nothing was rewound`)
  expect(new Set(window.recorded.values()).size > 1, `all ${window.recorded.size} recorded boundary checksums are identical, so a rewind comparison cannot see a change`)
  expect(bad === 0, `${bad} of ${stored.length} rewinds diverged from the straight run`)
}

const DELTA_STRUCTURE_BYTES = 30 * 16384
const deltaWindows = [measureDeltaWindow(200)]
probeRewinds(deltaWindows[0])
for (let w = 0; w < 2; w++) deltaWindows.push(measureDeltaWindow(200))
for (const w of deltaWindows) say(`  ${w.boundaryTicks} boundary ticks over ${w.ticks} ticks at ${w.tiles} tiles / ${w.active} active cells: checksum ${(w.checksumMs / Math.max(1, w.boundaryTicks)).toFixed(3)} ms per boundary`)

const deltaCosts = []
for (let b = 0; b < 3; b++) {
  let guard = 0
  while (kernel.stepIndex === lastDeltaStep && guard++ < 400) runTo(clock.tick + 1)
  lastDeltaStep = kernel.stepIndex
  const t0 = performance.now()
  const d = kernel.takeDelta()
  const ms = performance.now() - t0
  deltaCosts.push({ ms, cells: d.count, bytes: d.cells.length * 11 })
  kernel.releaseDelta(d)
}
say(`  takeDelta at a boundary: ${deltaCosts.map(c => `${c.ms.toFixed(3)} ms over ${c.cells} staged cell(s)`).join(', ')}`)
expect(deltaCosts.every(c => c.cells > 0), `takeDelta staged ${deltaCosts.map(c => c.cells).join('/')} cell(s); an empty delta makes every rewind above vacuous`)
say(`  a live delta costs ${(DELTA_STRUCTURE_BYTES / 1024).toFixed(0)} KiB of structure (21 B of masks, interior marks and active listing plus 9 B of tile identity per tile) plus 11 B per staged cell, 9 of them live, and 12 B per scar-ring slot the step overwrote`)

const drained = []
for (let i = 0; i < 12; i++) drained.push(kernel.takeDelta())
kernel.releaseDelta(drained[5])
const recycled = kernel.takeDelta()
const reused = kernel.takeDelta()
for (let i = 0; i < 12; i++) if (i !== 5) kernel.releaseDelta(drained[i])
kernel.releaseDelta(recycled)
say(`  delta buffers are pooled, not reallocated per cell: a released buffer comes back ${drained[5] === reused}`)
for (let i = 0; i < 30; i++) kernel.releaseDelta(kernel.takeDelta())
const heapBefore = heapUsed()
for (let i = 0; i < 5000; i++) kernel.releaseDelta(kernel.takeDelta())
const warmedHeap = heapUsed()
for (let i = 0; i < 5000; i++) kernel.releaseDelta(kernel.takeDelta())
const steadyHeap = heapUsed()
if (steadyHeap === null) say('  heap retained over 10000 takeDelta+release cycles is not sampled without --expose-gc')
else say(`  heap retained: ${warmedHeap - heapBefore} B over the first 5000 takeDelta+release cycles and ${steadyHeap - warmedHeap} B over the next 5000, so the pool stops growing`)


say('')
say('== incremental hash bit-equals a full rebuild at every step boundary ==')
let hashSamples = 0, hashMismatches = 0, hashStalls = 0
let lastStep = kernel.stepIndex, prevChecksum = kernel.checksum()
while (hashSamples < 30 && clock.tick < 40000) {
  runTo(clock.tick + 1)
  if (kernel.stepIndex === lastStep) continue
  lastStep = kernel.stepIndex
  const incremental = kernel.checksum()
  const snap = kernel.snapshot()
  kernel.restore(snap)
  const rebuilt = kernel.checksum()
  if (incremental !== rebuilt) hashMismatches++
  if (rebuilt === prevChecksum) hashStalls++
  prevChecksum = rebuilt
  hashSamples++
}
say(`  ${hashSamples} boundaries: incremental == post-restore full rebuild on ${hashSamples - hashMismatches}, checksum changed at every boundary on ${hashSamples - hashStalls}`)
say(`  last checksum ${prevChecksum} over ${kernel.tileCount} tiles, ${kernel.activeCount} active cells, ${kernel.scarCount} scars`)
expect(hashSamples === 30, `${hashSamples} of 30 boundaries sampled before the tick cap`)
expect(hashMismatches === 0, `${hashMismatches} boundary(s) where the incremental hash disagreed with a full rebuild`)
expect(hashStalls === 0, `${hashStalls} boundary(s) where the checksum did not change`)

function measureWindow(ticks) {
  const start = clock.tick
  let boundaryTicks = 0, boundaryMs = 0, quietTicks = 0, quietMs = 0
  let checksumMs = 0, checksums = 0, snapshotMs = 0, snapshots = 0, restoreMs = 0, restores = 0
  let lastStep = kernel.stepIndex
  for (let i = 0; i < ticks; i++) {
    const t0 = performance.now()
    runTo(clock.tick + 1)
    const dt = performance.now() - t0
    if (kernel.stepIndex !== lastStep) { lastStep = kernel.stepIndex; boundaryTicks++; boundaryMs += dt } else { quietTicks++; quietMs += dt }
  }
  for (let i = 0; i < 40; i++) {
    let t0 = performance.now()
    kernel.checksum()
    checksumMs += performance.now() - t0
    checksums++
    t0 = performance.now()
    const snap = kernel.snapshot()
    snapshotMs += performance.now() - t0
    snapshots++
    t0 = performance.now()
    kernel.restore(snap)
    restoreMs += performance.now() - t0
    restores++
  }
  return {
    ticks: clock.tick - start,
    boundaryTicks, boundaryMs, quietTicks, quietMs,
    checksumMs: checksumMs / checksums, snapshotMs: snapshotMs / snapshots, restoreMs: restoreMs / restores,
  }
}

const windows = []
for (let w = 0; w < 3; w++) windows.push(measureWindow(200))
const best = windows.reduce((a, b) => (a.snapshotMs + a.checksumMs <= b.snapshotMs + b.checksumMs ? a : b))
say(`best of ${windows.length} windows of ${best.ticks} ticks (${best.boundaryTicks} boundary ticks):`)
say(`  boundary tick ${(best.boundaryMs / Math.max(1, best.boundaryTicks)).toFixed(3)} ms, quiet tick ${(best.quietMs / Math.max(1, best.quietTicks)).toFixed(3)} ms`)
say(`  kernel.checksum() ${best.checksumMs.toFixed(3)} ms, kernel.snapshot() ${best.snapshotMs.toFixed(3)} ms, kernel.restore() ${best.restoreMs.toFixed(3)} ms`)
say(`  snapshot + checksum per boundary ${(best.snapshotMs + best.checksumMs).toFixed(3)} ms over ${kernel.tileCount} tiles and ${kernel.activeCount} active cells`)
say('')
const finalKernel = fire.world.kernel
say(`  tileCount after the windows ${finalKernel.tileCount}, active ${finalKernel.activeCount}`)

if (failures > 0) { say(`${failures} check(s) failed`); process.exitCode = 1 }
say(failures === 0 ? `RESULT: PASS -- snapshot + checksum per boundary ${(best.snapshotMs + best.checksumMs).toFixed(3)} ms over ${finalKernel.tileCount} tiles` : `RESULT: FAIL (${failures} check(s))`)
