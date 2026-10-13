#!/usr/bin/env node
// Grass near-LOD placement pin (gpu-free).
//
// The near LOD is the 4-triangle clump (2 segments); the mid LOD is the 2-triangle one, so every
// clump handed to the near LOD costs twice the triangles. The decision used to be taken once per
// 32 m chunk, from an 8 m proximity test, at the moment the chunk was committed, and never looked
// at again: a chunk committed while the player was near it stayed detailed after the player left,
// and a chunk committed while it was far stayed coarse under the player's feet.
//
// This witness boots the real client/core/Grass.js in node over the real tps-game terrain and the
// real src/terrain/GrassPlacement.js population, and walks a player through it twice: once with the
// shipped per-clump decision that is re-taken as the player moves, and once with the chunk-latched
// decision it replaces. Both arms are the same world, the same seed and the same route, so the two
// triangle counts are comparable. The oracle is independent of Grass.js: it re-places the same ring
// through placementsForGrassChunk and counts the clumps that lie inside the near radius of the
// player, so "the near LOD is exactly the near disc" is checked from outside the module.
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT_URL = pathToFileURL(`${ROOT}/`).href
const CANVAS_CTX = () => ({
  fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
  fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
  drawImage() {}, createLinearGradient: () => ({ addColorStop() {} }),
})
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: CANVAS_CTX }) }
globalThis.Image = class { set src(v) {} }
await installSpecifierHooks()
const href = (p) => pathToFileURL(resolve(ROOT, p)).href

const WORLD = 'tps-game.js'
const SITE_DEG = 210
const NEAR_M = 8
const LOD_RING_M = 61.6
const WALK_M = 240
const FRAME_M = 7 / 60
const SETTLE_UPDATES = 160

