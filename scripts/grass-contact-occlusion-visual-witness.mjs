#!/usr/bin/env node
// Visual + counted-work-unit capture of grass taking the terrain's contact-occlusion darkening.
//
// "Grass darkens around vegetation the way the landscape does" is a visual claim, so this
// witness captures a PNG pair per arm and measures the luminance delta over GRASS pixels
// only, at two screen bands (near-tier grass low in the frame, mid-tier grass above it) and
// at four stamp densities: trees+rocks, trees only under ?norocks, rocks only, and nothing
// stamped as the control.
//
// Three things make the pair attributable to the term and nothing else:
//
//  - Time of day is re-armed immediately before every capture and read back after it.
//    window.__timeOfDayApi.setFraction only holds the server's own time-of-day sync off for
//    LOCAL_OVERRIDE_GRACE_MS (8000 ms, client/core/TimeOfDay.js), so a pin laid down once
//    at the top of the arm expires mid-run and the sun moves under the capture -- that is
//    what made two early runs of this witness disagree by 20 luma between two frames.
//  - The term is toggled OFF, ON, ON, OFF and the two ON-OFF differences are combined as
//    effect = mean, drift = half-difference, so a scene that is still moving on its own
//    cannot have that motion charged to the term. The arm is retried until the drift is
//    inside --max-control-delta.
//  - The vantage is not left to the spawn point: the player is relocated next to a real
//    trunk (window.__spoint.go), because the near band only carries a contact stamp when
//    vegetation stands within a few metres, and where the spawn puts the player varies.
//
// Run under scripts/gpulock.mjs:
//   SPOINT_GPU_WITNESS=1 node scripts/gpulock.mjs run grass-contact-occ -- \
//     node scripts/grass-contact-occlusion-visual-witness.mjs --rebuild-bundle
import { resolve, dirname } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, DEFAULT_VIEWPORT } from './lib/cdp-browser.mjs'
import { gpuArgs, assertGpu } from './lib/gpu-probe.mjs'
import { vendorPinArgs } from './lib/witness-gpu.mjs'
import {
  assertServedClientRoot, clientRootTag, rebuildIfRequested, CLIENT_ROOT_BUNDLE,
} from './lib/served-client-root.mjs'
import { flagNumber } from './lib/witness-args.mjs'
import { decodePng } from './tsl-parity/png.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT_DIR = resolve(ROOT, 'data', 'grass-contact-occ')

if (process.env.SPOINT_GPU_WITNESS !== '1') {
  console.log('SKIP grass-contact-occlusion-visual-witness: SPOINT_GPU_WITNESS is not 1 (reaches cdp-browser/WebGPURenderer, not run in the gpu-free arm)')
  process.exit(0)
}

const argv = process.argv.slice(2)
const ARGS = new Map()
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const eq = a.indexOf('=')
  if (eq > 0) ARGS.set(a.slice(2, eq), a.slice(eq + 1))
  else ARGS.set(a.slice(2), (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[i + 1] : true)
}
const flag = (n, d) => (ARGS.has(n) ? ARGS.get(n) : d)

const GPU = flag('gpu', 'amd')
const AT = String(flag('at', '-500,-500'))
const LABEL = String(flag('label', 'run'))
const TOD_FRACTION = flagNumber(flag, 'tod', 0.34, argv)
const TOD_TOL = flagNumber(flag, 'tod-tol', 0.01, argv)
const SETTLE_MS = flagNumber(flag, 'settle', 45000, argv)
const STABLE_HOLD_MS = flagNumber(flag, 'stable-hold', 6000, argv)
const STABLE_TIMEOUT_MS = flagNumber(flag, 'stable-timeout', 120000, argv)
const YAW_STEPS = flagNumber(flag, 'yaw-steps', 8, argv)
const ARM_MS = flagNumber(flag, 'arm-ms', 600, argv)
const STILL_ATTEMPTS = flagNumber(flag, 'still-attempts', 3, argv)
const VIEWPORT_W = flagNumber(flag, 'w', DEFAULT_VIEWPORT.width, argv)
const VIEWPORT_H = flagNumber(flag, 'h', DEFAULT_VIEWPORT.height, argv)
const STAND_M = flagNumber(flag, 'stand-m', 3, argv)
const TRUNK_CLEAR_M = flagNumber(flag, 'trunk-clear', 1.2, argv)
const MAX_STAND_TREE_M = flagNumber(flag, 'max-stand-tree-m', 12, argv)
const MAX_LAND_OFFSET_M = flagNumber(flag, 'max-land-offset-m', 4, argv)
const RELOCATE_SETTLE_MS = flagNumber(flag, 'relocate-settle', 8000, argv)
const RELOCATE_ATTEMPTS = flagNumber(flag, 'relocate-attempts', 3, argv)
const EXPECT_VENDOR = flag('expect-vendor', GPU)
const MIN_GRASS_PX = flagNumber(flag, 'min-grass-px', 1500, argv)
const MIN_DROP_LUMA = flagNumber(flag, 'min-drop', 1.0, argv)
const MAX_CONTROL_DELTA = flagNumber(flag, 'max-control-delta', 0.5, argv)
// A contact stamp covers part of a band, so the darkening has to be spatially partial.
// A whole band shifting together is a light change, not contact occlusion.
const MIN_DARKER_FRACTION = flagNumber(flag, 'min-darker-fraction', 0.05, argv)
const LAUNCH_ARGS = [...gpuArgs({ accelerated: true }), ...vendorPinArgs(GPU)]

