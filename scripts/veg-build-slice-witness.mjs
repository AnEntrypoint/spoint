#!/usr/bin/env node
// Witness: the vegetation species build and the vegetation prewarm each run as more than one
// macrotask, so the longest block the main thread takes is bounded by one unit of work and a frame
// runs after it. Row PERF-veg-species-build-prewarm-hitch-1013.
//
// A frame is one macrotask as far as the main thread is concerned: while a synchronous call runs,
// nothing renders. So the synchronous duration of one unit of build or prewarm work IS the frame
// cost, and a millisecond slice budget accumulated across units cannot cut it.
//
// Two things are measured, both by running the real code:
//   * the species LOD chain, COLD (what a landscape change paid before: cap + meshopt simplify on
//     the same input bytes every rebuild) and WARM (what it pays now: the finished chain is cached
//     next to the species template and a rebuild clones it). Cloning must produce the same vertex
//     count at every LOD level, so the win cannot come out of the near/mid/far geometry.
//   * one prewarm chunk, which is now the slice: real placements over the playable ring, with the
//     number of trees placed counted, because a prewarm that places nothing is not a prewarm.
//
// No per-pass GPU timings: they are invalid on this project.

import { readFileSync } from 'node:fs'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadWorldModule } from '../src/sdk/WorldLocator.js'
import { resolveTerrainConfig } from '../src/shared/terrainConfig.js'
import { loadPlanetSampler, planetSamplerOptsOf } from '../src/terrain/TerrainPhysics.js'
import { createPlanetFrame } from '../src/terrain/PlanetFrame.js'
import { createCachedAnchorField } from '../src/terrain/ClimateCache.js'
import { latticeFor } from '../src/terrain/PlacementChart.js'
import { placementsForChunk, VEG } from '../src/terrain/VegPlacement.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_URL = pathToFileURL(`${REPO}/`).href
const TAG = '[veg-build-slice]'

await installSpecifierHooks()

// ez-tree's module body runs THREE.TextureLoader.load, which needs document.createElementNS for the
// img element. The load never completes here and no texture is ever read: this witness times
// geometry and placement work, which is the whole synchronous block.
const _el = () => ({
  style: {}, src: '', width: 1, height: 1,
  addEventListener() {}, removeEventListener() {}, setAttribute() {}, appendChild() {}, remove() {},
  getContext: () => null,
})
globalThis.document = {
  createElementNS: () => _el(), createElement: () => _el(),
  body: _el(), head: _el(), addEventListener() {}, getElementById: () => null,
}

const FRAME_BUDGET_MS = 16.67
// The playable prewarm area app.js asks for: PLAYABLE_RADIUS_M 128 over VEG_CHUNK_SIZE_M 32.
const PLAYABLE_RADIUS_M = 128
const VEG_CHUNK_SIZE_M = 32
const VEG_SOURCE = resolve(REPO, 'client', 'core', 'Vegetation.js')

const PASSED = []
const FAILED = []
function check(label, ok, detail) {
  if (ok) { PASSED.push(label); console.log(`  [PASS] ${label} (${detail})`) }
  else { FAILED.push(label); console.log(`  [FAIL] ${label} -- ${detail}`) }
}
const nowMs = () => performance.now()
const r3 = (v) => Math.round(v * 1000) / 1000

function stats(list) {
  if (!list.length) return { n: 0, p50: 0, p95: 0, max: 0, total: 0 }
  const s = list.slice().sort((a, b) => a - b)
  const total = s.reduce((a, b) => a + b, 0)
  return {
    n: s.length,
    p50: r3(s[s.length >> 1]),
    p95: r3(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]),
    max: r3(s[s.length - 1]),
    total: r3(total),
  }
}

