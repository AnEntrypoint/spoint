#!/usr/bin/env node
// PERF-grass-rim-draw-gap-1013: grass instances per distance ring, counted at the submission
// boundary.
//
// The placement side is already measured and clean (grass-tile-seam-witness): the CPU population is
// continuous across the terrain-tile rim. So the question is the DRAW side, and the project's
// silent-failure class is "the placement and the instance count read healthy while nothing
// renders" -- trees from a swallowed throw, rocks from a draw count that stayed 0 with 67
// instances live. A count of `totalInstances` cannot see that. What three actually hands the
// encoder can:
//
//   instanceCount   = InstancedMesh.count            (three returns null from
//                     RenderObject.getDrawParameters() at 0, so no draw is submitted at all)
//   the instance data = instanceMatrix.array          (a slot three submits whose matrix is the
//                     zero matrix costs a vertex invocation and paints nothing)
//
// So this witness reads BOTH, buckets them by distance from the player, and cross-checks them
// against the population the distance law itself kept -- three numbers that must agree, because a
// zero here is only worth quoting when it is proven (`proven-zero-count` / `measured`), never as a
// bare zero. The instancer's own `liveCount` is a lane's addition on top of three's InstancedMesh2
// and is not on every tree this can run against, so where it is absent the cross-check is against
// the law's keep count instead and `live` stays null rather than being read as a number.
//
// It boots the real client/core/Grass.js in node over the real tps-game terrain, never a browser:
// the browser/WebGPU encoder is the boundary that would be authoritative, and in this lane it is
// unreachable (the page never becomes ready), so the witness names the layer it did reach instead
// of inferring past it.
//
// Non-vacuous in both directions -- every arm has to MOVE the number it is about:
//   * a ring claimed empty must fill when the ring radius widens past it      (ARM_WIDE)
//   * a ring claimed thinned by the fade must refill when FULL_R is pushed out (ARM_FULLR)
// A number that reads the same in both arms is an instrument gap, not a measurement, and fails.
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
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
const BAND_M = 8
const SETTLE_UPDATES = 96
const APPROACH_STEPS = 4
const APPROACH_M = 4
const BASE_RING_M = 88
const WIDE_RING_M = 120
const RIM_LO_M = 56, RIM_MID_M = 64, RIM_HI_M = 80
const MIN_RIM_RATIO = 0.7

