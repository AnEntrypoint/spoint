#!/usr/bin/env node
// Witness: the grass and rock prewarm loops each run as more than one macrotask, so the longest
// block the main thread takes is bounded by one unit of work and a frame runs after it. Row
// PERF-grass-rock-prewarm-slice-96ms-1013.
//
// A frame is one macrotask as far as the main thread is concerned: while a synchronous call runs,
// nothing renders. So the synchronous duration of one unit of prewarm work IS the frame cost, and a
// millisecond slice budget accumulated ACROSS units cannot cut it -- it is checked only BETWEEN
// units, so the block it bounds is the budget plus one more unit, and a unit longer than the budget
// is never cut at all.
//
// client/app.js runs the vegetation, rock and grass prewarm in ONE Promise.all, so they interleave
// on the same main thread and the block the player sees is the worst block across all three. That
// is why this witness reports the Promise.all arm and not only the grass and rock members: fixing
// one member of a Promise.all cannot move the worst block while another still runs a long slice.
//
// The unit is NOT the same for every member, and that is the point. A rock or vegetation chunk is
// about a millisecond of placement, so the chunk is a frame-sized unit and the slice is the chunk. A
// grass chunk is 256 cells of 79 blades -- measured here at tens of milliseconds -- so a chunk-sized
// unit is most of a frame ON ITS OWN and slicing at the chunk would not bound the block. grass
// therefore slices at one step of the chunk's own placement cursor, the incremental loader
// client/core/Grass.js already uses on the streaming path (startInflight / stepInflight). The step's
// budget is read out of Grass.js, so this witness cannot drift from the budget that ships.
//
// What is measured, all of it by running the real code:
//   * one slice of real placement work (createGrassChunkCursor + step / placementsForRockChunk /
//     placementsForChunk) over the 128 m playable disc app.js declares.
//   * the worst synchronous block of the whole Promise.all, in both shapes: the shape being removed
//     (accumulate a 96 ms budget, yield with setTimeout(0) when it trips) and the shipped shape
//     (one slice per macrotaskYield).
//   * the placement counts, over the whole disc and over the near band, and their parity between the
//     two arms, so the slice change cannot deliver its win by shedding placements -- least of all
//     underfoot.
//
// The near band is the 4 chunk(s) whose centre is within 24 m of the focus. The disc is the PLYABLE
// one: each stream's own ring filter can only REMOVE chunks from it, and the accumulated arm's 96 ms
// budget trips on this disc's worth of work either way, so the before figure is not an artefact of
// how many chunks the disc holds.
//
// No per-pass GPU timings: they are invalid on this project. This witness touches no adapter.

import { readFileSync } from 'node:fs'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { macrotaskYield } from '../client/core/macrotaskYield.js'
import { loadWorldModule } from '../src/sdk/WorldLocator.js'
import { resolveTerrainConfig } from '../src/shared/terrainConfig.js'
import { loadPlanetSampler, planetSamplerOptsOf } from '../src/terrain/TerrainPhysics.js'
import { createPlanetFrame } from '../src/terrain/PlanetFrame.js'
import { createCachedAnchorField } from '../src/terrain/ClimateCache.js'
import { latticeFor } from '../src/terrain/PlacementChart.js'
import { placementsForGrassChunk, createGrassChunkCursor, GRASS } from '../src/terrain/GrassPlacement.js'
import { placementsForRockChunk, ROCK } from '../src/terrain/RockPlacement.js'
import { placementsForChunk, VEG } from '../src/terrain/VegPlacement.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TAG = '[grass-rock-prewarm-slice]'
const GRASS_SOURCE = resolve(REPO, 'client', 'core', 'Grass.js')
const ROCKS_SOURCE = resolve(REPO, 'client', 'core', 'Rocks.js')
const APP_SOURCE = resolve(REPO, 'client', 'app.js')

const FRAME_BUDGET_MS = 16.67
// The accumulated budget the row deletes, and the playable radius app.js asks prewarm to cover.
const ACCUMULATED_SLICE_MS = 96
const PLAYABLE_RADIUS_M = 128
const NEAR_BAND_M = 24
// Three passes, best of them: the box this runs on is shared with other lanes, and a spike that
// belongs to the box must not be reported as a spike that belongs to the code.
const PASSES = 3
const WARMUP_CHUNKS = 4