// Two screen bands, both below the horizon: near-tier grass sits low in the frame
// (Grass.js LOD_NEAR_DIST = 8 m, so the clumps at the player's feet), mid-tier grass
// above it. Both are populated in the same frame; the tier instance counts below say so.
const BANDS = [
  { name: 'near', y0: 0.66, y1: 0.94 },
  { name: 'mid', y0: 0.42, y1: 0.62 },
]

// Trees+rocks stamped, then trees only under ?norocks: rocks were the only scenery module
// that ever drove the field, so this arm is what a rock toggle must not switch off. Then
// rocks only (the field still carries rock stamps, so this arm separates "the field drives
// grass" from "trees are on screen"), then nothing stamped.
const DENSITIES = [
  { name: 'stamped', query: '', gate: 'must-darken', expectRocks: true },
  { name: 'treesonly', query: '&norocks', gate: 'must-darken', expectRocks: false },
  { name: 'rocksonly', query: '&veg=none', gate: 'report', expectRocks: true },
  { name: 'nostamps', query: '&veg=none&norocks', gate: 'control', expectRocks: false },
]
const ONLY = flag('densities', null)
const ARMS = ONLY ? String(ONLY).split(',').map((n) => {
  const d = DENSITIES.find((x) => x.name === n)
  if (!d) throw new Error('--densities=' + ONLY + ': no arm named ' + n + ' in ' + DENSITIES.map((x) => x.name).join(','))
  return d
}) : DENSITIES

const port = String(20000 + Math.floor(Math.random() * 20000))
process.env.WORLD = process.env.WORLD || 'tps-game'
process.env.PORT = port
process.env.SPOINT_NO_WATCH = '1'

rebuildIfRequested('grass-contact-occ')
const { boot } = await import(pathToFileURL(resolve(ROOT, 'src', 'sdk', 'server.js')).href)
const server = await boot()
console.log('[grass-contact-occ] server on ' + port)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const readGrass = (page) => page.evaluate(() => {
  const a = window.__grass
  if (!a) return null
  const countOf = (o) => {
    if (!o) return 0
    if (o.mesh && typeof o.mesh.count === 'number') return o.mesh.count
    return typeof o.count === 'number' ? o.count : 0
  }
  return {
    totalInstances: a.totalInstances,
    nearTierInstances: countOf(a._im),
    midTierInstances: countOf(a._imMid),
    renderDistance: a.renderDistance,
  }
}).catch((e) => ({ error: e.message }))

const readPos = (page) => page.evaluate(() => {
  const c = window.__client || (window.__app && window.__app.client)
  const st = c && c.getLocalState ? c.getLocalState() : null
  const q = st ? st.position : null
  if (!q) return null
  if (typeof q.x === 'number') return { x: +q.x.toFixed(2), z: +q.z.toFixed(2) }
  if (q.length >= 3) return { x: +q[0].toFixed(2), z: +q[2].toFixed(2) }
  return null
}).catch(() => null)

