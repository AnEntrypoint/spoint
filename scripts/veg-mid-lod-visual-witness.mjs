#!/usr/bin/env node
// Visual + counted-work-unit capture of the tree LOD ladder at a stated distance.
//
// "Too low poly" is a visual claim, so this witness captures a PNG and, in the
// same frame, reads the per-tier instance counts (window.__vegProfile
// .meshTierInstances) that say how many trees were drawn with mid-tier (14-35 m)
// geometry. Triangles/frame at mid distance = mid-tier trees x mean triangles
// per tree at that tier, taken from scripts/veg-lod-poly-budget-witness.mjs.
//
// It reaches cdp-browser / WebGPURenderer, so it rides behind SPOINT_GPU_WITNESS
// and never runs in the gpu-free arm of scripts/check.mjs. Reported verdicts are
// local runs. Run under scripts/gpulock.mjs:
//   SPOINT_GPU_WITNESS=1 node scripts/gpulock.mjs run veg-mid-lod -- \
//     node scripts/veg-mid-lod-visual-witness.mjs --label=before --rebuild-bundle
import { resolve, dirname } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from './lib/cdp-browser.mjs'
import { gpuArgs, assertGpu } from './lib/gpu-probe.mjs'
import { vendorPinArgs } from './lib/witness-gpu.mjs'
import {
  assertServedClientRoot, clientRootTag, rebuildIfRequested, CLIENT_ROOT_BUNDLE,
} from './lib/served-client-root.mjs'
import { flagNumber } from './lib/witness-args.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT_DIR = resolve(ROOT, 'data', 'perf-run')

if (process.env.SPOINT_GPU_WITNESS !== '1') {
  console.log('SKIP veg-mid-lod-visual-witness: SPOINT_GPU_WITNESS is not 1 (reaches cdp-browser/WebGPURenderer, not run in the gpu-free arm)')
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
const SETTLE_MS = flagNumber(flag, 'settle', 40000, argv)
const VIEWPORT_W = flagNumber(flag, 'w', 1280, argv)
const VIEWPORT_H = flagNumber(flag, 'h', 720, argv)
// Mid-tier band, as Vegetation.js derives it: D1 = min(14, renderDistance*0.045),
// D2 = min(35, renderDistance*0.11), entered at d*(1+LOD_HYS) with LOD_HYS 0.12.
const MID_NEAR_M = 14
const MID_FAR_M = 35
const EXPECT_VENDOR = flag('expect-vendor', GPU)
// Tier ladder to capture. vegLeafOff is a DISTANCE now, so the interesting arms are the tier where
// leaves first get a cutoff (3) and the floor (5), against the booted tier (0).
const TIERS = String(flag('tiers', '0')).split(',').map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n >= 0 && n <= 5)
const LAUNCH_ARGS = [...gpuArgs({ accelerated: true }), ...vendorPinArgs(GPU)]

const port = String(20000 + Math.floor(Math.random() * 20000))
process.env.WORLD = process.env.WORLD || 'tps-game'
process.env.PORT = port
process.env.SPOINT_NO_WATCH = '1'

rebuildIfRequested('veg-mid-lod')
const { boot } = await import(pathToFileURL(resolve(ROOT, 'src', 'sdk', 'server.js')).href)
const server = await boot()
console.log('[veg-mid-lod] server on ' + port)

const readProfile = (page) => page.evaluate(() => {
  const p = window.__vegProfile || null
  return {
    total: p ? p.totalInstances : null,
    visible: p ? p.visibleInstances : null,
    mesh: p ? p.meshInstances : null,
    impostor: p ? p.impostorInstances : null,
    meshTierInstances: p ? (p.meshTierInstances || null) : null,
    leafTierInstances: p ? (p.leafTierInstances || null) : null,
    leafMeshInstances: p ? (p.leafMeshInstances ?? null) : null,
    // Read back the gate the instancer actually holds, not the knob that asked for it. Infinity is
    // the no-cutoff value and would serialize to null, so name it.
    leafGateM: p ? (p.leafGateM === undefined || p.leafGateM === null ? null
      : (Number.isFinite(p.leafGateM) ? p.leafGateM : String(p.leafGateM))) : null,
    vegDrawCalls: p ? p.vegDrawCalls : null,
    sharedImpostor: p ? !!p.sharedImpostor : null,
  }
}).catch((e) => ({ error: e.message }))

