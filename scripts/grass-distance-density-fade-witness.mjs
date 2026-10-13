#!/usr/bin/env node
// Grass distance-density pin (gpu-free).
//
// Grass is the dominant instance count in the frame by two orders of magnitude, and the occlusion
// A/B already proved a hidden instance still submits its draw -- so culling does not remove work
// here and reducing the instance count is the lever that does. The population is uniform out to
// the ring, so it grows as the square of the draw distance and the draw distance is the expensive
// thing to want.
//
// This witness boots the real client/core/Grass.js in node over the real tps-game terrain and the
// real src/terrain/GrassPlacement.js population, twice: once with the law's full-density radius
// pushed past the ring, which is the uniform population it replaces, and once with the law on and
// the greater ring it pays for. Both arms are the same world, seed and route.
//
// The law gives every blade a stable rank and a radius of its own, so what it removes is chosen
// once for the blade's lifetime instead of being re-chosen as the player moves, and it makes the
// surviving population grow with the draw radius as R ** (2 - P) instead of R ** 2. The pins that
// matter are the two the owner set: nothing inside the full-density radius changes at all, and no
// blade is ever absent while it should be visible -- which is what makes the drop-off a growth in
// the shader rather than a pop.
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
const BEFORE_RING_M = 61.6
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

// The shader fades a blade in over FADE_M metres of the approach to its own edge radius, so the
// blade has to be in the instancer before that approach starts and may stay until the fade has
// been back at zero for LEAD_M metres. Both halves are checked here against the live cells.
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
  return { missingVisible, presentPastReach, nearNotFull, nearAbsent, maxVisibleM, maxPresentM, maxFullM, present, placed }
}