// Trunk world positions. A vegetation record is one species, not one tree: the trees live
// in the instancer's CPU instance-matrix buffer, translation at floats 12..14 of each
// 16-float slot. No rebase happens inside a run (FloatingOrigin.REBASE_THRESHOLD_M is
// 8000 m and the player never travels), so those are world coordinates.
const readTrees = (page) => page.evaluate(() => {
  const veg = window.__veg
  const out = { trees: [], species: 0, source: null }
  if (!veg || !Array.isArray(veg._meshes) || !veg._meshes.length) { out.error = 'no vegetation api'; return out }
  const seen = new Set()
  for (const rec of veg._meshes) {
    const b = rec && rec.branch
    if (!b) continue
    out.species++
    const cands = []
    if (b.mesh) cands.push([b.mesh, b.count ?? b.mesh.count ?? 0])
    if (Array.isArray(b.tierMeshes)) for (const m of b.tierMeshes) cands.push([m, b.count ?? m.count ?? 0])
    if (b.shadowMesh) cands.push([b.shadowMesh, b.count ?? 0])
    for (const [m, n] of cands) {
      const im = m && m.instanceMatrix && m.instanceMatrix.array
      if (!im) continue
      const cap = Math.min(n || 0, Math.floor(im.length / 16))
      for (let i = 0; i < cap; i++) {
        const x = im[i * 16 + 12], z = im[i * 16 + 14]
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue
        if (Math.abs(x) < 1e-6 && Math.abs(z) < 1e-6) continue
        const key = Math.round(x) + ':' + Math.round(z)
        if (seen.has(key)) continue
        seen.add(key)
        out.trees.push([+x.toFixed(2), +z.toFixed(2)])
      }
      out.source = out.source || 'branch.mesh'
      break
    }
  }
  return out
}).catch((e) => ({ trees: [], error: e.message }))

// ?norocks has to keep meaning "no rocks render". window.__rocks exists only once createRocks
// has run and window.__rocksProfile only once its update has, so both being absent is a counted
// zero rock instances, not an unread one.
const readRocks = (page) => page.evaluate(() => {
  const api = window.__rocks || (window.__app && window.__app.rocks) || null
  let totalInstances = 0
  if (api) { try { totalInstances = typeof api.totalInstances === 'number' ? api.totalInstances : 0 } catch (_) { totalInstances = -1 } }
  return { modulePresent: !!window.__rocks, appHandle: !!(window.__app && window.__app.rocks), totalInstances, updateRan: !!window.__rocksProfile }
}).catch((e) => ({ error: e.message }))

// The contact-occlusion field's own drive counter: ticks that had a usable focus, recentres of
// the 512 m window, and uploads of the field to the GPU. Zero uploads is the inert field,
// whatever the pixels happen to say.
const readContactDrive = (page) => page.evaluate(() => (window.__contactOcclusionDrive ? JSON.parse(JSON.stringify(window.__contactOcclusionDrive)) : null)).catch(() => null)

// Re-arms the time-of-day pin (which suppresses the server's own sync for 8 s), pins the
// governor tier and freezes the grass sway. Called immediately before every capture.
const pinScene = (page) => page.evaluate((frac) => {
  const out = { tod: false, governor: false, wind: false, fraction: null, paused: null, tier: null }
  const tod = window.__timeOfDayApi
  if (tod) {
    try {
      tod.setPaused(true)
      tod.setFraction(frac)
      out.tod = true
      out.fraction = tod.getFraction()
      out.paused = tod.isPaused()
    } catch (_) {}
  }
  const gov = window.__qualityGovernorApi
  if (gov && typeof gov.setTier === 'function') {
    try { gov.setTier(0); out.governor = true } catch (_) {}
    try { const s = gov.state ? gov.state() : window.__qualityGovernorState; out.tier = s ? s.tier : null } catch (_) {}
  }
  try { window.__grassWind = 0; out.wind = true } catch (_) {}
  return out
}, TOD_FRACTION).catch((e) => ({ error: e.message }))

const readTod = (page) => page.evaluate(() => {
  const t = window.__timeOfDayApi
  return t ? { fraction: t.getFraction(), paused: t.isPaused() } : null
}).catch(() => null)