const argv = process.argv.slice(2)
const flagNum = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`))
  return hit ? Number(hit.slice(n.length + 3)) : d
}
const BAND = flagNum('band', BAND_M)

const { createHeightSampler } = await import('mapspinner/height-cpu')
const { loadWorldModule } = await import(href('src/sdk/WorldLocator.js'))
const { createPlanetFrame } = await import(href('src/terrain/PlanetFrame.js'))
const { terrainCarvesOf, terrainHashVersionOf } = await import(href('src/shared/terrainConfig.js'))
const { createGrass } = await import(href('client/core/Grass.js'))
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

const ringOf = (d) => Math.floor(d / BAND)

// A slot three submits whose matrix is the zero matrix paints nothing: it is the state
// setVisibleAt(id, false) and releaseId() both leave behind, and it is indistinguishable at the
// encoder from a blade that is not there.
const isZeroSlot = (a, o) => a[o] === 0 && a[o + 1] === 0 && a[o + 2] === 0 && a[o + 4] === 0
  && a[o + 5] === 0 && a[o + 6] === 0 && a[o + 8] === 0 && a[o + 9] === 0 && a[o + 10] === 0
  && a[o + 12] === 0 && a[o + 13] === 0 && a[o + 14] === 0

function submitProfile(grass, px, pz, maxRing) {
  const out = { submitted: 0, live: null, drawn: 0, zeroInRange: 0, drawnRings: [], pts: [] }
  for (let r = 0; r <= maxRing; r++) out.drawnRings[r] = 0
  const instancers = [grass._im, grass._imMid]
  const liveVals = instancers.map((im) => im.liveCount)
  if (liveVals.every((v) => Number.isFinite(v))) out.live = liveVals.reduce((x, y) => x + y, 0)
  for (const im of instancers) {
    const mesh = im.mesh
    const a = mesh.instanceMatrix.array
    out.submitted += mesh.count
    for (let id = 0; id < mesh.count; id++) {
      const o = id * 16
      if (isZeroSlot(a, o)) { out.zeroInRange++; continue }
      const dx = a[o + 12] - px, dz = a[o + 14] - pz
      const d = Math.sqrt(dx * dx + dz * dz)
      const r = ringOf(d)
      if (r > maxRing) continue
      out.drawnRings[r]++
      out.drawn++
      out.pts.push(d)
    }
  }
  return out
}

function placedProfile(grass, px, pz, maxRing) {
  const placed = [], on = []
  for (let r = 0; r <= maxRing; r++) { placed[r] = 0; on[r] = 0 }
  for (const cell of grass._cells.values()) {
    if (!cell.xf || !cell.on) continue
    for (let i = 0; i < cell.on.length; i++) {
      const o = i * XF_FLOATS
      const dx = cell.xf[o] - px, dz = cell.xf[o + 2] - pz
      const r = ringOf(Math.sqrt(dx * dx + dz * dz))
      if (r > maxRing) continue
      placed[r]++
      if (cell.on[i] === 1) on[r]++
    }
  }
  return { placed, on }
}

// The same boundary test the placement-side witness runs, on the drawn population instead of the
// placed one: the density of DRAWN blades in a +-4m annulus at a candidate boundary spacing against
// the same disc 12-20m away from it. The spacings are the two the owner's report could mean -- the
// grass chunk and the terrain tile -- so a strip at 32m names the chunk and one at 64m names a tile.
const boundaryRatios = (pts, spacing, capM) => {
  const nIn = (lo, hi) => {
    let n = 0
    for (const d of pts) if (d >= lo && d < hi) n++
    return n
  }
  const area = (lo, hi) => Math.PI * (hi * hi - lo * lo)
  const out = []
  for (let b = spacing; b + 20 < capM; b += spacing) {
    const on = nIn(b - 4, b + 4) / area(b - 4, b + 4)
    const offN = nIn(b + 12, b + 20) + nIn(b - 20, b - 12)
    const off = offN / (area(b + 12, b + 20) + area(b - 20, b - 12))
    if (!(off > 0)) continue
    out.push({ spacing, atM: b, on, off, ratio: on / off })
  }
  return out
}

const density = (n, r) => n / (Math.PI * ((r + 1) * (r + 1) - r * r) * BAND * BAND)
const rimRatioOf = (a) => {
  const d = rimRings.map((r) => density(a.sub.drawnRings[r], r))
  return { d, ratio: d[1] / ((d[0] + d[2]) / 2) }
}
const rimRings = [RIM_LO_M / BAND, RIM_MID_M / BAND, (RIM_MID_M + BAND) / BAND]

async function arm(cfg, label) {
  const frame = createPlanetFrame({ sampler, anchorDir, offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
  const scene = { children: [], add(o) { this.children.push(o) }, remove(o) { this.children = this.children.filter((c) => c !== o) } }
  const renderer = { [WEBGPU_RENDERER]: true }
  const grass = await createGrass({ renderer, scene, frame, cfg, worldSeed })
  if (!grass) throw new Error('createGrass returned null')
  const ringM = grass.renderDistance
  const maxRing = Math.ceil((ringM + BAND) / BAND)
  let px = 0, pz = 0
  await grass.prewarm(px, pz, 120000)
  for (let i = 0; i < SETTLE_UPDATES; i++) grass.update(0.016, null, [px, 0, pz])
  // A short approach so the LOD revisit re-takes every keep decision at the position the rings are
  // measured from, then a rest so its backlog is drained before anything is read.
  for (let s = 0; s < APPROACH_STEPS; s++) {
    pz -= APPROACH_M
    for (let i = 0; i < 8; i++) grass.update(0.016, null, [px, 0, pz])
  }
  grass.lodRevisit = true
  for (let i = 0; i < SETTLE_UPDATES; i++) grass.update(0.016, null, [px, 0, pz])

  const sub = submitProfile(grass, px, pz, maxRing)
  const pl = placedProfile(grass, px, pz, maxRing)
  const out = { label, cfg, ringM, maxRing, sub, pl, lawOn: pl.on.reduce((x, y) => x + y, 0), fullR: grass.densityFullR, edgeM: grass.densityEdgeM, reachM: grass.densityReachM, cells: grass._cells.size }
  grass.dispose()
  return out
}

const BASE = {}
const WIDE = { grassRenderDistance: WIDE_RING_M }
const FULLR = { grassDensityFullR: 1e9 }

const base = await arm(BASE, `ring ${BASE_RING_M}m (shipped)`)
const wide = await arm(WIDE, `ring ${WIDE_RING_M}m (widened)`)
const fullr = await arm(FULLR, `ring ${BASE_RING_M}m, FULL_R pushed out`)

console.log(`[grass-rim-draw] world=${WORLD} site=${SITE_DEG}deg band=${BAND}m  layer reached: three's InstancedMesh.count + instanceMatrix (the values that become instanceCount and the instance buffer); the WebGPU encoder itself was unreachable in this lane`)
console.log(`[grass-rim-draw] base: ring=${base.ringM}m FULL_R=${base.fullR} EDGE_CAP_M=${base.edgeM.toFixed(1)} cells=${base.cells}`)
console.log(`[grass-rim-draw] base submission: instanceCount submitted=${base.sub.submitted} liveCount=${base.sub.live === null ? 'unavailable (no live count on this tree; the cross-check is against the law\'s keep count)' : base.sub.live} non-zero matrices below count=${base.sub.drawn} zero matrices below count=${base.sub.zeroInRange}`)