const PASSED = []
const FAILED = []
function check(label, ok, detail) {
  if (ok) { PASSED.push(label); console.log(`  ${TAG} [PASS] ${label} (${detail})`) }
  else { FAILED.push(label); console.log(`  ${TAG} [FAIL] ${label} -- ${detail}`) }
}
const nowMs = () => performance.now()
const r3 = (v) => Math.round(v * 1000) / 1000

function stats(list) {
  if (!list.length) return { n: 0, p50: 0, p95: 0, max: 0, total: 0 }
  const s = list.slice().sort((a, b) => a - b)
  return {
    n: s.length,
    p50: r3(s[s.length >> 1]),
    p95: r3(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]),
    max: r3(s[s.length - 1]),
    total: r3(s.reduce((a, b) => a + b, 0)),
  }
}

await installSpecifierHooks()

let channelsOpened = 0
{
  const RealMessageChannel = globalThis.MessageChannel
  if (typeof RealMessageChannel === 'function') {
    globalThis.MessageChannel = class extends RealMessageChannel {
      constructor() { super(); channelsOpened++ }
    }
  }
}

// -- the unit that ships: the grass chunk placement cursor's step budget, read out of Grass.js ---
const GRASS_SRC = readFileSync(GRASS_SOURCE, 'utf8')
const budgetMatch = GRASS_SRC.match(/grassLoadBudgetMs\)\s*\?\s*cfg\.grassLoadBudgetMs\s*:\s*([0-9.]+)/)
const GRASS_STEP_MS = budgetMatch ? Number(budgetMatch[1]) : NaN
console.log(`${TAG} grass slice unit: one ${GRASS_STEP_MS}ms step of the chunk placement cursor (LOAD_BUDGET read out of client/core/Grass.js)`)
check('the grass slice budget was read out of Grass.js and is itself inside one frame',
  Number.isFinite(GRASS_STEP_MS) && GRASS_STEP_MS > 0 && GRASS_STEP_MS <= FRAME_BUDGET_MS,
  `LOAD_BUDGET=${GRASS_STEP_MS}ms vs ${FRAME_BUDGET_MS}ms frame`)