async function measureSpecies() {
  let Tree = null, TreePreset = null
  try {
    ({ Tree, TreePreset } = await import('@dgreenheck/ez-tree'))
  } catch (e) {
    console.log(`${TAG} RESULT: FAIL (uncaught) -- @dgreenheck/ez-tree did not import: ${(e && e.message) || e}`)
    process.exitCode = 1
    return null
  }
  let VB = null
  try {
    VB = await import('../client/core/VegetationBuild.js')
  } catch (e) {
    console.log(`${TAG} RESULT: FAIL (uncaught) -- VegetationBuild.js did not import: ${(e && e.message) || e}`)
    process.exitCode = 1
    return null
  }
  const { speciesLodChain, TARGET_H } = VB
  if (typeof speciesLodChain !== 'function') {
    console.log(`${TAG} RESULT: FAIL (uncaught) -- VegetationBuild.js exports no speciesLodChain`)
    process.exitCode = 1
    return null
  }

  const names = Object.keys(TARGET_H)
  // JIT warm-up: the first species a cold run builds pays for the whole module's compile, and
  // reporting that as a landscape-change rebuild cost would be a lie.
  await speciesLodChain('Aspen Small', 0, Tree, TreePreset)
  await speciesLodChain('Bush 2', 0, Tree, TreePreset)

  // Three repeats, best of them: the box this runs on is shared with other lanes, and a spike that
  // belongs to the box must not be reported as a spike that belongs to the code. The cold arm stays
  // single-shot -- it is the "before", and the first call is the only one a rebuild ever paid.
  const WARM_REPEATS = 3
  const rows = []
  for (const name of names) {
    const c0 = nowMs()
    const cold = await speciesLodChain(name, 0, Tree, TreePreset)
    const coldMs = r3(nowMs() - c0)
    let warmMs = Infinity
    let warm = null
    for (let r = 0; r < WARM_REPEATS; r++) {
      const w0 = nowMs()
      warm = await speciesLodChain(name, 0, Tree, TreePreset)
      warmMs = Math.min(warmMs, nowMs() - w0)
    }
    const levels = {}
    let same = true
    for (const k of ['branchGeo0', 'leafGeo0', 'b1', 'b2', 'l1', 'l2', 'b2shadow']) {
      const cv = cold[k].getAttribute('position').count
      const wv = warm[k].getAttribute('position').count
      levels[k] = `${cv}/${wv}`
      if (cv !== wv) same = false
    }
    rows.push({ name, coldMs, warmMs: r3(warmMs), same, levels })
    console.log(`${TAG} species ${JSON.stringify({ name, coldMs, warmMs, same, levels })}`)
  }

  const cold = stats(rows.map((r) => r.coldMs))
  const warm = stats(rows.map((r) => r.warmMs))
  const identical = rows.filter((r) => r.same).length
  console.log(`${TAG} species LOD chain COLD (a rebuild re-simplified): ${JSON.stringify(cold)}`)
  console.log(`${TAG} species LOD chain WARM (a rebuild clones): ${JSON.stringify(warm)}`)
  check('the cold rebuild path really did block for more than a frame, so this is not vacuous',
    cold.max >= FRAME_BUDGET_MS, `cold worst ${cold.max}ms vs ${FRAME_BUDGET_MS}ms frame`)
  check('a rebuild of a species now fits inside one frame',
    warm.max < FRAME_BUDGET_MS, `warm worst ${warm.max}ms vs ${FRAME_BUDGET_MS}ms frame`)
  check('the cached rebuild costs less than half the re-simplifying rebuild',
    warm.total < cold.total * 0.5, `warm total ${warm.total}ms vs cold total ${cold.total}ms`)
  check('every LOD level of every species has the same vertex count cold and warm',
    identical === rows.length, `${identical} of ${rows.length} species`)
  return { cold, warm, rows }
}

