#!/usr/bin/env node
// Grass incremental-LOD placement pin (gpu-free).
//
// Placement was chunk-granular while the distance law is per blade: a chunk entering the ring is
// generated at full blade count, and the law then draws only the fraction of it whose own reach
// covers the player. PERF-grass-distance-density-fade-1013 measured the result -- 540,434 blades
// placed to keep 158,500 after a 240 m walk -- and named it the architectural follow-up rather
// than a knob, because no parameter moves a population that is generated before it is asked.
//
// src/terrain/GrassPlacementLod.js is that follow-up: every cell gets its slots ranked once by the
// coin that already decides whether a blade exists, the population the law will draw at a distance
// is then a prefix of that ranking, and a chunk the player closes on extends its prefix in place.
// The blade a slot produces is unchanged, so the population is a subset of the old one, never a
// different one -- which is what this witness pins.
//
// Both arms run the real client/core/Grass.js over the real src/terrain/GrassPlacement.js
// population on tps-game, same world, seed and route. The placed-to-kept ratio IS the metric: it
// counts what placement generated against what the law drew from it. The visible result -- the
// instances and triangles actually on -- is pinned equal between the two arms, and the nearest
// density is pinned to the standing figure, because the point is to stop generating waste and not
// to change the grass.
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
const NEAR_CLUMPS_AT_REST = 3802
const WALK_M = 240
const FRAME_M = 7 / 60
const SETTLE_UPDATES = 160
const AUDIT_EVERY_M = 40
const LOD_REVISIT_STEP_M = 4

const { createHeightSampler } = await import('mapspinner/height-cpu')
const { loadWorldModule } = await import(href('src/sdk/WorldLocator.js'))
const { createPlanetFrame } = await import(href('src/terrain/PlanetFrame.js'))
const { terrainCarvesOf, terrainHashVersionOf } = await import(href('src/shared/terrainConfig.js'))
const { createGrass } = await import(href('client/core/Grass.js'))
const { createPlacementRing } = await import(href('client/core/PlacementRing.js'))
const { placementsForGrassChunk, GRASS, GRASS_DENSITY, grassBladeEdgeM } = await import(href('src/terrain/GrassPlacement.js'))
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
const XF_FLOATS = 9
const PF_FLOATS = 7