// Separate round trip so a position reader that cannot see the local state can
// never cost the per-tier instance counts above.
const readPos = (page) => page.evaluate(() => {
  const st = window.__app && window.__app.client && window.__app.client.getLocalState
    ? window.__app.client.getLocalState() : null
  const q = st ? st.position : null
  if (q && typeof q.x === 'number') return { x: +q.x.toFixed(2), y: +q.y.toFixed(2), z: +q.z.toFixed(2) }
  if (q && q.length >= 3) return { x: +q[0].toFixed(2), y: +q[1].toFixed(2), z: +q[2].toFixed(2) }
  return null
}).catch((e) => ({ unreadable: e.message }))

let browser
let failed = 0
const reasons = []
try {
  browser = await chromium.launch({ args: LAUNCH_ARGS })
  const page = await browser.newPage({ viewport: { width: VIEWPORT_W, height: VIEWPORT_H } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || (e && e.message) || e)))
  const url = `http://localhost:${port}/?singleplayer&world=tps-game&at=${encodeURIComponent(AT)}&v=${Date.now()}`
  console.log('[veg-mid-lod] ' + url)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })

  const servedRoot = await assertServedClientRoot(page, { want: CLIENT_ROOT_BUNDLE, label: 'veg-mid-lod' })
  console.log(`[veg-mid-lod] served ${clientRootTag(servedRoot)} required=${CLIENT_ROOT_BUNDLE}`)

  const t0 = Date.now()
  let revealedAt = null
  while (Date.now() - t0 < 300000) {
    const r = await page.evaluate(() => ({ revealedAt: (window.__app && window.__app.revealedAt) || 0 })).catch(() => null)
    if (r && r.revealedAt) { revealedAt = r.revealedAt; break }
    await new Promise((r2) => setTimeout(r2, 250))
  }
  if (!revealedAt) { console.log('RESULT: FAIL scenery never built'); process.exit(1) }
  const gpu = await assertGpu(page, { requireAccelerated: true, expectVendor: EXPECT_VENDOR })
  console.log('[veg-mid-lod] gpu ' + JSON.stringify({ rasterizer: gpu.rasterizer, renderer: gpu.renderer, vendor: gpu.adapter }))
  console.log('[veg-mid-lod] scenery-built at ' + revealedAt + 'ms')

  // Freeze time of day so the two arms of a before/after pair are comparable.
  const tod = await page.evaluate((frac) => {
    const api = window.__timeOfDayApi
    if (!api) return { api: false }
    try { api.setPaused(true); api.setFraction(frac) } catch (_) {}
    return { api: true, fraction: api.getFraction ? api.getFraction() : null, paused: api.isPaused ? api.isPaused() : null }
  }, TOD_FRACTION).catch((e) => ({ error: e.message }))
  console.log('[veg-mid-lod] time-of-day ' + JSON.stringify(tod))
  if (!tod.api) { failed = 1; reasons.push('window.__timeOfDayApi is absent, so time of day cannot be pinned and the two arms are not comparable') }

  const tSettle = Date.now()
  let profile = null
  while (Date.now() - tSettle < SETTLE_MS) {
    await new Promise((r2) => setTimeout(r2, 2500))
    profile = await readProfile(page)
  }

  // QualityGovernor readback, not a flag: force each tier, then read back what the governor
  // actually reports at the instant the frame is captured. leafOffM is metres, 0 = leaves
  // everywhere, so a tier that strips foliage now says how far out instead of just "on".
  const gov = await page.evaluate(() => {
    const before = window.__qualityGovernorState ? JSON.parse(JSON.stringify(window.__qualityGovernorState)) : null
    return { before, api: !!window.__qualityGovernorApi }
  }).catch((e) => ({ error: e.message }))
  console.log('[veg-mid-lod] governor ' + JSON.stringify(gov))
  if (!gov.api) { failed = 1; reasons.push('window.__qualityGovernorApi is absent, so the governor tier cannot be forced or read back') }

  // Freeze the governor's own ticking for the capture. Under a real browser load the frame time
  // sits above the budget, so a forced tier is re-shed within a second -- the first run's "tier 3"
  // row was really a tier 4 frame. setTier still applies its knobs with ticking off, so each
  // capture is the tier it names.
  const frozen = await page.evaluate(() => {
    const rc = window.__renderControls
    if (rc && typeof rc.set === 'function') rc.set('qualityGovernorOff', true)
    return { off: !!(typeof window !== 'undefined' && window.__qualityGovernorOff) }
  }).catch((e) => ({ error: e.message }))
  console.log('[veg-mid-lod] governor frozen ' + JSON.stringify(frozen))
  if (!frozen.off) { failed = 1; reasons.push('qualityGovernorOff could not be set, so a tier capture can be re-shed before the frame is read') }

  const forceTier = (t) => page.evaluate((tier) => {
    const api = window.__qualityGovernorApi
    if (api && typeof api.setTier === 'function') api.setTier(tier)
    const st = api && typeof api.state === 'function' ? api.state() : window.__qualityGovernorState
    return st ? JSON.parse(JSON.stringify(st)) : null
  }, t).catch((e) => ({ error: e.message }))

  mkdirSync(OUT_DIR, { recursive: true })
  const perTier = []
  let refBranch = null
  for (const tier of (TIERS.length ? TIERS : [0])) {
    const st = await forceTier(tier)
    // setTier rewrites the leaf gate, which invalidates every grid cell; give the instancer a few
    // frames so the captured frame is the tier's steady state, not mid-rebuild.
    await new Promise((r2) => setTimeout(r2, 3000))
    const st2 = await forceTier(tier)
    const p = await readProfile(page)
    const bands = p.meshTierInstances || []
    const leafBands = p.leafTierInstances || []
    const branchBands = bands.map((n, i) => n - (leafBands[i] || 0))
    const pngPath = resolve(OUT_DIR, `veg-mid-lod-${LABEL}-t${tier}.png`)
    await page.screenshot({ path: pngPath })
    const row = {
      tier, requestedTier: tier,
      realizedTier: (st2 && st2.tier !== undefined) ? st2.tier : null,
      png: pngPath,
      leafOffM: (st2 && st2.leafOffM !== undefined) ? st2.leafOffM : null,
      gateReadbackM: p.leafGateM,
      branchBands, leafBands,
      branchMesh: branchBands.reduce((a, b) => a + b, 0),
      leafMesh: leafBands.reduce((a, b) => a + b, 0),
      nearLeaf: leafBands[0] || 0,
      nearBranch: branchBands[0] || 0,
      vegDrawCalls: p.vegDrawCalls,
    }
    perTier.push(row)
    console.log(`[veg-mid-lod] tier ${tier} ` + JSON.stringify(row))
    if (!bands.length) { failed = 1; reasons.push(`tier ${tier}: window.__vegProfile.meshTierInstances is absent, so no per-band instance count backs this capture`) ; continue }
    if (!(row.leafMesh > 0)) { failed = 1; reasons.push(`tier ${tier}: no leaf instance drew at all, so this capture says nothing about the near/mid bands`) }
    // The complaint was that near-range trees lost their foliage while nothing on screen said why.
    if (!(row.nearLeaf > 0)) { failed = 1; reasons.push(`tier ${tier}: the near band (0-${MID_NEAR_M}m) drew ${row.nearLeaf} leaf instance(s), so the near range lost its foliage`) }
    if (row.nearBranch > 0 && row.nearLeaf !== row.nearBranch) {
      failed = 1
      reasons.push(`tier ${tier}: the near band drew ${row.nearLeaf} leaf for ${row.nearBranch} branch instance(s), so a near tree is missing its foliage`)
    }
    // Shedding foliage must never buy its saving by widening the no-mesh band.
    if (refBranch === null) refBranch = row.branchBands.join('/')
    else if (row.branchBands.join('/') !== refBranch) {
      failed = 1
      reasons.push(`tier ${tier}: the branch band ladder moved (${refBranch} -> ${row.branchBands.join('/')}), so a leaf shed changed the mesh/no-mesh distance`)
    }
    const wantGate = (st2 && st2.leafOffM > 0) ? st2.leafOffM : 'Infinity'
    if (p.leafGateM !== null && p.leafGateM !== wantGate) {
      failed = 1
      reasons.push(`tier ${tier}: the instancer holds a ${p.leafGateM}m leaf gate where the governor reported ${wantGate}m`)
    }
    if (row.realizedTier !== null && row.realizedTier !== tier) {
      failed = 1
      reasons.push(`tier ${tier}: the governor read back tier ${row.realizedTier} at capture, so this frame is not the tier it names`)
    }
  }
  const shedRows = perTier.filter((r) => r.leafOffM > 0)
  for (let i = 1; i < shedRows.length; i++) {
    if (!(shedRows[i].leafMesh < shedRows[i - 1].leafMesh)) {
      failed = 1
      reasons.push(`tier ${shedRows[i].tier} drew ${shedRows[i].leafMesh} leaf instance(s), not fewer than tier ${shedRows[i - 1].tier}'s ${shedRows[i - 1].leafMesh}`)
    }
  }
  const pos = await readPos(page)
  console.log('[veg-mid-lod] position ' + JSON.stringify(pos))

  // Frame cost, with the governor re-pinned to tier 0 every frame so the two arms
  // differ in geometry only and not in the six knobs the governor drives. rAF-to-rAF
  // wall time is vsync-quantized, so report the median, the p95 and the count of
  // frames that missed the 16.68 ms refresh period rather than a mean.
  const deltas = await page.evaluate((n) => new Promise((resolve) => {
    const d = []
    let last = performance.now()
    let i = 0
    const step = () => {
      const api = window.__qualityGovernorApi
      if (api && typeof api.setTier === 'function') api.setTier(0)
      const t = performance.now()
      d.push(t - last)
      last = t
      if (++i < n) requestAnimationFrame(step)
      else resolve(d)
    }
    requestAnimationFrame(step)
  }), 180).catch((e) => ({ error: e.message }))
  let frame = null
  if (Array.isArray(deltas)) {
    const s = deltas.slice(1).sort((a, b) => a - b)
    const at = (q) => +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(2)
    frame = {
      frames: s.length,
      medianMs: at(0.5),
      p95Ms: at(0.95),
      maxMs: +s[s.length - 1].toFixed(2),
      over16_68: s.filter((d) => d > 16.68).length,
      over33_34: s.filter((d) => d > 33.34).length,
    }
  }
  const govEnd = await page.evaluate(() => {
    const s = window.__qualityGovernorState
    return s ? { tier: s.tier, leafOffM: s.leafOffM ?? null, avgMs: s.avgMs } : null
  }).catch((e) => ({ error: e.message }))
  console.log('[veg-mid-lod] frame ' + JSON.stringify(frame) + ' governorAtEnd ' + JSON.stringify(govEnd))

  const metaPath = resolve(OUT_DIR, `veg-mid-lod-${LABEL}.json`)
  const top = perTier[0] || { branchBands: [], leafBands: [] }
  const midTrees = top.branchBands.length > 1 ? top.branchBands[1] : null
  const meta = {
    label: LABEL, url, at: AT, tod, governor: gov, pos,
    midBandM: [MID_NEAR_M, MID_FAR_M],
    midTierTrees: midTrees,
    perTier,
    frame, govEnd,
    gpu: { rasterizer: gpu.rasterizer, renderer: gpu.renderer, vendor: gpu.adapter },
    servedClientRoot: servedRoot.sha256,
    errors: errors.slice(0, 5),
  }
  writeFileSync(metaPath, JSON.stringify(meta, null, 2))
  console.log('[veg-mid-lod] meta ' + metaPath)
  for (const r of perTier) {
    console.log(`[veg-mid-lod] tier ${r.tier}: leaf cutoff ${r.leafOffM}m (read back ${r.gateReadbackM}m), ` +
      `branch near/mid/far ${r.branchBands.join('/')}, leaf ${r.leafBands.join('/')}, draws ${r.vegDrawCalls}, png ${r.png}`)
  }
  if (errors.length) { failed = 1; reasons.push(`${errors.length} page error(s): ${errors[0].slice(0, 200)}`) }
  if (midTrees === 0) { failed = 1; reasons.push('no tree was drawn with mid-tier geometry, so this capture says nothing about the mid distance') }
} catch (e) {
  failed = 1
  reasons.push(String((e && e.stack) || e))
} finally {
  if (browser) await browser.close().catch((e) => console.log('[veg-mid-lod] browser.close: ' + ((e && e.message) || e)))
  try { await server.stop() } catch (e) { console.log('[veg-mid-lod] server.stop: ' + ((e && e.message) || e)) }
}
for (const r of reasons) console.log('FAIL: ' + r)
console.log(`RESULT: ${failed ? 'FAIL' : 'PASS'} label=${LABEL} -- ${reasons.length} failure(s)`)
process.exit(failed ? 1 : 0)