// Relocate to a stated stand-off from a real trunk. The near band only carries a contact
// stamp when vegetation is within a few metres, and where the spawn point puts the player
// is not under this witness's control.
async function relocateBesideTree(page, label) {
  const read = await readTrees(page)
  const pos = await readPos(page)
  console.log(`[grass-contact-occ] ${label}: read ${read.trees.length} trunk(s) of ${read.species} species from ${read.source}${read.error ? ' error=' + read.error : ''} at ${JSON.stringify(pos)}`)
  if (!read.trees.length || !pos) return { error: read.error || (read.trees.length ? 'no local state' : 'no trunk positions readable') }
  const ranked = read.trees
    .map(([x, z]) => ({ x, z, d: Math.hypot(x - pos.x, z - pos.z) }))
    .sort((a, b) => a.d - b.d)
  let plan = null
  for (const t of ranked) {
    const k = t.d > 0 ? STAND_M / t.d : 0
    const sx = t.x + (pos.x - t.x) * k
    const sz = t.z + (pos.z - t.z) * k
    let ok = true
    for (const o of read.trees) if (Math.hypot(o[0] - sx, o[1] - sz) < TRUNK_CLEAR_M) { ok = false; break }
    if (!ok) continue
    plan = { from: pos, tree: { x: +t.x.toFixed(2), z: +t.z.toFixed(2), distance: +t.d.toFixed(2) }, stand: { x: +sx.toFixed(2), z: +sz.toFixed(2) } }
    break
  }
  if (!plan) return { error: `no trunk with a ${STAND_M} m stand-off clear of ${TRUNK_CLEAR_M} m (${ranked.length} trunk(s))` }
  console.log(`[grass-contact-occ] ${label}: stand plan ${JSON.stringify(plan)}`)
  await page.evaluate(({ x, z }) => {
    window.__goReport = null
    window.__spoint.go({ x, z })
      .then((r) => { window.__goReport = { ms: r.ms, frames: r.frames, placed: r.placed } })
      .catch((e) => { window.__goReport = { error: String((e && e.message) || e) } })
  }, plan.stand)
  const t0 = Date.now()
  let report = null
  while (Date.now() - t0 < 120000) {
    report = await page.evaluate(() => window.__goReport || null).catch(() => null)
    if (report) break
    await sleep(500)
  }
  plan.moved = report || { error: 'window.__spoint.go never reported' }
  console.log(`[grass-contact-occ] ${label}: moved ${JSON.stringify(plan.moved)}`)
  return plan
}

// Grass streams in for minutes after a relocation. Capturing mid-load measures blades
// arriving, not the darkening term, so wait for the instance counts to hold first.
async function waitStableGrass(page) {
  let last = null
  let sameFor = 0
  const t0 = Date.now()
  while (Date.now() - t0 < STABLE_TIMEOUT_MS) {
    const g = await readGrass(page)
    const key = g ? `${g.totalInstances}/${g.nearTierInstances}/${g.midTierInstances}` : 'null'
    if (key === last) sameFor += 1000
    else { sameFor = 0; last = key }
    if (sameFor >= STABLE_HOLD_MS) return { stable: true, counts: last, ms: Date.now() - t0 }
    await sleep(1000)
  }
  return { stable: false, counts: last, ms: Date.now() - t0 }
}

// Aim so both bands actually frame grass. Standing beside a trunk, most headings put the
// trunk and its canopy over the whole lower frame, which leaves the near band with a few
// hundred grass pixels and nothing to say.
async function pickYaw(page, label) {
  const results = []
  for (let i = 0; i < YAW_STEPS; i++) {
    const yaw = (i / YAW_STEPS) * Math.PI * 2
    await page.evaluate((y) => { if (window.__camera && window.__camera.setVRYaw) window.__camera.setVRYaw(y) }, yaw).catch(() => {})
    await sleep(300)
    const img = decodePng((await page.screenshot()).toString('base64'))
    results.push({
      yaw: +yaw.toFixed(3),
      near: masksOf(img, BANDS[0].y0, BANDS[0].y1).grass.length,
      mid: masksOf(img, BANDS[1].y0, BANDS[1].y1).grass.length,
    })
  }
  const best = results.slice().sort((a, b) => (b.near - a.near) || (b.mid - a.mid))[0]
  await page.evaluate((y) => { if (window.__camera && window.__camera.setVRYaw) window.__camera.setVRYaw(y) }, best.yaw).catch(() => {})
  await sleep(300)
  console.log(`[grass-contact-occ] ${label}: yaw sweep ${JSON.stringify(results)} -> ${JSON.stringify(best)}`)
  return best
}

async function captureFrame(page, termOff) {
  await page.evaluate((v) => { window.__grassContactOccOff = v }, termOff).catch(() => {})
  const pin = await pinScene(page)
  await sleep(ARM_MS)
  const shot = await page.screenshot()
  const after = await readTod(page)
  return { shot, pin, after }
}

function classify(r, g, b) {
  if (b > r + 40 && b > 150) return 'sky'
  if (g > r + 10 && g >= b) return 'grass'
  if (b > g && b > r + 20) return 'water'
  return 'terrain'
}

const LUM = [0.2126, 0.7152, 0.0722]

function horizonOf(img) {
  const { w, h, rgb } = img
  for (let y = 0; y < h; y++) {
    let skyish = 0
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (classify(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]) === 'sky') skyish++
    }
    if (skyish < 0.5 * w) return y
  }
  return 0
}