const loaded = await loadWorldModule(resolve(REPO, 'apps/world/tps-game.js'))
const tcfg = resolveTerrainConfig(loaded)
const sampler = await loadPlanetSampler(planetSamplerOptsOf(tcfg))
const frame = createPlanetFrame({ sampler, anchorDir: tcfg.anchorDir || [0, 1, 0], offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
const anchorField = createCachedAnchorField(sampler.anchorField, frame)
const worldSeed = tcfg.seed | 0

// The same chunk keys the streams' own rings cover, built from the same lattice and the same
// focus: PlacementRing keys chunks by lattice.chunkKeyOfDir(frame.localToDir(x, z)).
function ringKeys(spec) {
  const lattice = latticeFor(frame, spec)
  const side = Math.round((PLAYABLE_RADIUS_M * 2) / spec.CHUNK)
  const keys = []
  const seen = new Set()
  for (let gz = 0; gz < side; gz++) {
    for (let gx = 0; gx < side; gx++) {
      const x = (gx - (side - 1) / 2) * spec.CHUNK
      const z = (gz - (side - 1) / 2) * spec.CHUNK
      const key = lattice.chunkKeyOfDir(...frame.localToDir(x, z))
      if (seen.has(key)) continue
      seen.add(key)
      keys.push({ key, near: Math.max(Math.abs(x), Math.abs(z)) <= NEAR_BAND_M })
    }
  }
  return keys
}

// Grass.js places through ExactPatchFrame.placementFrame, which is a height-cache wrapper around
// this same planet frame; the lattice and the placement arithmetic are the wrapped frame's, so the
// cost measured here is the cost of the shipped placement.
const STREAMS = [
  {
    name: 'grass', spec: GRASS, unit: 'cursor step', budgetMs: GRASS_STEP_MS,
    placeAll: (k) => placementsForGrassChunk(k, frame, anchorField, worldSeed),
    startSlice: (k) => createGrassChunkCursor(k, frame, anchorField, worldSeed, undefined, () => false),
    stepSlice: (c) => c.step(GRASS_STEP_MS),
    sliceCount: (c) => c.blades.length,
  },
  { name: 'rock', spec: ROCK, unit: 'chunk', placeAll: (k) => placementsForRockChunk(k, frame, anchorField, worldSeed) },
  { name: 'veg', spec: VEG, unit: 'chunk', placeAll: (k) => placementsForChunk(k, frame, anchorField, worldSeed) },
]
for (const s of STREAMS) s.keys = ringKeys(s.spec)

// JIT warm-up: the first chunk a cold run places pays for the whole placement module's compile, and
// reporting that as a prewarm cost would be a lie.
for (const s of STREAMS) {
  for (let i = 0; i < WARMUP_CHUNKS && i < s.keys.length; i++) s.placeAll(s.keys[i].key)
  await macrotaskYield()
}

// One ring, one shape. `shape === 'accumulated'` is the shape being removed: accumulate whole-chunk
// costs into a 96 ms budget and yield with setTimeout(0) when it trips. `shape === 'sliced'` is the
// shipped shape: one unit of placement per macrotaskYield, the unit being one step of the grass
// chunk cursor and one whole chunk for rock and vegetation. Every synchronous segment between two
// yields is timed and recorded, so the worst block is measured, not inferred from a budget.
async function runRing(stream, shape, onSegment) {
  const segments = []
  const chunkMs = []
  let placed = 0
  let nearPlaced = 0
  let sliceMs = 0
  let cur = 0
  const flush = () => { if (cur > 0) { segments.push(cur); if (onSegment) onSegment(cur); cur = 0 } }
  for (const { key, near } of stream.keys) {
    if (shape === 'accumulated') {
      const t0 = nowMs()
      const list = stream.placeAll(key)
      const t1 = nowMs()
      const n = list ? list.length : 0
      placed += n
      if (near) nearPlaced += n
      cur += t1 - t0
      sliceMs += t1 - t0
      chunkMs.push(t1 - t0)
      if (sliceMs >= ACCUMULATED_SLICE_MS) { sliceMs = 0; flush(); await new Promise((r) => setTimeout(r, 0)) }
      continue
    }
    let chunk = 0
    if (stream.startSlice) {
      let cursor = stream.startSlice(key)
      // The first step is synchronous, exactly as startInflight() ships it.
      let t0 = nowMs()
      let done = stream.stepSlice(cursor)
      let t1 = nowMs()
      cur += t1 - t0; chunk += t1 - t0
      flush()
      while (!done) {
        await macrotaskYield()
        t0 = nowMs()
        done = stream.stepSlice(cursor)
        t1 = nowMs()
        cur += t1 - t0; chunk += t1 - t0
        flush()
      }
      const n = stream.sliceCount(cursor)
      placed += n
      if (near) nearPlaced += n
    } else {
      const t0 = nowMs()
      const list = stream.placeAll(key)
      const t1 = nowMs()
      const n = list ? list.length : 0
      placed += n
      if (near) nearPlaced += n
      cur += t1 - t0
      chunk += t1 - t0
      flush()
      await macrotaskYield()
    }
    chunkMs.push(chunk)
  }
  flush()
  return { segments, chunkMs, placed, nearPlaced }
}

async function runPromiseAll(shape) {
  const all = []
  const parts = {}
  await Promise.all(STREAMS.map(async (s) => { parts[s.name] = await runRing(s, shape, (v) => all.push(v)) }))
  return { all, parts }
}

const before = { all: [], parts: {}, worst: 0 }
const after = { all: [], parts: {}, worst: 0 }
for (let p = 0; p < PASSES; p++) {
  const b = await runPromiseAll('accumulated')
  const a = await runPromiseAll('sliced')
  for (const s of STREAMS) {
    const nm = s.name
    const bw = Math.max(...b.parts[nm].segments), aw = Math.max(...a.parts[nm].segments)
    if (!before.parts[nm] || bw < before.parts[nm].worst) before.parts[nm] = { worst: r3(bw), ...b.parts[nm] }
    if (!after.parts[nm] || aw < after.parts[nm].worst) after.parts[nm] = { worst: r3(aw), ...a.parts[nm] }
  }
  const bwAll = Math.max(...b.all), awAll = Math.max(...a.all)
  if (!before.all.length || bwAll < before.worst) { before.all = b.all.map(r3); before.worst = r3(bwAll) }
  if (!after.all.length || awAll < after.worst) { after.all = a.all.map(r3); after.worst = r3(awAll) }
}

for (const s of STREAMS) {
  const nm = s.name
  const slice = stats(after.parts[nm].segments)
  const chunk = stats(after.parts[nm].chunkMs)
  after.parts[nm].sliceStats = slice
  after.parts[nm].chunkStats = chunk
  if (s.unit !== 'chunk') console.log(`${TAG} per-${s.unit} ms ${nm}: ${JSON.stringify(slice)} over ${slice.n} ${s.unit}(s)`)
  console.log(`${TAG} per-chunk ms ${nm}: ${JSON.stringify(chunk)} over ${chunk.n} chunk(s)`)
}
for (const s of STREAMS) {
  const nm = s.name
  console.log(`${TAG} worst block ${nm}: accumulated ${before.parts[nm].worst}ms -> sliced ${after.parts[nm].worst}ms`)
}
console.log(`${TAG} worst block Promise.all: accumulated ${before.worst}ms -> sliced ${after.worst}ms`)
for (const s of STREAMS) {
  const nm = s.name
  console.log(`${TAG} placements ${nm}: ${after.parts[nm].placed} over ${s.keys.length} chunk(s), of which ${after.parts[nm].nearPlaced} in the ${NEAR_BAND_M}m near band`)
}

// -- source pin: the accumulated budget is gone from both loops, not retuned --------------------
function prewarmPin(path, file) {
  let src = ''
  try { src = readFileSync(path, 'utf8') } catch (e) { check(`${file} is readable`, false, (e && e.message) || String(e)); return null }
  const sliceConstants = (src.match(/\b(?:PREWARM_SLICE_MS|BUILD_SLICE_BUDGET_MS|BUILD_SLICE_MS)\b/g) || []).length
  const bodyStart = src.indexOf('async function prewarm')
  const body = bodyStart < 0 ? '' : src.slice(bodyStart, src.indexOf('\n  }', bodyStart))
  const yields = (body.match(/await macrotaskYield\(\)/g) || []).length
  const imports = /import \{ macrotaskYield \} from '\.\/macrotaskYield\.js'/.test(src)
  console.log(`${TAG} source pin ${file}: slice constants=${sliceConstants} prewarm yield(s)=${yields} sliceMs present=${/sliceMs/.test(src)} macrotaskYield imported=${imports} prewarm body=${body.length} char(s)`)
  check(`${file} keeps no millisecond slice budget to accumulate across units of work`, sliceConstants === 0 && !/sliceMs/.test(src), `${sliceConstants} slice constant(s), sliceMs present=${/sliceMs/.test(src)}`)
  check(`${file} prewarm yields inside its unit loop, with no condition on it`, body.length > 0 && yields >= 1, `${yields} unconditional yield(s) in a ${body.length}-char prewarm body`)
  check(`${file} imports the macrotask yield`, imports, `import line present=${imports}`)
  return { sliceConstants, yields }
}
const grassPin = prewarmPin(GRASS_SOURCE, 'client/core/Grass.js')
const rocksPin = prewarmPin(ROCKS_SOURCE, 'client/core/Rocks.js')

// The grass unit: prewarm has to drive the same incremental cursor the streaming path uses, or the
// slice is the chunk and the block is a chunk's worth of placement however often it yields.
const grassPrewarmBody = GRASS_SRC.slice(GRASS_SRC.indexOf('async function prewarm'), GRASS_SRC.indexOf('\n  }', GRASS_SRC.indexOf('async function prewarm')))
const grassUsesCursor = /startInflight\(/.test(grassPrewarmBody) && /stepInflight\(\)/.test(grassPrewarmBody)
const grassNoWholeChunk = !/loadChunk\(/.test(grassPrewarmBody)
console.log(`${TAG} source pin client/core/Grass.js prewarm: drives the incremental cursor=${grassUsesCursor} whole-chunk load removed=${grassNoWholeChunk}`)
check('the grass prewarm slices the chunk through the incremental cursor, not the whole chunk',
  grassUsesCursor && grassNoWholeChunk, `startInflight/stepInflight=${grassUsesCursor}, loadChunk gone=${grassNoWholeChunk}`)

let appSrc = ''
try { appSrc = readFileSync(APP_SOURCE, 'utf8') } catch (e) { check('client/app.js is readable', false, (e && e.message) || String(e)) }
const prewarmBlock = appSrc.slice(appSrc.indexOf('PLAYABLE_RADIUS_M'), appSrc.indexOf('after-veg-rocks-grass-prewarm'))
const members = (prewarmBlock.match(/\.prewarm\(/g) || []).length
const inOnePromiseAll = (prewarmBlock.match(/Promise\.all\(/g) || []).length === 1
console.log(`${TAG} source pin client/app.js: prewarm member(s) in one Promise.all=${members} single Promise.all=${inOnePromiseAll}`)
check('all three prewarm loops still run in one Promise.all, so the worst block is shared', members === 3 && inOnePromiseAll, `${members} member(s), single Promise.all=${inOnePromiseAll}`)

// -- verdict ------------------------------------------------------------------------------------
const totalYields = STREAMS.reduce((a, s) => a + s.keys.length, 0) * PASSES
check('the playable disc is not empty and the near band carries grass, so the measurement is real',
  STREAMS[0].keys.length > 0 && after.parts.grass.placed > 0 && after.parts.grass.nearPlaced > 0,
  `${STREAMS[0].keys.length} chunk(s), ${after.parts.grass.placed} grass placement(s), ${after.parts.grass.nearPlaced} in the near band`)
check('rock and vegetation place over the same disc, so the Promise.all arm is not a grass-only arm',
  after.parts.rock.placed > 0 && after.parts.veg.placed > 0,
  `rock ${after.parts.rock.placed}, veg ${after.parts.veg.placed}`)
for (const s of STREAMS) {
  const nm = s.name
  check(`the ${nm} slice change shed no placement(s)`, after.parts[nm].placed === before.parts[nm].placed && after.parts[nm].nearPlaced === before.parts[nm].nearPlaced,
    `after ${after.parts[nm].placed} (near ${after.parts[nm].nearPlaced}) vs before ${before.parts[nm].placed} (near ${before.parts[nm].nearPlaced})`)
}
check('the accumulated shape really did block for more than a frame, so the fix is not vacuous',
  before.worst > FRAME_BUDGET_MS, `before worst block ${before.worst}ms vs ${FRAME_BUDGET_MS}ms frame`)
check('the worst block across the whole Promise.all now fits inside one frame',
  after.worst < FRAME_BUDGET_MS, `after worst block ${after.worst}ms vs ${FRAME_BUDGET_MS}ms frame`)
check('the worst block across the whole Promise.all fell by at least 4x',
  after.worst * 4 <= before.worst, `${before.worst}ms -> ${after.worst}ms`)
check('every unit of the shipped shape yielded through MessageChannel, not a setTimeout fallback',
  channelsOpened >= totalYields, `${channelsOpened} MessageChannel(s) for at least ${totalYields} unit(s)`)

console.log(`${TAG} ${PASSED.length} passed, ${FAILED.length} failed`)
console.log(`${TAG} RESULT: ${FAILED.length ? 'FAIL' : 'PASS'} -- worst block over the whole Promise.all ${before.worst}ms -> ${after.worst}ms (grass ${before.parts.grass.worst} -> ${after.parts.grass.worst}, rock ${before.parts.rock.worst} -> ${after.parts.rock.worst}, veg ${before.parts.veg.worst} -> ${after.parts.veg.worst}); grass unit ${GRASS_STEP_MS}ms cursor step p50=${after.parts.grass.sliceStats.p50}ms max=${after.parts.grass.sliceStats.max}ms, grass chunk p50=${after.parts.grass.chunkStats.p50}ms max=${after.parts.grass.chunkStats.max}ms, rock chunk max=${after.parts.rock.chunkStats.max}ms; ${after.parts.grass.placed} grass and ${after.parts.rock.placed} rock placement(s) over ${STREAMS[0].keys.length} chunk(s), ${grassPin?.sliceConstants ?? -1}/${rocksPin?.sliceConstants ?? -1} slice constant(s), frame budget ${FRAME_BUDGET_MS}ms`)
process.exitCode = FAILED.length ? 1 : 0