const printTable = (a) => {
  console.log(`[grass-rim-draw] ${a.label}: ring ${a.ringM}m`)
  console.log('  ring m      placed   law-on    drawn   placed/m2   drawn/m2')
  for (let r = 0; r <= a.maxRing; r++) {
    const lo = r * BAND, hi = (r + 1) * BAND
    console.log(`  ${String(lo).padStart(3)}-${String(hi).padStart(3)}   ${String(a.pl.placed[r]).padStart(7)} ${String(a.pl.on[r]).padStart(8)} ${String(a.sub.drawnRings[r]).padStart(8)}   ${density(a.pl.placed[r], r).toFixed(3).padStart(8)}   ${density(a.sub.drawnRings[r], r).toFixed(3).padStart(8)}`)
  }
}
printTable(base)
printTable(wide)
printTable(fullr)

const bd = rimRatioOf(base).d
const rimRatio = rimRatioOf(base).ratio
const wideRim = rimRatioOf(wide).ratio
console.log(`[grass-rim-draw] base rim rings ${RIM_LO_M}-${RIM_LO_M + BAND}/${RIM_MID_M}-${RIM_MID_M + BAND}/${RIM_MID_M + BAND}-${RIM_MID_M + 2 * BAND} m drawn/m2: ${bd.map((d) => d.toFixed(3)).join(' / ')}  rim ratio ${rimRatio.toFixed(3)}`)
console.log(`[grass-rim-draw] widened arm rim ratio ${wideRim.toFixed(3)}`)

const bounds = []
for (const spacing of [32, 64]) bounds.push(...boundaryRatios(base.sub.pts, spacing, base.reachM))
let worstBound = null
for (const b of bounds) if (!worstBound || b.ratio < worstBound.ratio) worstBound = b
for (const b of bounds) console.log(`[grass-rim-draw] ${b.spacing}m boundary at ${b.atM}m: drawn ${b.on.toFixed(3)} vs ${b.off.toFixed(3)} blade(s)/m2 (ratio ${b.ratio.toFixed(3)})`)

// The instrument has to see distance at all, in both directions, on the SAME distance band:
// holding the band fixed and moving what the law is allowed to keep is the only way to tell a ring
// that is empty because nothing reaches it from one that is empty because the instrument cannot see.
const FILL_LO = 11, FILL_HI = 12
const bandSum = (a) => {
  let n = 0
  for (let r = FILL_LO; r <= Math.min(FILL_HI, a.maxRing); r++) n += a.sub.drawnRings[r]
  return n
}
const baseFill = bandSum(base), wideFill = bandSum(wide), fullrFill = bandSum(fullr)
const fullrFar = fullr.sub.drawn - base.sub.drawn
const interior = Math.floor(RIM_MID_M / BAND)

console.log(`[grass-rim-draw] forcing on one band (${FILL_LO * BAND}-${(FILL_HI + 1) * BAND}m): base=${baseFill} widened=${wideFill} fullR=${fullrFill}`)
console.log(`[grass-rim-draw] forcing: total drawn base=${base.sub.drawn} wide=${wide.sub.drawn} fullR=${fullr.sub.drawn} (delta ${fullrFar})`)
console.log(`[grass-rim-draw] MEASURED grass-rim-draw: rim ratio ${rimRatio.toFixed(3)} (budget ${MIN_RIM_RATIO}); submitted=${base.sub.submitted} drawn=${base.sub.drawn} liveCount=${base.sub.live === null ? 'unavailable' : base.sub.live}; base rim rings ${bd.map((d) => d.toFixed(3)).join('/')} blade(s)/m2; worst boundary ratio ${worstBound ? worstBound.ratio.toFixed(3) + ' at the ' + worstBound.spacing + 'm boundary @ ' + worstBound.atM + 'm' : 'n/a'}`)

const sum = (a) => a.reduce((x, y) => x + y, 0)
check('the world really carries grass', sum(base.pl.placed) > 50000,
  `${sum(base.pl.placed)} blade(s) placed in the loaded cells`)
