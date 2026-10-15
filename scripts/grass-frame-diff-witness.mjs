#!/usr/bin/env node
// Grass frame capture + per-band difference instrument (PERF-grass-capture-harness-1013).
//
// A still frame at a pinned pose, pinned time of day and pinned wind is captured as a set of
// frames: two reference renders (R1, R2) with grass on, one with the grass batches hidden (H), and
// one reference render after the restore (R3). From these it reports, per DISTANCE band taken from
// the grass density law (near = [0,FULL_R), mid = [FULL_R,EDGE), far = [EDGE,ring)):
//   - the noise floor: mean absolute difference per RGB channel between R1 and R2,
//   - the grass signal: mean absolute difference between R1 and H,
//   - the repeat: mean absolute difference between R1 and R3.
// Non-vacuity is part of the verdict: a band whose grass signal does not clear 2x its noise floor
// is inconclusive, and when no band admits, the run is REFUSED and publishes no number.
// The adapter is pinned with vendorPinArgs and window.__rendererInfo must be WebGPURenderer on the
// webgpu backend, else the run is REFUSED. Browser arm: never runs in the gpu-free gate.
//   SPOINT_GPU_WITNESS=1 node scripts/gpulock.mjs run grass-frame-diff -- \
//     node scripts/grass-frame-diff-witness.mjs --gpu=amd --out=<scratch dir>
// Exit: 0 PASS, 1 FAIL, 3 REFUSED.
import { resolve, dirname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, DEFAULT_VIEWPORT } from './lib/cdp-browser.mjs'
import { gpuArgs, assertGpu } from './lib/gpu-probe.mjs'
import { vendorPinArgs } from './lib/witness-gpu.mjs'
import {
  assertServedClientRoot, clientRootTag, rebuildIfRequested, CLIENT_ROOT_BUNDLE,
} from './lib/served-client-root.mjs'
import { flagNumber } from './lib/witness-args.mjs'
import { decodePNG, encodePNG, cropRows, meanAbsDiff } from './lib/png-rgba.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

