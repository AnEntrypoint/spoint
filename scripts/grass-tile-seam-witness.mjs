#!/usr/bin/env node
// Grass/tile seam characterisation (gpu-free).
//
// Owner report: "we see a ridge with no grass where terrain tiles meet". Two symptoms that may or
// may not share one cause -- a RIDGE (geometry) and GRASS ABSENT (population) -- so this witness
// measures them separately, on one line across the real world, with the real placement code:
//
//   1. the surface the grass is placed on: the CPU ground height every STEP_M along the line. A step
//      in it is a ridge the eye can see and the placement cannot; a continuous surface with a visible
//      ridge means the ridge is a render-side artifact (a mesh/LOD seam), not a population one.
//   2. the population the placement actually produces: placed blades per square metre in a disc at
//      every sample. A bare strip is a population fact, and its SPACING names the boundary that
//      produces it (a 32 m spacing is the grass chunk, a larger one is a terrain tile).
//
// It never fixes anything: it says which of the two is true, where, and at what spacing.
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORLD = 'tps-game.js'
const SITE_DEG = 210
const LINE_M = 600
const STEP_M = 0.25
const DISC_R = 3

const CANVAS_CTX = () => ({
  fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
  fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
  drawImage() {}, createLinearGradient: () => ({ addColorStop() {} }),
})
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: CANVAS_CTX }) }
globalThis.Image = class { set src(v) {} }
await installSpecifierHooks()
const href = (p) => pathToFileURL(resolve(ROOT, p)).href

const { createHeightSampler } = await import('mapspinner/height-cpu')
const { loadWorldModule } = await import(href('src/sdk/WorldLocator.js'))
const { createPlanetFrame } = await import(href('src/terrain/PlanetFrame.js'))
const { terrainCarvesOf, terrainHashVersionOf } = await import(href('src/shared/terrainConfig.js'))
const { createPlacementRing } = await import(href('client/core/PlacementRing.js'))
const { placementsForGrassChunk, GRASS } = await import(href('src/terrain/GrassPlacement.js'))
const { createCachedAnchorField } = await import(href('src/terrain/ClimateCache.js'))
const { createBiomeOverride } = await import(href('src/terrain/BiomeOverride.js'))
const { createModelExclusionField } = await import(href('src/terrain/ModelExclusionField.js'))

const argv = process.argv.slice(2)
const flag = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.slice(n.length + 3) : d
}
const LINE = Number(flag('line', LINE_M))
const STEP = Number(flag('step', STEP_M))
const SITE = Number(flag('site', SITE_DEG))
const CHUNK = GRASS.CHUNK