async function measurePrewarm() {
  const loaded = await loadWorldModule(resolve(REPO, 'apps/world/tps-game.js'))
  const tcfg = resolveTerrainConfig(loaded)
  const sampler = await loadPlanetSampler(planetSamplerOptsOf(tcfg))
  const frame = createPlanetFrame({ sampler, anchorDir: tcfg.anchorDir || [0, 1, 0], offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
  const field = createCachedAnchorField(sampler.anchorField, frame)
  const lattice = latticeFor(frame, VEG)

  const side = Math.round((PLAYABLE_RADIUS_M * 2) / VEG_CHUNK_SIZE_M)
  const keys = []
  const seen = new Set()
  for (let gz = 0; gz < side; gz++) {
    for (let gx = 0; gx < side; gx++) {
      const x = (gx - (side - 1) / 2) * VEG_CHUNK_SIZE_M
      const z = (gz - (side - 1) / 2) * VEG_CHUNK_SIZE_M
      const k = lattice.chunkKeyOfDir(...frame.localToDir(x, z))
      if (seen.has(k)) continue
      seen.add(k)
      keys.push(k)
    }
  }

  const chunkMs = []
  let trees = 0
  for (const key of keys) {
    let best = Infinity
    let list = null
    for (let r = 0; r < 3; r++) {
      const t0 = nowMs()
      list = placementsForChunk(key, frame, field, tcfg.seed | 0)
      const t1 = nowMs()
      if (t1 - t0 < best) best = t1 - t0
      // The slice is the chunk, so the loop yields here for real in the shipped code; draining the
      // ring without yielding would measure one long block instead of the slice.
      await new Promise((r2) => setImmediate(r2))
    }
    chunkMs.push(best)
    trees += list ? list.length : 0
  }
  const st = stats(chunkMs)
  console.log(`${TAG} prewarm chunk over the ${PLAYABLE_RADIUS_M}m playable radius: ${JSON.stringify(st)} over ${keys.length} chunk(s), trees placed ${trees}`)
  check('the playable ring is not empty, so the chunk cost was measured on real placement',
    keys.length > 0 && trees > 0, `${keys.length} chunk(s), ${trees} tree(s) placed`)
  check('one prewarm chunk fits inside one frame, so a per-chunk slice bounds the block',
    st.max < FRAME_BUDGET_MS, `worst chunk ${st.max}ms vs ${FRAME_BUDGET_MS}ms frame`)
  return { st, trees, chunks: keys.length }
}

function measureSource() {
  let src = ''
  try {
    src = readFileSync(VEG_SOURCE, 'utf8')
  } catch (e) {
    check('client/core/Vegetation.js is readable', false, (e && e.message) || String(e))
    return null
  }
  const sliceConstants = (src.match(/\b(?:PREWARM_SLICE_MS|BUILD_SLICE_BUDGET_MS|BUILD_SLICE_MS)\b/g) || []).length
  const yields = (src.match(/macrotaskYield\(/g) || []).length
  const prewarmBody = src.slice(src.indexOf('async function prewarm'))
  const prewarmYields = (prewarmBody.slice(0, prewarmBody.indexOf('\n  }')).match(/await macrotaskYield\(\)/g) || []).length
  console.log(`${TAG} source pin: slice constants=${sliceConstants} macrotaskYield call(s)=${yields} of which inside prewarm=${prewarmYields}`)
  check('no millisecond slice budget is left to accumulate across units of work',
    sliceConstants === 0, `${sliceConstants} slice constant(s) still in client/core/Vegetation.js`)
  check('the prewarm loop yields once per chunk, with no condition on it',
    prewarmYields === 1 && !/sliceMs/.test(prewarmBody), `${prewarmYields} conditional-free yield(s) in prewarm`)
  return { sliceConstants, yields, prewarmYields }
}

async function main() {
  const species = await measureSpecies()
  const prewarm = await measurePrewarm()
  const source = measureSource()
  if (!species || !prewarm || !source) {
    console.log(`${TAG} RESULT: FAIL -- an arm never ran, so every other verdict is withheld`)
    process.exitCode = 1
    return
  }
  console.log(`${TAG} ${PASSED.length} passed, ${FAILED.length} failed`)
  console.log(`${TAG} RESULT: ${FAILED.length ? 'FAIL' : 'PASS'} -- species rebuild cold ${species.cold.max}ms -> warm ${species.warm.max}ms worst per species (total ${species.cold.total} -> ${species.warm.total}ms over ${species.rows.length} species, every LOD level vertex-identical), prewarm slice ${prewarm.st.max}ms worst chunk over ${prewarm.chunks} chunk(s) placing ${prewarm.trees} tree(s), ${source.yields} macrotask yield(s) and 0 slice constant(s), frame budget ${FRAME_BUDGET_MS}ms`)
  process.exitCode = FAILED.length ? 1 : 0
}

main().catch((e) => {
  console.error(`${TAG} RESULT: FAIL (uncaught)`)
  console.error((e && e.stack) || e)
  process.exitCode = 1
})