if (process.env.SPOINT_GPU_WITNESS !== '1') {
  console.log('SKIP grass-frame-diff-witness: SPOINT_GPU_WITNESS is not 1 (reaches cdp-browser/WebGPU, not run in the gpu-free arm)')
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

const GPU = String(flag('gpu', 'amd'))
const AT = String(flag('at', '-15,-12.5'))
const LABEL = String(flag('label', 'run'))
const OUT_DIR = String(flag('out', join(tmpdir(), 'grass-frame-diff')))
const TOD_FRACTION = flagNumber(flag, 'tod', 0.34, argv)
const SETTLE_MS = flagNumber(flag, 'settle', 25000, argv)
const VIEWPORT_W = flagNumber(flag, 'w', DEFAULT_VIEWPORT.width, argv)
const VIEWPORT_H = flagNumber(flag, 'h', DEFAULT_VIEWPORT.height, argv)
const ADMIT_RATIO = flagNumber(flag, 'admit-ratio', 2, argv)
const REPEAT_FLOOR_RATIO = flagNumber(flag, 'repeat-floor-ratio', 2, argv)
const LAUNCH_ARGS = [...gpuArgs({ accelerated: true }), ...vendorPinArgs(GPU)]

// Projects a world point with the camera the frame was rendered with. Installed before any page
// script so it is available as soon as the scene exists.
const PROBE = `(() => {
  window.__gfdProject = function (x, y, z, vw, vh) {
    const cam = window.__camera
    if (!cam || !cam.projectionMatrix || !cam.matrixWorldInverse) return null
    const e1 = cam.matrixWorldInverse.elements, e2 = cam.projectionMatrix.elements
    const v = [x, y, z, 1]
    const c = [0, 0, 0, 0]
    for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) c[r] += e1[r + 4 * k] * v[k]
    const p = [0, 0, 0, 0]
    for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) p[r] += e2[r + 4 * k] * c[k]
    if (!p[3]) return null
    const nx = p[0] / p[3], ny = p[1] / p[3], nz = p[2] / p[3]
    return { sx: (nx * 0.5 + 0.5) * vw, sy: (1 - (ny * 0.5 + 0.5)) * vh, z: nz }
  }
})()`

const port = String(20000 + Math.floor(Math.random() * 20000))
process.env.WORLD = process.env.WORLD || 'tps-game'
process.env.PORT = port
process.env.SPOINT_NO_WATCH = '1'

rebuildIfRequested('grass-frame-diff')
const { boot } = await import(pathToFileURL(resolve(ROOT, 'src', 'sdk', 'server.js')).href)
const server = await boot()
console.log('[grass-frame-diff] server on ' + port)

let browser
let failed = 0
let refused = null
const reasons = []
const checks = []
const expect = (name, ok, detail) => {
  checks.push({ check: name, ok: !!ok, detail })
  console.log((ok ? '  [PASS] ' : '  [FAIL] ') + name + ': ' + detail)
  if (!ok) { failed++; reasons.push(name + ': ' + detail) }
}
const refuse = (why) => { if (!refused) refused = why }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const meta = { label: LABEL, gpu: GPU, at: AT, viewport: [VIEWPORT_W, VIEWPORT_H], frames: {}, bands: [], verdict: null }

try {
  browser = await chromium.launch({ args: LAUNCH_ARGS })
  const page = await browser.newPage({ viewport: { width: VIEWPORT_W, height: VIEWPORT_H } })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String((e && e.stack) || (e && e.message) || e)))
  await page._send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE })
  const url = `http://localhost:${port}/?singleplayer&world=tps-game&at=${encodeURIComponent(AT)}&v=${Date.now()}`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })
  const servedRoot = await assertServedClientRoot(page, { want: CLIENT_ROOT_BUNDLE, label: 'grass-frame-diff' })
  console.log(`[grass-frame-diff] served ${clientRootTag(servedRoot)} required=${CLIENT_ROOT_BUNDLE}`)
  meta.servedClientRoot = servedRoot.sha256

  const t0 = Date.now()
  let revealedAt = 0
  while (Date.now() - t0 < 300000) {
    const r = await page.evaluate(() => (window.__app && window.__app.revealedAt) || 0).catch(() => 0)
    if (r) { revealedAt = r; break }
    await sleep(250)
  }
  if (!revealedAt) refuse('scenery never built, so no frame exists to capture')

  // Adapter and renderer pin. A WebGL fallback runs a different shader path, so it is refused
  // before any frame is read.
  const renderer = await page.evaluate(() => {
    const ri = window.__rendererInfo || null
    const r = (window.__app && (window.__app.renderer || (window.__app.engine && window.__app.engine.renderer))) || null
    return { info: ri, isWebGPURenderer: r ? !!r.isWebGPURenderer : null, backendIsWebGPU: r && r.backend ? !!r.backend.isWebGPUBackend : null }
  }).catch((e) => ({ error: e.message }))
  meta.renderer = renderer
  const isWebGPU = !!(renderer.info && renderer.info.class === 'WebGPURenderer' && renderer.info.backend === 'webgpu' && renderer.backendIsWebGPU === true)
  if (!isWebGPU) refuse(`renderer is not WebGPURenderer on the webgpu backend (class=${renderer.info && renderer.info.class} backend=${renderer.info && renderer.info.backend})`)
  expect('the page really runs WebGPURenderer on the webgpu backend', isWebGPU,
    `window.__rendererInfo class=${renderer.info && renderer.info.class} backend=${renderer.info && renderer.info.backend}`)
  const gpu = await assertGpu(page, { requireAccelerated: true, expectVendor: GPU })
  meta.gpu = { rasterizer: gpu.rasterizer, renderer: gpu.renderer, vendor: gpu.adapter }

  // Deterministic configuration: time of day paused, wind zeroed, governor off so it cannot re-shed
  // a tier between captures.
  const pinned = await page.evaluate((frac) => {
    const api = window.__timeOfDayApi
    if (api) { try { api.setPaused(true); api.setFraction(frac) } catch (_) {} }
    const rc = window.__renderControls
    if (rc && typeof rc.set === 'function') rc.set('qualityGovernorOff', true)
    window.__grassWind = 0
    return { tod: !!api, governorOff: !!window.__qualityGovernorOff, wind: window.__grassWind }
  }, TOD_FRACTION).catch((e) => ({ error: e.message }))
  meta.pinned = pinned
  expect('time of day, wind and governor are pinned', pinned.tod === true && pinned.wind === 0 && pinned.governorOff === true,
    JSON.stringify(pinned))
  if (!pinned.tod) refuse('window.__timeOfDayApi is absent, so the frames are not comparable')

  await sleep(SETTLE_MS)

  // Freeze the clock after the scene has built. Grass sway, the water and the weather all advance
  // on performance.now / Date.now through the frame delta, so a frozen clock makes every frame after
  // this point the same frame. Set after the build, never before: the build itself reads the clock.
  const clock = await page.evaluate(() => {
    const t = performance.now(), d = Date.now()
    performance.now = () => t
    Date.now = () => d
    return { t, d }
  }).catch((e) => ({ error: e.message }))
  meta.clock = clock
  expect('the frame clock is frozen after the scene settles', !!clock.t && !clock.error, JSON.stringify(clock))
  await sleep(1500)

  // Which screen rows each distance band occupies, from the blades themselves. Bands are the
  // density law's own edges, read from the live instancer.
  const geo = await page.evaluate((o) => {
    const g = window.__grass
    if (!g || !g._cells) return { ok: false, why: 'window.__grass is absent' }
    const focus = g.streamState().focus
    const px = focus[0], pz = focus[1]
    const fullR = g.densityFullR, edge = g.densityEdgeM, ring = g.renderDistance
    const acc = [[], [], []]
    let present = 0
    for (const cell of g._cells.values()) {
      if (!cell || !cell.xf || !cell.on) continue
      const n = cell.on.length
      for (let i = 0; i < n; i += 2) {
        if (cell.on[i] !== 1) continue
        const oo = i * o.xfFloats
        const dx = cell.xf[oo] - px, dz = cell.xf[oo + 2] - pz
        const d = Math.sqrt(dx * dx + dz * dz)
        const p = window.__gfdProject(cell.xf[oo], cell.xf[oo + 1], cell.xf[oo + 2], o.vw, o.vh)
        if (!p || p.z > 1 || p.sy < 0 || p.sy >= o.vh || p.sx < 0 || p.sx >= o.vw) continue
        const b = d < fullR ? 0 : (d < edge ? 1 : 2)
        acc[b].push(p.sy)
        present++
      }
    }
    const pct = (arr, f) => { if (!arr.length) return null; const s = arr.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(f * s.length))] }
    return {
      ok: true, totalInstances: g.totalInstances, nearInstances: g.nearInstances,
      fullR, edge, ring, present,
      perBand: acc.map((a) => ({ n: a.length, p05: pct(a, 0.05), p50: pct(a, 0.5), p95: pct(a, 0.95) })),
    }
  }, { xfFloats: 9, vw: VIEWPORT_W, vh: VIEWPORT_H }).catch((e) => ({ ok: false, why: e.message }))
  meta.geometry = geo
  expect('the grass instancer is readable with blades in view', geo.ok && geo.present > 0,
    geo.ok ? `totalInstances=${geo.totalInstances} projected-in-view=${geo.present} fullR=${geo.fullR} edge=${geo.edge} ring=${geo.ring}` : geo.why)
  if (!geo.ok || geo.present === 0) refuse('no grass blade projects into the frame, so no band has a row to compare')

  // Band row windows: each band owns the rows between the midpoints of its median row and its
  // neighbours', so the windows are disjoint and centred on their own band.
  const BAND_NAMES = [`near [0,${geo.fullR.toFixed(1)})m`, `mid [${geo.fullR.toFixed(1)},${geo.edge.toFixed(1)})m`, `far [${geo.edge.toFixed(1)},ring ${geo.ring}m)`]
  const p50 = geo.perBand.map((b) => b.p50)
  const windows = []
  if (p50.every((v) => v !== null)) {
    const bnd = []
    for (let i = 0; i + 1 < p50.length; i++) bnd.push(Math.round((p50[i] + p50[i + 1]) / 2))
    const top = Math.max(0, Math.floor(Math.min(...geo.perBand.map((b) => (b.p05 === null ? Infinity : b.p05)))))
    for (let i = 0; i < p50.length; i++) {
      const hi = i === 0 ? VIEWPORT_H - 1 : bnd[i - 1] - 1
      const lo = i === p50.length - 1 ? Math.min(top, hi - 8) : bnd[i]
      windows.push({ lo: Math.max(0, lo), hi: Math.min(VIEWPORT_H - 1, hi) })
    }
  }

  // Captures. R1 and R2 are the reference pair (noise floor), H hides the grass batches, R3 is the
  // reference again after the restore.
  mkdirSync(OUT_DIR, { recursive: true })
  const setGrass = (on) => page.evaluate((v) => {
    const g = window.__grass
    if (!g) return false
    for (const im of [g._im, g._imMid]) { const o = im && (im.mesh || im); if (o) o.visible = v }
    return true
  }, on)
  const shot = async (name) => {
    await sleep(400)
    const p = join(OUT_DIR, `grass-frame-diff-${LABEL}-${name}.png`)
    const buf = await page.screenshot({ path: p })
    meta.frames[name] = p
    return decodePNG(buf)
  }
  const R1 = await shot('R1-ref')
  const R2 = await shot('R2-ref-repeat')
  await setGrass(false)
  const H = await shot('H-grass-hidden')
  await setGrass(true)
  const R3 = await shot('R3-ref-after-restore')

  // Per band: the three differences, each as a per-channel mean absolute difference.
  const bandRows = []
  for (let i = 0; i < 3; i++) {
    const row = { band: BAND_NAMES[i], geo: geo.perBand[i], window: windows[i] || null }
    const win = windows[i]
    if (!win) { row.inconclusive = 'the band has no blades in view, so it owns no screen rows'; bandRows.push(row); continue }
    const h = win.hi - win.lo
    if (h < 8) { row.inconclusive = `the band covers ${h} screen row(s) at this pose`; bandRows.push(row); continue }
    const cR1 = cropRows(R1, win.lo, h), cR2 = cropRows(R2, win.lo, h), cH = cropRows(H, win.lo, h), cR3 = cropRows(R3, win.lo, h)
    const noise = meanAbsDiff(cR1, cR2)
    const signal = meanAbsDiff(cR1, cH)
    const repeat = meanAbsDiff(cR1, cR3)
    const diffPng = join(OUT_DIR, `grass-frame-diff-${LABEL}-band${i}-R1vsH.png`)
    writeFileSync(diffPng, encodePNG(cR1.w, h, signal.diffImg))
    const refPng = join(OUT_DIR, `grass-frame-diff-${LABEL}-band${i}-R1.png`)
    writeFileSync(refPng, encodePNG(cR1.w, h, cR1.pixels))
    const sumNoise = noise.mad.reduce((a, b) => a + b, 0)
    const sumSignal = signal.mad.reduce((a, b) => a + b, 0)
    row.rows = win
    row.noiseFloor = noise.mad.map((v) => +v.toFixed(4))
    row.hiddenGrass = signal.mad.map((v) => +v.toFixed(4))
    row.repeat = repeat.mad.map((v) => +v.toFixed(4))
    row.signalOverNoise = sumNoise > 0 ? +(sumSignal / sumNoise).toFixed(2) : null
    row.admitted = sumSignal > ADMIT_RATIO * sumNoise
    row.png = { reference: refPng, diff: diffPng }
    bandRows.push(row)
  }
  meta.bands = bandRows

  const admitted = bandRows.filter((r) => r.admitted)
  if (!admitted.length) refuse('no band has grass signal above ' + ADMIT_RATIO + 'x its noise floor, so the harness cannot show that it moves')
  expect('the hidden-grass control moves at least one band above the noise floor', admitted.length > 0,
    `${admitted.length} of ${bandRows.length} band(s) admitted at ${ADMIT_RATIO}x`)
  const nearRow = bandRows[0]
  expect('the near band is admitted (grass present and separable from noise)', nearRow.admitted === true,
    nearRow.inconclusive ? nearRow.inconclusive : `signal/noise=${nearRow.signalOverNoise}`)
  expect('no WebGPU pipeline failed validation', pageErrors.length === 0, `${pageErrors.length} page error(s)`)

  // The repeat is a second sample of the same configuration, so its difference from R1 must sit at
  // the floor: no more than REPEAT_FLOOR_RATIO times the floor, summed over channels, in every band.
  const repeatRatio = (r) => {
    const sf = r.noiseFloor.reduce((a, b) => a + b, 0), sr = r.repeat.reduce((a, b) => a + b, 0)
    return sf > 0 ? +(sr / sf).toFixed(2) : null
  }
  for (const r of bandRows) if (!r.inconclusive) r.repeatOverFloor = repeatRatio(r)
  const reproducible = bandRows.every((r) => r.inconclusive || (r.repeatOverFloor !== null && r.repeatOverFloor <= REPEAT_FLOOR_RATIO))
  expect(`a repeated reference render sits at the noise floor (<= ${REPEAT_FLOOR_RATIO}x) in every band`, reproducible,
    bandRows.map((r) => r.inconclusive ? `${r.band}: inconclusive` : `${r.band}: repeat/floor=${r.repeatOverFloor}`).join('; '))
  meta.pageErrors = pageErrors.slice(0, 5)
} catch (e) {
  failed = 1
  reasons.push(String((e && e.stack) || e))
} finally {
  if (browser) await browser.close().catch((e) => console.log('[grass-frame-diff] browser.close: ' + ((e && e.message) || e)))
  try { await server.stop() } catch (e) { console.log('[grass-frame-diff] server.stop: ' + ((e && e.message) || e)) }
}