// The masks come from the FIRST frame of a pair alone and are reused for the second.
// Classifying each frame separately would let a grass pixel that darkens migrate into the
// terrain mask, which shows up as terrain motion that is really grass motion.
function masksOf(img, y0f, y1f) {
  const { w, h, rgb } = img
  const y0 = Math.floor(y0f * h), y1 = Math.floor(y1f * h)
  const horizon = horizonOf(img)
  const grass = [], terrain = []
  for (let y = Math.max(y0, horizon); y < y1 && y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const k = classify(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2])
      if (k === 'grass') grass.push(i)
      else if (k === 'terrain') terrain.push(i)
    }
  }
  return { horizon, grass, terrain }
}

function meanLuma(img, idx) {
  if (!idx.length) return null
  let s = 0
  for (const i of idx) s += img.rgb[i * 3] * LUM[0] + img.rgb[i * 3 + 1] * LUM[1] + img.rgb[i * 3 + 2] * LUM[2]
  return s / idx.length
}

function pairDelta(off, on, y0f, y1f) {
  const m = masksOf(off, y0f, y1f)
  const grassOff = meanLuma(off, m.grass)
  const grassOn = meanLuma(on, m.grass)
  const terrainOff = meanLuma(off, m.terrain)
  const terrainOn = meanLuma(on, m.terrain)
  let darker = 0
  for (const i of m.grass) {
    const la = off.rgb[i * 3] * LUM[0] + off.rgb[i * 3 + 1] * LUM[1] + off.rgb[i * 3 + 2] * LUM[2]
    const lb = on.rgb[i * 3] * LUM[0] + on.rgb[i * 3 + 1] * LUM[1] + on.rgb[i * 3 + 2] * LUM[2]
    if (lb < la - 1) darker++
  }
  return {
    band: `${y0f}-${y1f}`,
    horizon: m.horizon,
    grassPixels: m.grass.length,
    grassLumaOff: grassOff === null ? null : +grassOff.toFixed(3),
    grassLumaOn: grassOn === null ? null : +grassOn.toFixed(3),
    grassDelta: (grassOff === null || grassOn === null) ? null : +(grassOn - grassOff).toFixed(3),
    grassDarkerFraction: m.grass.length ? +(darker / m.grass.length).toFixed(4) : null,
    terrainPixels: m.terrain.length,
    terrainDelta: (terrainOff === null || terrainOn === null) ? null : +(terrainOn - terrainOff).toFixed(3),
  }
}