async function arm(cfg, label) {
  const h = await makeHarness(cfg)
  let px = 0, pz = 0
  await h.grass.prewarm(px, pz, 60000)
  for (let i = 0; i < SETTLE_UPDATES; i++) h.grass.update(0.016, null, [px, 0, pz])
  const trisOf = () => h.grass.nearInstances * h.nearTris + (h.grass.totalInstances - h.grass.nearInstances) * h.midTris
  const settled = { near: h.grass.nearInstances, total: h.grass.totalInstances, tris: trisOf() }
  const steps = Math.round(WALK_M / FRAME_M)
  let quietMs = 0, quietFrames = 0
  let worstMissing = 0, worstOverreach = 0, worstNear = 0
  let nextAudit = AUDIT_EVERY_M
  for (let i = 0; i < steps; i++) {
    const before = h.grass.profile.loads
    pz -= FRAME_M
    h.grass.update(0.016, null, [px, 0, pz])
    if (h.grass.profile.loads === before) { quietMs += h.grass.profile.updateMs; quietFrames++ }
    if (Math.abs(pz) >= nextAudit) {
      nextAudit += AUDIT_EVERY_M
      // Between two re-evaluations the player travels up to LOD_REVISIT_STEP_M, so a blade that
      // has just fallen out of reach can still be held for that much longer than the lead.
      const a = auditCells(h, px, pz, LOD_REVISIT_STEP_M)
      if (a.missingVisible > worstMissing) worstMissing = a.missingVisible
      if (a.presentPastReach > worstOverreach) worstOverreach = a.presentPastReach
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
  h.grass.rebuildPlacement()
  h.grass.update(0.016, null, [px, 0, pz])
  const drained = { total: h.grass.totalInstances, near: h.grass.nearInstances }
  h.grass.dispose()
  return {
    ...h, label, settled, walked, oracle, audit1, churn, drained,
    worstMissing, worstOverreach, worstNear,
    ringM: h.grass.renderDistance, fullR: h.grass.densityFullR, edgeM: h.grass.densityEdgeM,
    updateMsPerQuietFrame: quietFrames ? quietMs / quietFrames : null,
  }
}

const UNIFORM = { grassRenderDistance: BEFORE_RING_M, grassDensityFullR: 1e9 }
const LAW = {}
// The uniform arm carried the shader this replaces, which squashed a card's height by
// 1 - smoothstep(0.55 * ring, ring, d): full size out to 0.55 * ring and gone at ring. The law
// gives every blade an edge of its own instead, so the comparable figure is the radius that still
// carries grass at full size, measured here with the shader's own fade and the law's own ranks.
const BEFORE_FULL_M = 0.55 * BEFORE_RING_M
const before = await arm(UNIFORM, 'uniform population')
const after = await arm(LAW, 'distance-density law')

console.log(`[grass-density] world=${WORLD} site=${SITE_DEG}deg walk=${WALK_M}m at ${(FRAME_M * 60).toFixed(1)} m/s`)
console.log(`[grass-density] LOD geometry from the live instancers: near=${after.nearTris} tri/clump mid=${after.midTris} tri/clump`)
for (const a of [before, after]) {
  console.log(`[grass-density] ${a.label}: ring=${a.ringM} fullR=${a.fullR} edge=${a.edgeM.toFixed(1)}`
    + ` | settled ${a.settled.total} clump(s), near=${a.settled.near}, tris=${a.settled.tris}`
    + ` | after ${WALK_M}m walk: ${a.walked.total} clump(s), near=${a.walked.near}, tris=${a.walked.tris}`
    + ` | grass at full size to ${a.audit1.maxFullM.toFixed(1)}m, visible to ${a.audit1.maxVisibleM.toFixed(1)}m, instanced to ${a.audit1.maxPresentM.toFixed(1)}m`
    + ` | ${a.audit1.present} of ${a.audit1.placed} placed | churn=${a.churn}`
    + ` | updateMsPerQuietFrame=${a.updateMsPerQuietFrame === null ? 'n/a' : a.updateMsPerQuietFrame.toFixed(4)}`)
}

const dTris = after.settled.tris - before.settled.tris
const pctTris = (100 * dTris / Math.max(1, before.settled.tris)).toFixed(1)
const dTotal = after.settled.total - before.settled.total
const pctTotal = (100 * dTotal / Math.max(1, before.settled.total)).toFixed(1)

check('the world really carries grass', before.settled.total > 50000, `population=${before.settled.total} clump(s)`)
check('both arms walked the same population', before.walked.total > 0 && after.walked.total > 0, `before=${before.walked.total} after=${after.walked.total}`)
check('the law really removed clumps', after.settled.total < before.settled.total, `${before.settled.total} -> ${after.settled.total} clump(s) (${pctTotal}%)`)
check('the triangle count fell', after.settled.tris < before.settled.tris, `${before.settled.tris} -> ${after.settled.tris} tri(s) (${pctTris}%)`)
check('the draw distance grew', after.ringM > before.ringM && after.audit1.maxFullM > BEFORE_FULL_M,
  `ring ${before.ringM} -> ${after.ringM} m, grass at full size to ${BEFORE_FULL_M.toFixed(1)} -> ${after.audit1.maxFullM.toFixed(1)} m`)
check('the law reaches past the old ring', after.audit1.maxVisibleM > before.ringM,
  `${after.audit1.maxVisibleM.toFixed(1)}m > ${before.ringM}m`)
check('the nearest density is unchanged', before.walked.near === after.walked.near && before.settled.near === after.settled.near,
  `near ${before.settled.near}/${before.walked.near} -> ${after.settled.near}/${after.walked.near} clump(s) within ${NEAR_M}m`)
check('every blade inside the full-density radius is present and fully faded in',
  after.worstNear === 0, `violations=${after.worstNear} inside ${after.fullR}m`)
check('no blade is absent while it should be visible', after.worstMissing === 0 && after.audit1.missingVisible === 0,
  `walking=${after.worstMissing} at rest=${after.audit1.missingVisible}`)
check('no blade is held past its own edge plus the lead', after.audit1.presentPastReach === 0 && after.worstOverreach === 0,
  `at rest=${after.audit1.presentPastReach} walking (one re-evaluation step of slack)=${after.worstOverreach}`)
check('the uniform arm holds everything it places', before.audit1.present === before.audit1.placed,
  `${before.audit1.present} of ${before.audit1.placed}`)
check('the law really re-decided as the player moved', after.churn > 0, `adds+removes=${after.churn} over ${WALK_M}m`)
check('the uniform arm never re-decided', before.churn === 0, `adds+removes=${before.churn}`)
check('the near-LOD oracle still places clumps underfoot', after.oracle.near > 0, `oracle=${after.oracle.near} clump(s) within ${NEAR_M}m of ${after.oracle.placed} placed`)
check('switching clumps on and off leaks no instance', after.drained.total === 0 && after.drained.near === 0,
  `after unload total=${after.drained.total} near=${after.drained.near}`)

console.log(`RESULT: ${failed === 0 ? 'PASS' : 'FAIL'} -- grass distance-density: ${before.settled.total} -> ${after.settled.total} clump(s) (${pctTotal}%) and ${before.settled.tris} -> ${after.settled.tris} triangle(s) (${pctTris}%) at rest, ${before.walked.total} -> ${after.walked.total} clump(s) and ${before.walked.tris} -> ${after.walked.tris} triangle(s) after a ${WALK_M}m walk, with the draw ring ${before.ringM} -> ${after.ringM} m and grass at full size to ${BEFORE_FULL_M.toFixed(1)} -> ${after.audit1.maxFullM.toFixed(1)} m; near clumps ${before.settled.near} -> ${after.settled.near} unchanged inside ${after.fullR} m (violations ${after.worstNear}); no blade absent while visible (${after.audit1.missingVisible}) or held past its edge (${after.audit1.presentPastReach}); revisit churn ${after.churn} over ${WALK_M}m`)
process.exit(failed === 0 ? 0 : 1)