const makeHarness = async (cfg) => {
  const frame = createPlanetFrame({ sampler, anchorDir, offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
  const scene = { children: [], add(o) { this.children.push(o) }, remove(o) { this.children = this.children.filter((c) => c !== o) } }
  const renderer = { [WEBGPU_RENDERER]: true }
  const grass = await createGrass({ renderer, scene, frame, cfg, worldSeed })
  const ring = createPlacementRing(frame, GRASS, grass.renderDistance)
  const anchorField = createModelExclusionField(undefined).wrapClimateField(createBiomeOverride().wrapClimateField(createCachedAnchorField(undefined, frame)))
  const trisPerClump = (mesh) => {
    const idx = mesh && mesh.geometry && mesh.geometry.index
    return idx ? idx.count / 3 : null
  }
  return { frame, grass, ring, anchorField, nearTris: trisPerClump(grass._im), midTris: trisPerClump(grass._imMid) }
}

const placedAround = (h, px, pz, ringM) => {
  const ring = createPlacementRing(h.frame, GRASS, ringM)
  const keys = ring.ringAt(px, pz, ring.focusKeyAt(px, pz))
  let n = 0
  let placed = 0
  for (const key of keys) {
    if (ring.distSqFromFocus(key) > ringM * ringM) continue
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

// Every blade the placement generated, against the ones the law is actually drawing from it. A
// blade is drawn while the player is inside its own reach, so a blade the two arms disagree about
// is either grass that has gone missing or placement work that was never going to be drawn.
const auditCells = (h, px, pz, slackM) => {
  const fullR = h.grass.densityFullR
  const capM = h.grass.densityEdgeM
  const fadeM = GRASS_DENSITY.FADE_M
  const leadM = GRASS_DENSITY.LEAD_M
  let missingVisible = 0, presentPastReach = 0, nearNotFull = 0, nearAbsent = 0
  let maxVisibleM = 0, maxPresentM = 0, maxFullM = 0, maxOverreachM = -Infinity, present = 0, placed = 0
  for (const cell of h.grass._cells.values()) {
    if (!cell.xf || !cell.pf || !cell.on) continue
    const n = cell.on.length
    for (let i = 0; i < n; i++) {
      const o = i * XF_FLOATS
      const dx = cell.xf[o] - px, dz = cell.xf[o + 2] - pz
      const d = Math.sqrt(dx * dx + dz * dz)
      const edge = grassBladeEdgeM(cell.pf[i * PF_FLOATS], fullR, capM)
      const fade = Math.min(1, Math.max(0, (edge - d) / fadeM))
      const isPresent = cell.on[i] === 1
      placed++
      if (isPresent) { present++; if (d > maxPresentM) maxPresentM = d }
      if (fade > 0) {
        if (d > maxVisibleM) maxVisibleM = d
        if (fade >= 1 && d > maxFullM) maxFullM = d
        if (!isPresent) missingVisible++
      }
      if (isPresent) {
        const over = d - (edge + leadM)
        if (over > maxOverreachM) maxOverreachM = over
        if (over > slackM) presentPastReach++
      }
      if (d <= fullR) {
        if (!isPresent) nearAbsent++
        else if (fade < 1) nearNotFull++
      }
    }
  }
  return { missingVisible, presentPastReach, nearNotFull, nearAbsent, maxVisibleM, maxPresentM, maxFullM, maxOverreachM, present, placed }
}

async function arm(cfg, label) {
  const h = await makeHarness(cfg)
  let px = 0, pz = 0
  // The wall the placement itself costs: every blade the ring materialises is a height solve and a
  // row, whether or not the law ever draws it, so this is what a blade thrown away is paid for.
  const _pw = performance.now()
  await h.grass.prewarm(px, pz, 60000)
  const prewarmWallMs = performance.now() - _pw
  for (let i = 0; i < SETTLE_UPDATES; i++) h.grass.update(0.016, null, [px, 0, pz])
  const trisOf = () => h.grass.nearInstances * h.nearTris + (h.grass.totalInstances - h.grass.nearInstances) * h.midTris
  const settled = { near: h.grass.nearInstances, total: h.grass.totalInstances, tris: trisOf() }
  const steps = Math.round(WALK_M / FRAME_M)
  let quietMs = 0, quietFrames = 0
  let worstMissing = 0, worstOverreach = 0, worstNear = 0, worstOverreachM = -Infinity
  let nextAudit = AUDIT_EVERY_M
  for (let i = 0; i < steps; i++) {
    const before = h.grass.profile.loads
    pz -= FRAME_M
    h.grass.update(0.016, null, [px, 0, pz])
    if (h.grass.profile.loads === before) { quietMs += h.grass.profile.updateMs; quietFrames++ }
    if (Math.abs(pz) >= nextAudit) {
      nextAudit += AUDIT_EVERY_M
      // Between two re-evaluations the player travels up to one LOD_REVISIT_STEP_M, and one
      // scan's worth of decisions then drains at LOD_REVISIT_BUDGET per frame, so a blade that
      // has just fallen out of reach can still be held for a second step on top of the lead.
      const a = auditCells(h, px, pz, 2 * LOD_REVISIT_STEP_M)
      if (a.missingVisible > worstMissing) worstMissing = a.missingVisible
      if (a.presentPastReach > worstOverreach) worstOverreach = a.presentPastReach
      if (a.maxOverreachM > worstOverreachM) worstOverreachM = a.maxOverreachM
      if (a.nearNotFull + a.nearAbsent > worstNear) worstNear = a.nearNotFull + a.nearAbsent
    }
  }
  // Re-setting the flag drops the last re-evaluation position, so the next updates re-take every
  // decision at the position the player actually ended at and drain the backlog: only then is the
  // "held no further than its own edge plus the lead" bound exact rather than a step wide.
  h.grass.lodRevisit = true
  for (let i = 0; i < SETTLE_UPDATES; i++) h.grass.update(0.016, null, [px, 0, pz])
  const walked = { near: h.grass.nearInstances, total: h.grass.totalInstances, tris: trisOf() }
  const audit1 = auditCells(h, px, pz, 0)
  const oracle = placedAround(h, px, pz, NEAR_M * 4)
  const churn = h.grass.profile.revisitAdds + h.grass.profile.revisitRemoves
  const refines = h.grass.profile.refines
  const refineBlades = h.grass.profile.refineBlades
  const refineMs = h.grass.profile.refineMs
  const stream = h.grass.streamState()
  const loadedChunks = stream.loaded
  h.grass.rebuildPlacement()
  const afterRebuild = h.grass.totalInstances
  h.grass.update(0.016, null, [px, 0, pz])
  const drained = { total: h.grass.totalInstances, near: h.grass.nearInstances }
  h.grass.dispose()
  return {
    ...h, label, settled, walked, oracle, audit1, churn, drained, refines, refineBlades, refineMs,
    loadedChunks, afterRebuild, loads: h.grass.profile.loads, released: h.grass.profile.released,
    placementMs: prewarmWallMs + refineMs, prewarmWallMs,
    worstMissing, worstOverreach, worstOverreachM, worstNear,
    ringM: h.grass.renderDistance, fullR: h.grass.densityFullR, edgeM: h.grass.densityEdgeM,
    updateMsPerQuietFrame: quietFrames ? quietMs / quietFrames : null,
  }
}

// The same law in both arms; the arm that differs is the one that generates the population.
const WHOLE = { grassPlacementLod: false }
const INCREMENTAL = {
  grassLodSlackM: Number(process.env.GRASS_LOD_SLACK || 0) || undefined,
  grassLodReleaseM: Number(process.env.GRASS_LOD_RELEASE || 0) || undefined,
}
const before = await arm(WHOLE, 'whole-chunk placement')
const after = await arm(INCREMENTAL, 'incremental LOD placement')

const ratio = (a) => a.audit1.placed / Math.max(1, a.audit1.present)

console.log(`[grass-lod] world=${WORLD} site=${SITE_DEG}deg walk=${WALK_M}m at ${(FRAME_M * 60).toFixed(1)} m/s`)
console.log(`[grass-lod] LOD geometry from the live instancers: near=${after.nearTris} tri/clump mid=${after.midTris} tri/clump`)
for (const a of [before, after]) {
  console.log(`[grass-lod] ${a.label}: ring=${a.ringM} fullR=${a.fullR} edge=${a.edgeM.toFixed(1)}`
    + ` | settled ${a.settled.total} clump(s), near=${a.settled.near}, tris=${a.settled.tris}`
    + ` | after ${WALK_M}m walk: ${a.walked.total} clump(s), near=${a.walked.near}, tris=${a.walked.tris}`
    + ` | grass at full size to ${a.audit1.maxFullM.toFixed(1)}m, visible to ${a.audit1.maxVisibleM.toFixed(1)}m, instanced to ${a.audit1.maxPresentM.toFixed(1)}m`
    + ` | placed ${a.audit1.placed} to keep ${a.audit1.present} (${ratio(a).toFixed(3)}:1)`
    + ` | churn=${a.churn} refines=${a.refines} refineBlades=${a.refineBlades} refineMs=${a.refineMs.toFixed(0)} loads=${a.loads} chunks=${a.loadedChunks}`
    + ` | placement wall ${a.placementMs.toFixed(0)}ms (prewarm ${a.prewarmWallMs.toFixed(0)} + refine ${a.refineMs.toFixed(0)}) released=${a.released}`
    + ` | updateMsPerQuietFrame=${a.updateMsPerQuietFrame === null ? 'n/a' : a.updateMsPerQuietFrame.toFixed(4)}`)
}

const pctPlaced = (100 * (after.audit1.placed - before.audit1.placed) / Math.max(1, before.audit1.placed)).toFixed(1)
const pctMs = (100 * (after.updateMsPerQuietFrame - before.updateMsPerQuietFrame) / Math.max(1e-9, before.updateMsPerQuietFrame)).toFixed(1)

check('the world really carries grass', before.settled.total > 50000, `population=${before.settled.total} clump(s)`)
check('both arms walked the same population', before.walked.total > 0 && after.walked.total > 0, `before=${before.walked.total} after=${after.walked.total}`)
check('the whole-chunk arm really is the waste it was measured to be', ratio(before) > 2.5,
  `${before.audit1.placed} placed to keep ${before.audit1.present} (${ratio(before).toFixed(3)}:1)`)
check('the incremental arm placed far closer to what it keeps', ratio(after) < ratio(before) / 2 && ratio(after) <= 1.6,
  `${before.audit1.placed}:${before.audit1.present} -> ${after.audit1.placed}:${after.audit1.present} (${ratio(before).toFixed(3)}:1 -> ${ratio(after).toFixed(3)}:1, ${pctPlaced}% placed)`)
check('the quiet frame got cheaper', after.updateMsPerQuietFrame < before.updateMsPerQuietFrame,
  `${before.updateMsPerQuietFrame.toFixed(4)} -> ${after.updateMsPerQuietFrame.toFixed(4)} ms/frame (${pctMs}%)`)
check('the visible population at rest is unchanged', after.settled.total === before.settled.total && after.settled.tris === before.settled.tris,
  `${before.settled.total} -> ${after.settled.total} clump(s), ${before.settled.tris} -> ${after.settled.tris} triangle(s)`)
check('the visible population after the walk is unchanged', after.walked.total === before.walked.total && after.walked.tris === before.walked.tris,
  `${before.walked.total} -> ${after.walked.total} clump(s), ${before.walked.tris} -> ${after.walked.tris} triangle(s)`)
check('the nearest density is still the standing figure', after.settled.near === NEAR_CLUMPS_AT_REST && after.settled.near === before.settled.near,
  `near ${before.settled.near} -> ${after.settled.near} clump(s) within ${NEAR_M}m, pinned at ${NEAR_CLUMPS_AT_REST}`)
check('the nearest density survived the walk', after.walked.near === before.walked.near,
  `near ${before.walked.near} -> ${after.walked.near} clump(s) within ${NEAR_M}m`)
check('every blade inside the full-density radius is present and fully faded in', after.worstNear === 0,
  `violations=${after.worstNear} inside ${after.fullR}m`)
check('no blade is absent while it should be visible', after.worstMissing === 0 && after.audit1.missingVisible === 0,
  `walking=${after.worstMissing} at rest=${after.audit1.missingVisible}`)
check('no blade is held past its own edge plus the lead', after.audit1.presentPastReach === 0 && after.worstOverreach === 0,
  `at rest=${after.audit1.presentPastReach} walking=${after.worstOverreach}, worst overshoot ${after.worstOverreachM.toFixed(2)}m of ${GRASS_DENSITY.LEAD_M}m lead plus ${2 * LOD_REVISIT_STEP_M}m of re-evaluation slack`)
check('the incremental arm really refined chunks as the player closed', after.refines > 0 && after.refineBlades > 0,
  `refines=${after.refines} refineBlades=${after.refineBlades} over ${WALK_M}m`)
check('the whole-chunk arm never refined', before.refines === 0 && before.refineBlades === 0,
  `refines=${before.refines} refineBlades=${before.refineBlades}`)
check('the incremental arm cut the revisit churn', after.churn < before.churn, `${before.churn} -> ${after.churn} adds+removes over ${WALK_M}m`)
check('the near-LOD oracle still places clumps underfoot', after.oracle.near > 0,
  `oracle=${after.oracle.near} clump(s) within ${NEAR_M}m of ${after.oracle.placed} placed`)
check('unloading every chunk releases every instance', after.afterRebuild === 0 && before.afterRebuild === 0,
  `after rebuildPlacement total=${before.afterRebuild}/${after.afterRebuild}`)

console.log(`RESULT: ${failed === 0 ? 'PASS' : 'FAIL'} -- grass incremental LOD: placed-to-kept ${before.audit1.placed}:${before.audit1.present} (${ratio(before).toFixed(3)}:1) -> ${after.audit1.placed}:${after.audit1.present} (${ratio(after).toFixed(3)}:1) after a ${WALK_M}m walk, updateMsPerQuietFrame ${before.updateMsPerQuietFrame.toFixed(4)} -> ${after.updateMsPerQuietFrame.toFixed(4)} ms, with ${before.settled.total} -> ${after.settled.total} clump(s) and ${before.settled.tris} -> ${after.settled.tris} triangle(s) at rest and ${before.walked.total} -> ${after.walked.total} clump(s) and ${before.walked.tris} -> ${after.walked.tris} triangle(s) after the walk, near clumps ${before.settled.near} -> ${after.settled.near} inside ${NEAR_M}m; no blade absent while visible (${after.audit1.missingVisible}) or held past its edge (${after.audit1.presentPastReach}); ${after.refines} refines adding ${after.refineBlades} blade(s)`)
process.exit(failed === 0 ? 0 : 1)