const metaPath = join(OUT_DIR, `grass-frame-diff-${LABEL}.json`)
if (refused) {
  meta.verdict = { result: 'REFUSED', reason: refused }
  writeFileSync(metaPath, JSON.stringify(meta, null, 2))
  console.log(`RESULT: REFUSED label=${LABEL} -- ${refused}`)
  process.exit(3)
}
meta.verdict = { result: failed ? 'FAIL' : 'PASS', reasons }
writeFileSync(metaPath, JSON.stringify(meta, null, 2))
for (const r of reasons) console.log('FAIL: ' + r)
for (const b of meta.bands) {
  if (b.inconclusive) { console.log(`MEASURED band ${b.band}: inconclusive (${b.inconclusive})`); continue }
  console.log(`MEASURED band ${b.band} rows ${b.rows.lo}..${b.rows.hi}: noise floor R/G/B=${b.noiseFloor.join('/')} hidden-grass=${b.hiddenGrass.join('/')} repeat=${b.repeat.join('/')} signal/noise=${b.signalOverNoise} admitted=${b.admitted}`)
  console.log(`  png reference=${b.png.reference} diff=${b.png.diff}`)
}
console.log(`MEASURED frames: ${JSON.stringify(meta.frames)}`)
console.log(`meta ${metaPath}`)
console.log(`RESULT: ${failed ? 'FAIL' : 'PASS'} label=${LABEL} -- ${checks.length} check(s), ${reasons.length} failure(s)`)
process.exit(failed ? 1 : 0)