let browser
let failed = 0
const reasons = []
const rows = []
let standAt = null
try {
  browser = await chromium.launch({ args: LAUNCH_ARGS })
  for (const density of ARMS) {
    const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT })
    const errors = []
    page.on('pageerror', (e) => errors.push(String((e && e.stack) || (e && e.message) || e)))
    const at = standAt || AT
    const url = `http://localhost:${port}/?singleplayer&world=tps-game&at=${encodeURIComponent(at)}${density.query}&v=${Date.now()}`
    console.log(`[grass-contact-occ] ${density.name}: ${url}`)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })

    const servedRoot = await assertServedClientRoot(page, { want: CLIENT_ROOT_BUNDLE, label: 'grass-contact-occ' })
    console.log(`[grass-contact-occ] ${density.name}: served ${clientRootTag(servedRoot)} required=${CLIENT_ROOT_BUNDLE}`)

    const t0 = Date.now()
    let revealedAt = null
    while (Date.now() - t0 < 300000) {
      const r = await page.evaluate(() => ({ revealedAt: (window.__app && window.__app.revealedAt) || 0 })).catch(() => null)
      if (r && r.revealedAt) { revealedAt = r.revealedAt; break }
      await sleep(250)
    }
    if (!revealedAt) { failed = 1; reasons.push(`${density.name}: scenery never built`); await page.close().catch(() => {}); continue }
    const gpu = await assertGpu(page, { requireAccelerated: true, expectVendor: EXPECT_VENDOR })
    const rendererInfo = await page.evaluate(() => (window.__rendererInfo ? JSON.parse(JSON.stringify(window.__rendererInfo)) : null)).catch(() => null)
    console.log(`[grass-contact-occ] ${density.name}: gpu ${JSON.stringify(gpu)} rendererInfo ${JSON.stringify(rendererInfo)}`)
    if (!rendererInfo) { failed = 1; reasons.push(`${density.name}: window.__rendererInfo is absent, so the adapter was never asserted`) }

    const tSettle = Date.now()
    let grass = null
    while (Date.now() - tSettle < SETTLE_MS) { await sleep(2500); grass = await readGrass(page) }

    // The first arm picks the vantage; later arms reuse its coordinates, because an arm
    // with vegetation switched off has no trunk to plan a stand-off from. This has to run
    // AFTER the settle: a relocation before the world has finished building can be undone
    // by respawn, which leaves the capture 25 m from the stand it planned.
    let stand = null
    if (!standAt) {
      for (let i = 0; i < RELOCATE_ATTEMPTS; i++) {
        stand = await relocateBesideTree(page, density.name)
        if (!stand || !stand.stand) break
        standAt = `${stand.stand.x},${stand.stand.z}`
        await sleep(RELOCATE_SETTLE_MS)
        const p = await readPos(page)
        const off = p ? Math.hypot(p.x - stand.stand.x, p.z - stand.stand.z) : Infinity
        stand.landedAt = p
        stand.landedOffsetM = Number.isFinite(off) ? +off.toFixed(2) : null
        console.log(`[grass-contact-occ] ${density.name}: relocation ${i + 1} landed ${JSON.stringify(stand.landedAt)} offset ${stand.landedOffsetM} m`)
        if (Number.isFinite(off) && off <= MAX_LAND_OFFSET_M) break
      }
      if (!stand || !stand.stand) { failed = 1; reasons.push(`${density.name}: could not plan a stand-off from a trunk (${JSON.stringify(stand)})`) }
      else if (!(Number.isFinite(stand.landedOffsetM) && stand.landedOffsetM <= MAX_LAND_OFFSET_M)) {
        failed = 1
        reasons.push(`${density.name}: the player landed ${stand.landedOffsetM} m from the planned stand, over ${MAX_LAND_OFFSET_M} m, so this capture is not standing where it planned to`)
      }
    }

    const stable = await waitStableGrass(page)
    console.log(`[grass-contact-occ] ${density.name}: grass stable ${JSON.stringify(stable)}`)
    if (!stable.stable) { failed = 1; reasons.push(`${density.name}: grass instance counts never held (${stable.counts}), so this capture would measure grass streaming in`) }
    const yaw = await pickYaw(page, density.name)
    if (!yaw || yaw.near < MIN_GRASS_PX || yaw.mid < MIN_GRASS_PX) { failed = 1; reasons.push(`${density.name}: the best heading frames ${yaw ? yaw.near : 0} near-band and ${yaw ? yaw.mid : 0} mid-band grass pixels, below ${MIN_GRASS_PX}`) }
    grass = await readGrass(page)
    const pos = await readPos(page)
    const trees = await readTrees(page)
    const rocks = await readRocks(page)
    const contactDrive = await readContactDrive(page)
    console.log(`[grass-contact-occ] ${density.name}: rocks ${JSON.stringify(rocks)} contactDrive ${JSON.stringify(contactDrive)}`)
    const nearest = trees.trees.reduce((best, [x, z]) => {
      const d = pos ? Math.hypot(x - pos.x, z - pos.z) : Infinity
      return Math.min(best, d)
    }, Infinity)
    const nearestTreeM = Number.isFinite(nearest) ? +nearest.toFixed(2) : null
    console.log(`[grass-contact-occ] ${density.name}: grass ${JSON.stringify(grass)} position ${JSON.stringify(pos)} nearestTreeM ${nearestTreeM}`)
    if (!grass || grass.error) { failed = 1; reasons.push(`${density.name}: window.__grass unreadable (${grass ? grass.error : 'null'}), so no instance count backs this capture`) }
    else if (!grass.nearTierInstances || !grass.midTierInstances) {
      failed = 1
      reasons.push(`${density.name}: near tier ${grass.nearTierInstances} / mid tier ${grass.midTierInstances} instances, so one grass LOD band is empty and this capture cannot speak for it`)
    }
    if (density.name === 'stamped' && (nearestTreeM === null || nearestTreeM > MAX_STAND_TREE_M)) {
      failed = 1
      reasons.push(`${density.name}: nearest trunk is ${nearestTreeM} m away, over ${MAX_STAND_TREE_M} m, so the near band carries no contact stamp`)
    }
    const wantRocks = density.expectRocks === true
    if (rocks.error) { failed = 1; reasons.push(`${density.name}: rocks state unreadable (${rocks.error})`) }
    else if (!!rocks.modulePresent !== wantRocks) {
      failed = 1
      reasons.push(`${density.name}: the rocks module is ${rocks.modulePresent ? 'present' : 'absent'} but this arm expects rocks ${wantRocks ? 'on' : 'off'}, so the toggle no longer means what it says`)
    } else if (wantRocks && !(rocks.totalInstances > 0)) {
      failed = 1
      reasons.push(`${density.name}: rocks are on but ${rocks.totalInstances} instances are placed, so this arm is not standing in rock scenery`)
    } else if (!wantRocks && (rocks.totalInstances !== 0 || rocks.updateRan)) {
      failed = 1
      reasons.push(`${density.name}: rocks are off but ${rocks.totalInstances} instances are placed and rocks.update ${rocks.updateRan ? 'ran' : 'did not run'}, so rocks are rendering`)
    }
    if (!contactDrive) { failed = 1; reasons.push(`${density.name}: window.__contactOcclusionDrive is absent, so the contact field was never driven`) }
    else if (!(contactDrive.ticks > 0 && contactDrive.recentres > 0 && contactDrive.uploads > 0)) {
      failed = 1
      reasons.push(`${density.name}: the contact field drive counted ticks=${contactDrive.ticks} recentres=${contactDrive.recentres} uploads=${contactDrive.uploads}, so the field never reached the GPU`)
    }

    // Four frames: OFF, ON, ON, OFF. Taking the ON-OFF difference in both time orders
    // separates the term from a scene that is still moving on its own: with a drift D per
    // interval and the term's effect E, ON-OFF is D+E forwards and E-D backwards, so E is
    // the mean of the two and D is their half-difference. Both masks come from an OFF frame.
    let seq = null
    for (let attempt = 1; attempt <= STILL_ATTEMPTS; attempt++) {
      const a = await captureFrame(page, true)
      const b = await captureFrame(page, false)
      const c = await captureFrame(page, false)
      const d = await captureFrame(page, true)
      const ia = decodePng(a.shot.toString('base64'))
      const ib = decodePng(b.shot.toString('base64'))
      const ic = decodePng(c.shot.toString('base64'))
      const id = decodePng(d.shot.toString('base64'))
      const ab = BANDS.map((x) => ({ name: x.name, ...pairDelta(ia, ib, x.y0, x.y1) }))
      const cd = BANDS.map((x) => ({ name: x.name, ...pairDelta(id, ic, x.y0, x.y1) }))
      const bands = ab.map((x, i) => ({
        name: x.name,
        band: x.band,
        horizon: x.horizon,
        grassPixels: x.grassPixels,
        grassLumaOff: +((ab[i].grassLumaOff + cd[i].grassLumaOff) / 2).toFixed(3),
        grassLumaOn: +((ab[i].grassLumaOn + cd[i].grassLumaOn) / 2).toFixed(3),
        grassDelta: +((ab[i].grassDelta + cd[i].grassDelta) / 2).toFixed(3),
        grassDrift: +((ab[i].grassDelta - cd[i].grassDelta) / 2).toFixed(3),
        grassDarkerFraction: +((ab[i].grassDarkerFraction + cd[i].grassDarkerFraction) / 2).toFixed(4),
        terrainPixels: x.terrainPixels,
        terrainDelta: +((ab[i].terrainDelta + cd[i].terrainDelta) / 2).toFixed(3),
        terrainDrift: +((ab[i].terrainDelta - cd[i].terrainDelta) / 2).toFixed(3),
      }))
      const held = [a, b, c, d].every((f) => f.after && Math.abs(f.after.fraction - TOD_FRACTION) <= TOD_TOL)
      const still = bands.every((x) => Math.abs(x.grassDrift) <= MAX_CONTROL_DELTA)
      console.log(`[grass-contact-occ] ${density.name}: attempt ${attempt} still=${still} todHeld=${held} fractions ${[a, b, c, d].map((f) => f.after && f.after.fraction).join('/')}`)
      seq = { a, b, c, d, bands, attempt, still, held }
      if (still && held) break
    }
    const frames = seq
    for (const b of frames.bands) console.log(`[grass-contact-occ] ${density.name}/${b.name}: ${JSON.stringify(b)}`)
    if (!frames.a.pin.tod) { failed = 1; reasons.push(`${density.name}: window.__timeOfDayApi absent, so the two arms are not comparable`) }
    if (!frames.a.pin.governor) { failed = 1; reasons.push(`${density.name}: window.__qualityGovernorApi absent, so the governor tier cannot be pinned`) }
    for (const f of [frames.a, frames.b, frames.c, frames.d]) {
      if (f.after && f.after.fraction !== null && Math.abs(f.after.fraction - TOD_FRACTION) > TOD_TOL) {
        failed = 1
        reasons.push(`${density.name}: time of day read back ${f.after.fraction} on a captured frame after pinning ${TOD_FRACTION}, so the sun moved under the capture`)
        break
      }
    }

    mkdirSync(OUT_DIR, { recursive: true })
    const tag = `${LABEL}-${density.name}`
    const pOff = resolve(OUT_DIR, `${tag}-off.png`)
    const pOn = resolve(OUT_DIR, `${tag}-on.png`)
    const pOn2 = resolve(OUT_DIR, `${tag}-on2.png`)
    const pOff2 = resolve(OUT_DIR, `${tag}-off2.png`)
    writeFileSync(pOff, frames.a.shot)
    writeFileSync(pOn, frames.b.shot)
    writeFileSync(pOn2, frames.c.shot)
    writeFileSync(pOff2, frames.d.shot)
    console.log(`[grass-contact-occ] ${density.name}: png ${pOff} + ${pOn} + ${pOn2} + ${pOff2}`)

    for (const b of frames.bands) {
      const name = `${density.name}/${b.name}`
      if (b.grassPixels < MIN_GRASS_PX) {
        failed = 1
        reasons.push(`${name}: only ${b.grassPixels} grass pixels, below ${MIN_GRASS_PX}, so this band says nothing about grass`)
        continue
      }
      if (Math.abs(b.grassDrift) > MAX_CONTROL_DELTA) {
        failed = 1
        reasons.push(`${name}: the scene drifted ${b.grassDrift} luma per capture interval on its own, so ${b.grassDelta} cannot be attributed to the term`)
        continue
      }
      // Terrain rides the same field but is not touched by the grass term. Its delta is
      // REPORTED, never gated: the classifier sorts a darkened grass blade into the terrain
      // bucket (g > r + 10 stops holding once the blade is dark), so in a stamped arm the
      // "terrain" mask is mostly grass and its delta moves with the term by design. The
      // scene-stillness gate is the drift figure, and the no-stamp arm is the control.
      if (density.gate === 'must-darken') {
        if (!(b.grassDelta < -MIN_DROP_LUMA)) {
          failed = 1
          reasons.push(`${name}: grass luminance delta ${b.grassDelta} is not darker by at least ${MIN_DROP_LUMA}`)
        }
        if (b.grassDarkerFraction < MIN_DARKER_FRACTION) {
          failed = 1
          reasons.push(`${name}: only ${b.grassDarkerFraction} of grass pixels got darker, below ${MIN_DARKER_FRACTION}, so this reads as a global light change rather than contact darkening`)
        }
      } else if (density.gate === 'control') {
        if (Math.abs(b.grassDelta) > MAX_CONTROL_DELTA) {
          failed = 1
          reasons.push(`${name}: grass luminance delta ${b.grassDelta} with no tree or rock stamps, so the darkening is not coming from the contact field`)
        }
      }
    }

    rows.push({
      density: density.name, gate: density.gate, url, gpu, rendererInfo, grass, rocks, contactDrive, pos,
      nearestTreeM, trunks: trees.trees.length, yaw,
      stand: stand ? { tree: stand.tree, stand: stand.stand, moved: stand.moved } : null,
      pinned: frames.a.pin,
      attempt: frames.attempt,
      todAfter: [frames.a.after, frames.b.after, frames.c.after, frames.d.after],
      bands: frames.bands,
      off: pOff, on: pOn, on2: pOn2, off2: pOff2, errors: errors.slice(0, 5),
    })
    if (errors.length) { failed = 1; reasons.push(`${density.name}: ${errors.length} page error(s): ${errors[0].slice(0, 200)}`) }
    await page.close().catch(() => {})
  }
} catch (e) {
  failed = 1
  reasons.push(String((e && e.stack) || e))
} finally {
  if (browser) await browser.close().catch((e) => console.log('[grass-contact-occ] browser.close: ' + ((e && e.message) || e)))
  try { await server.stop() } catch (e) { console.log('[grass-contact-occ] server.stop: ' + ((e && e.message) || e)) }
}

const metaPath = resolve(OUT_DIR, `${LABEL}.json`)
try {
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(metaPath, JSON.stringify({ label: LABEL, at: AT, standAt, viewport: [VIEWPORT_W, VIEWPORT_H], bands: BANDS, standM: STAND_M, rows }, null, 2))
} catch (_) {}
console.log('[grass-contact-occ] meta ' + metaPath)
for (const r of reasons) console.log('FAIL: ' + r)
console.log(`RESULT: ${failed ? 'FAIL' : 'PASS'} label=${LABEL} -- ${reasons.length} failure(s)`)
process.exit(failed ? 1 : 0)