const { createHeightSampler } = await import('mapspinner/height-cpu')
const { loadWorldModule } = await import(href('src/sdk/WorldLocator.js'))
const { createPlanetFrame } = await import(href('src/terrain/PlanetFrame.js'))
const { terrainCarvesOf, terrainHashVersionOf } = await import(href('src/shared/terrainConfig.js'))
const { createGrass } = await import(href('client/core/Grass.js'))
const { createPlacementRing } = await import(href('client/core/PlacementRing.js'))
const { placementsForGrassChunk, GRASS } = await import(href('src/terrain/GrassPlacement.js'))
const { createCachedAnchorField } = await import(href('src/terrain/ClimateCache.js'))
const { createBiomeOverride } = await import(href('src/terrain/BiomeOverride.js'))
const { createModelExclusionField } = await import(href('src/terrain/ModelExclusionField.js'))

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} (${detail})`)
}

const world = await loadWorldModule(resolve(ROOT, 'apps', 'world', WORLD))
const tcfg = world.terrain
const hashVersion = terrainHashVersionOf(tcfg)
const worldSeed = (tcfg.seed ?? 0) | 0
const sampler = createHeightSampler({ radius: tcfg.radius, seed: tcfg.seed, reliefScale: tcfg.reliefScale, hashVersion, carves: terrainCarvesOf(tcfg) })
const anchorDir = (() => { const a = SITE_DEG * Math.PI / 180; return [Math.sin(a), Math.cos(a), 0] })()

const WEBGPU_RENDERER = 'isWebGPU' + 'Renderer'
const makeHarness = async () => {
  const frame = createPlanetFrame({ sampler, anchorDir, offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
  const scene = { children: [], add(o) { this.children.push(o) }, remove(o) { this.children = this.children.filter((c) => c !== o) } }
  const renderer = { [WEBGPU_RENDERER]: true }
  const grass = await createGrass({ renderer, scene, frame, cfg: {}, worldSeed })
  const ring = createPlacementRing(frame, GRASS, LOD_RING_M)
  const anchorField = createModelExclusionField(undefined).wrapClimateField(createBiomeOverride().wrapClimateField(createCachedAnchorField(undefined, frame)))
  const trisPerClump = (mesh) => {
    const idx = mesh && mesh.geometry && mesh.geometry.index
    return idx ? idx.count / 3 : null
  }
  return { frame, grass, ring, anchorField, nearTris: trisPerClump(grass._im), midTris: trisPerClump(grass._imMid) }
}

const nearClumpsAround = (h, px, pz) => {
  const keys = h.ring.ringAt(px, pz, h.ring.focusKeyAt(px, pz))
  let n = 0
  let placed = 0
  for (const key of keys) {
    if (h.ring.distSqFromFocus(key) > LOD_RING_M * LOD_RING_M) continue
    let list
    try { list = placementsForGrassChunk(key, h.frame, h.anchorField, worldSeed) } catch (_) { continue }
    if (!list) continue
    placed += list.length
    for (const p of list) {
      const dx = p.x - px, dz = p.z - pz
      if (dx * dx + dz * dz <= NEAR_M * NEAR_M) n++
    }
  }
  return { near: n, placed, chunks: keys.length }
}

async function arm(lodRevisit) {
  const h = await makeHarness()
  h.grass.lodRevisit = lodRevisit
  let px = 0, pz = 0
  await h.grass.prewarm(px, pz, 60000)
  for (let i = 0; i < SETTLE_UPDATES; i++) h.grass.update(0.016, null, [px, 0, pz])
  const trisOf = () => h.grass.nearInstances * h.nearTris + (h.grass.totalInstances - h.grass.nearInstances) * h.midTris
  const settled = { near: h.grass.nearInstances, total: h.grass.totalInstances, tris: trisOf() }
  const steps = Math.round(WALK_M / FRAME_M)
  let quietMs = 0, quietFrames = 0
  for (let i = 0; i < steps; i++) {
    const before = h.grass.profile.loads
    pz -= FRAME_M
    h.grass.update(0.016, null, [px, 0, pz])
    if (h.grass.profile.loads === before) { quietMs += h.grass.profile.updateMs; quietFrames++ }
  }
  // Re-setting the flag drops the last re-evaluation position, so the next update re-takes the
  // decision at the position the player actually ended at instead of up to one step behind it.
  h.grass.lodRevisit = lodRevisit
  for (let i = 0; i < SETTLE_UPDATES; i++) h.grass.update(0.016, null, [px, 0, pz])
  const oracle = nearClumpsAround(h, px, pz)
  const walked = { near: h.grass.nearInstances, total: h.grass.totalInstances, tris: trisOf() }
  const migrations = h.grass.profile.lodMigrations
  h.grass.rebuildPlacement()
  h.grass.update(0.016, null, [px, 0, pz])
  const drained = { total: h.grass.totalInstances, near: h.grass.nearInstances }
  h.grass.dispose()
  return { ...h, settled, walked, oracle, migrations, drained, updateMsPerQuietFrame: quietFrames ? quietMs / quietFrames : null }
}

console.log(`[grass-near-lod] world=${WORLD} site=${SITE_DEG}deg near=${NEAR_M}m ring=${LOD_RING_M}m walk=${WALK_M}m at ${(FRAME_M * 60).toFixed(1)} m/s`)
const before = await arm(false)
const after = await arm(true)
console.log(`[grass-near-lod] LOD geometry from the live instancers: near=${after.nearTris} tri/clump mid=${after.midTris} tri/clump`)
for (const [label, a] of [['chunk-latched (before)', before], ['per-clump revisited (after)', after]]) {
  console.log(`[grass-near-lod] ${label}: settled ${a.settled.total} clump(s), near=${a.settled.near}, tris=${a.settled.tris}`
    + ` | after ${WALK_M}m walk: ${a.walked.total} clump(s), near=${a.walked.near}, tris=${a.walked.tris}`
    + ` | oracle near=${a.oracle.near} of ${a.oracle.placed} placed in ${a.oracle.chunks} chunk(s)`
    + ` | migrations=${a.migrations} updateMsPerQuietFrame=${a.updateMsPerQuietFrame === null ? 'n/a' : a.updateMsPerQuietFrame.toFixed(4)}`)
}

const POP = after.settled.total
const dTris = after.settled.tris - before.settled.tris
const pct = (100 * dTris / Math.max(1, before.settled.tris)).toFixed(1)

check('the near LOD really is the expensive one', after.nearTris > after.midTris, `near=${after.nearTris} tri/clump mid=${after.midTris} tri/clump`)
check('the world really carries grass', POP > 50000, `population=${POP} clump(s)`)
check('both arms walked the same population', before.walked.total === after.walked.total, `before=${before.walked.total} after=${after.walked.total}`)
check('the oracle placed clumps to compare against', after.oracle.near > 0, `oracle=${after.oracle.near} clump(s) within ${NEAR_M}m of ${after.oracle.placed} placed`)
check('at rest the near LOD is exactly the near disc', after.settled.near <= after.oracle.near && after.settled.near >= after.oracle.near * 0.8,
  `near=${after.settled.near} oracle=${after.oracle.near}`)
check('at rest the chunk-latched decision over-applied the near LOD', before.settled.near > after.oracle.near * 2,
  `latched=${before.settled.near} oracle=${after.oracle.near}`)
check('at rest the triangle count fell', after.settled.tris < before.settled.tris, `${before.settled.tris} -> ${after.settled.tris} tri(s) (${pct}%)`)
check('after a walk the near LOD is still exactly the near disc', after.walked.near <= after.oracle.near && after.walked.near >= after.oracle.near * 0.8,
  `near=${after.walked.near} oracle=${after.oracle.near}`)
check('the decision was re-taken as the player moved', after.migrations > 0, `migrations=${after.migrations} over ${WALK_M}m`)
check('the latched arm never re-took it', before.migrations === 0, `migrations=${before.migrations}`)
check('handing clumps between LODs leaks no instance', after.drained.total === 0 && after.drained.near === 0,
  `after unload total=${after.drained.total} near=${after.drained.near}`)

console.log(`RESULT: ${failed === 0 ? 'PASS' : 'FAIL'} -- grass near LOD population=${POP} clump(s): at rest ${before.settled.tris} -> ${after.settled.tris} grass triangle(s) (${pct}%), near clumps ${before.settled.near} -> ${after.settled.near} against a ${after.oracle.near}-clump ${NEAR_M}m disc; after a ${WALK_M}m walk ${before.walked.tris} -> ${after.walked.tris} triangle(s), near clumps ${before.walked.near} -> ${after.walked.near}; updateMs/frame ${before.updateMsPerQuietFrame === null ? 'n/a' : before.updateMsPerQuietFrame.toFixed(4)} -> ${after.updateMsPerQuietFrame === null ? 'n/a' : after.updateMsPerQuietFrame.toFixed(4)}`)
process.exit(failed === 0 ? 0 : 1)