check('the submission boundary is self-consistent: the instancer submits exactly what the law kept',
  base.sub.drawn === base.lawOn && (base.sub.live === null || base.sub.live === base.sub.drawn),
  `drawn=${base.sub.drawn} law kept=${base.lawOn} liveCount=${base.sub.live === null ? 'unavailable' : base.sub.live} submitted=${base.sub.submitted}`)
check('the instancer submits at least one draw unit', base.sub.submitted > 0,
  `instanceCount submitted=${base.sub.submitted}`)
// The silent-failure class this row is about: a blade the law keeps that never reaches the draw.
// `law-on` is what Grass.js decided to keep; `drawn` is what the instancer actually hands three.
// They are equal in every ring or the row is not resolved.
check('every blade the law keeps is a blade the instancer submits', (() => {
  const bad = []
  for (let r = 0; r <= base.maxRing; r++) if (base.pl.on[r] !== base.sub.drawnRings[r]) bad.push(`${r * BAND}-${(r + 1) * BAND}m (on ${base.pl.on[r]} vs drawn ${base.sub.drawnRings[r]})`)
  return bad.length === 0
})(), (() => {
  const bad = []
  for (let r = 0; r <= base.maxRing; r++) if (base.pl.on[r] !== base.sub.drawnRings[r]) bad.push(`${r * BAND}-${(r + 1) * BAND}m on=${base.pl.on[r]} drawn=${base.sub.drawnRings[r]}`)
  return bad.length ? bad.join(', ') : `all ${base.maxRing + 1} ring(s) agree`
})())
// Rings past the law's own reach (EDGE_CAP_M + LEAD_M) are held empty by design -- the ring keeps
// chunks out there as a lead -- so only rings the reach covers have to be populated.
check('every ring the law reaches that holds a placed blade draws one', (() => {
  const bad = []
  for (let r = 0; r <= base.maxRing; r++) {
    if ((r + 1) * BAND > base.reachM) continue
    if (base.pl.placed[r] > 0 && base.sub.drawnRings[r] === 0) bad.push(`${r * BAND}-${(r + 1) * BAND}m`)
  }
  return bad.length === 0
})(), `reach ${base.reachM.toFixed(1)}m; ring(s) with placed>0 and drawn=0: ${(() => {
  const bad = []
  for (let r = 0; r <= base.maxRing; r++) if ((r + 1) * BAND <= base.reachM && base.pl.placed[r] > 0 && base.sub.drawnRings[r] === 0) bad.push(`${r * BAND}-${(r + 1) * BAND}m`)
  return bad.length ? bad.join(', ') : 'none'
})()}`)
check('the instrument sees distance: a ring empty because nothing reaches it fills when the ring widens',
  baseFill === 0 && wideFill > 0,
  `${FILL_LO * BAND}-${(FILL_HI + 1) * BAND}m: base=${baseFill} widened=${wideFill}`)
check('the fade is what empties that ring: pushing FULL_R out fills it too',
  fullrFill > 0 && fullrFar > 0,
  `${FILL_LO * BAND}-${(FILL_HI + 1) * BAND}m: base=${baseFill} fullR=${fullrFill}; total drawn ${base.sub.drawn} -> ${fullr.sub.drawn}`)
check('widening the ring does not remove blades from the rim ring',
  wide.sub.drawnRings[interior] >= base.sub.drawnRings[interior],
  `${RIM_MID_M}-${RIM_MID_M + BAND}m: base=${base.sub.drawnRings[interior]} widened=${wide.sub.drawnRings[interior]}`)
check('there is no rim gap on the draw side', rimRatio >= MIN_RIM_RATIO && wideRim >= MIN_RIM_RATIO,
  `rim/neighbours drawn density ratio base ${rimRatio.toFixed(3)}, widened ${wideRim.toFixed(3)}, budget ${MIN_RIM_RATIO} (${bd.map((d) => d.toFixed(3)).join(' / ')} blade(s)/m2)`)
check('no drawn-density strip at either boundary spacing the report could mean',
  worstBound && worstBound.ratio >= MIN_RIM_RATIO,
  `${bounds.length} boundary(ies) of 32m and 64m, worst ratio ${worstBound ? worstBound.ratio.toFixed(3) + ' at the ' + worstBound.spacing + 'm boundary @ ' + worstBound.atM + 'm' : 'n/a'}`)

console.log(`RESULT: ${failed ? 'FAIL' : 'PASS'} -- grass-rim-draw: rim ratio ${rimRatio.toFixed(3)}, ${base.sub.drawn} submitted non-zero instance(s) of ${base.sub.submitted} submitted slot(s) over ${base.maxRing + 1} ring(s) of ${BAND}m; ${failed} check(s) failed`)
process.exit(failed ? 1 : 0)