const world = await loadWorldModule(resolve(ROOT, 'apps', 'world', WORLD))
const tcfg = world.terrain
const hashVersion = terrainHashVersionOf(tcfg)
const worldSeed = (tcfg.seed ?? 0) | 0
const sampler = createHeightSampler({ radius: tcfg.radius, seed: tcfg.seed, reliefScale: tcfg.reliefScale, hashVersion, carves: terrainCarvesOf(tcfg) })
const anchorDir = (() => { const a = SITE * Math.PI / 180; return [Math.sin(a), Math.cos(a), 0] })()
const frame = createPlanetFrame({ sampler, anchorDir, offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
const anchorField = createModelExclusionField(undefined).wrapClimateField(createBiomeOverride().wrapClimateField(createCachedAnchorField(undefined, frame)))

// Every chunk the line crosses, placed once: the sample loop then only reads.
const ring = createPlacementRing(frame, GRASS, 64)
const chunkKeys = new Map()
const steps = Math.round(LINE / STEP)
for (let i = 0; i <= steps; i++) {
  const z = -i * STEP
  const key = ring.focusKeyAt(0, z)
  if (!chunkKeys.has(key)) {
    let list = null
    try { list = placementsForGrassChunk(key, frame, anchorField, worldSeed) } catch (_) { list = null }
    chunkKeys.set(key, list || [])
  }
}
const placedTotal = [...chunkKeys.values()].reduce((a, b) => a + b.length, 0)
console.log(`[grass-tile-seam] world=${WORLD} site=${SITE}deg line=${LINE}m step=${STEP}m disc r=${DISC_R}m over ${chunkKeys.size} chunk(s) of ${CHUNK}m, ${placedTotal} blade(s) placed`)

// Every blade is indexed by its OWN coordinates, never by the chunk it came from: a chunk-key
// arithmetic mistake produces a periodic gap at exactly the chunk spacing, which is precisely the
// shape of the report, so the sampling must not be able to manufacture it.
const GRID_M = 4
const grid = new Map()
for (const list of chunkKeys.values()) {
  for (const p of list) {
    const k = Math.floor(p.x / GRID_M) + ',' + Math.floor(p.z / GRID_M)
    let arr = grid.get(k)
    if (!arr) { arr = []; grid.set(k, arr) }
    arr.push(p)
  }
}

const discArea = Math.PI * DISC_R * DISC_R
const hs = []
const dens = []
for (let i = 0; i <= steps; i++) {
  const z = -i * STEP
  const h = frame.groundHeightLocal(0, z)
  hs.push(h)
  // The disc spans at most the four chunks around its centre, so only those are scanned.
  let n = 0
  const r2 = DISC_R * DISC_R
  const gx0 = Math.floor((0 - DISC_R) / GRID_M), gx1 = Math.floor((0 + DISC_R) / GRID_M)
  const gz0 = Math.floor((z - DISC_R) / GRID_M), gz1 = Math.floor((z + DISC_R) / GRID_M)
  for (let gx = gx0; gx <= gx1; gx++) {
    for (let gz = gz0; gz <= gz1; gz++) {
      const arr = grid.get(gx + ',' + gz)
      if (!arr) continue
      for (const p of arr) {
        const dx = p.x - 0, dz = p.z - z
        if (dx * dx + dz * dz <= r2) n++
      }
    }
  }
  dens.push(n / discArea)
}

const sorted = dens.slice().sort((a, b) => a - b)
const median = sorted[Math.floor(sorted.length / 2)]
const p10 = sorted[Math.floor(sorted.length * 0.1)]
// A bare sample is one well below the line's own typical population, not below an absolute number:
// the line crosses open ground and steep ground alike and both are allowed to be sparse.
const BARE_FRAC = 0.35
const bare = []
for (let i = 0; i < dens.length; i++) if (dens[i] < median * BARE_FRAC) bare.push(i * STEP)
// Runs of consecutive bare samples are one strip, and a strip's centre is what has to be returned to.
const strips = []
for (const m of bare) {
  const last = strips[strips.length - 1]
  if (last && m - last.to <= STEP * 1.5) { last.to = m; last.n++ } else strips.push({ from: m, to: m, n: 1 })
}
const gaps = []
for (let i = 1; i < strips.length; i++) gaps.push(+(strips[i].from - strips[i - 1].from).toFixed(2))

// The surface: a ridge is a jump between two neighbouring samples, so compare the worst jump with
// the line's own typical slope per step.
const dh = []
for (let i = 1; i < hs.length; i++) dh.push(Math.abs(hs[i] - hs[i - 1]))
const dhSorted = dh.slice().sort((a, b) => a - b)
const dhMedian = dhSorted[Math.floor(dhSorted.length / 2)]
const dhP99 = dhSorted[Math.floor(dhSorted.length * 0.99)]
let worst = { at: 0, d: 0 }
for (let i = 0; i < dh.length; i++) if (dh[i] > worst.d) worst = { at: i * STEP, d: dh[i] }

console.log(`[grass-tile-seam] population: median ${median.toFixed(3)} blade(s)/m2, p10 ${p10.toFixed(3)}, min ${sorted[0].toFixed(3)}, max ${sorted[sorted.length - 1].toFixed(3)}`)
console.log(`[grass-tile-seam] bare sample(s) under ${(BARE_FRAC * 100).toFixed(0)}% of the median: ${bare.length} of ${dens.length}, in ${strips.length} strip(s)`)
for (const s of strips.slice(0, 20)) console.log(`  strip ${s.from.toFixed(2)}m..${s.to.toFixed(2)}m (${s.n} sample(s), centre ${((s.from + s.to) / 2).toFixed(2)}m)`)
console.log(`[grass-tile-seam] strip spacing: ${JSON.stringify(gaps.slice(0, 20))}`)
console.log(`[grass-tile-seam] surface: |dh| per ${STEP}m step median ${dhMedian.toFixed(4)}m p99 ${dhP99.toFixed(4)}m worst ${worst.d.toFixed(4)}m at ${worst.at.toFixed(2)}m`)
const heightRange = [Math.min(...hs), Math.max(...hs)]
console.log(`[grass-tile-seam] surface range over the line: ${heightRange[0].toFixed(2)}m..${heightRange[1].toFixed(2)}m`)

// The seam test proper: a boundary strip against the same line a few metres away from it. A bare
// strip at a boundary is a ratio well under 1; a population that only varies with the terrain is
// not. The boundaries are the two spacings the report could mean -- the 32 m grass chunk and the
// 256 m terrain field -- plus the collider's own field extent when the world states one.
const boundarySpacings = [CHUNK, 256]
const rows = []
for (const spacing of boundarySpacings) {
  const at = (m) => {
    const i = Math.round(m / STEP)
    return dens[Math.min(dens.length - 1, Math.max(0, i))]
  }
  const mean = (m0, m1) => {
    let s = 0, n = 0
    for (let m = m0; m <= m1; m += STEP) { s += at(m); n++ }
    return n ? s / n : null
  }
  for (let b = spacing; b < LINE - spacing; b += spacing) {
    const on = mean(b - 4, b + 4)
    const off = (mean(b + 12, b + 20) + mean(b - 20, b - 12)) / 2
    if (on === null || off === null || !(off > 0)) continue
    rows.push({ spacing, atM: b, onBoundary: +on.toFixed(3), offBoundary: +off.toFixed(3), ratio: +(on / off).toFixed(3) })
  }
}
let worstRatio = null
for (const r of rows) if (!worstRatio || r.ratio < worstRatio.ratio) worstRatio = r
console.log(`[grass-tile-seam] boundary strip vs the same line 12-20m away: ${rows.length} boundary(ies)`)
for (const r of rows.slice(0, 24)) console.log(`  ${r.spacing}m boundary at ${r.atM}m: ${r.onBoundary} vs ${r.offBoundary} blade(s)/m2 (ratio ${r.ratio})`)
console.log(`[grass-tile-seam] worst boundary ratio: ${worstRatio ? worstRatio.ratio + ' at the ' + worstRatio.spacing + 'm boundary @ ' + worstRatio.atM + 'm' : 'n/a'}`)

const BOUNDARY_MIN_RATIO = 0.7
const failed = !(worstRatio && worstRatio.ratio >= BOUNDARY_MIN_RATIO)
// Does the worst surface step fall inside a bare strip? That is the whole question: one cause or two.
const inStrip = (m) => strips.some((s) => m >= s.from && m <= s.to)
const bareAtWorst = inStrip(worst.at)
const stripsAtChunkEdges = strips.filter((s) => {
  const c = (s.from + s.to) / 2
  return Math.abs(c / CHUNK - Math.round(c / CHUNK)) * CHUNK < STEP * 2
}).length
console.log(`[grass-tile-seam] VERDICT surface-step-inside-a-bare-strip=${bareAtWorst} bareStrip(s)=${strips.length} of which ${stripsAtChunkEdges} centre on a ${CHUNK}m chunk edge`)
console.log(`[grass-tile-seam] MEASURED grass-tile-seam: worst boundary ratio ${worstRatio ? worstRatio.ratio : 'n/a'} (budget ${BOUNDARY_MIN_RATIO}) at the ${worstRatio ? worstRatio.spacing : 'n/a'}m boundary @ ${worstRatio ? worstRatio.atM : 'n/a'}m; worst surface step ${worst.d.toFixed(4)}m against a ${dhMedian.toFixed(4)}m median step; ${strips.length} bare strip(s) over ${LINE}m`)
console.log(`RESULT: ${failed ? 'FAIL' : 'PASS'} -- grass-tile-seam: population at a boundary is ${worstRatio ? worstRatio.ratio : 'n/a'} of the same line away from it, worst surface step ${worst.d.toFixed(4)}m at ${worst.at.toFixed(2)}m against a ${dhMedian.toFixed(4)}m median step, surface-step-inside-a-bare-strip=${bareAtWorst}`)
process.exit(failed ? 1 : 0)
