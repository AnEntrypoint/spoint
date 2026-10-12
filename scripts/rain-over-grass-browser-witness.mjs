#!/usr/bin/env node
// Browser arm of PERF-rain-over-grass: proves in a real, headful, GPU browser that rain pixels
// land ON a grass canopy once weather draws in a band above grass, and did not before.
//
// It reaches cdp-browser/gpu-probe/vendorLaunchArgs, so it is REFUSED by the gpu-free arm of
// scripts/check.mjs (NO_GPU_WITNESS_GPU_SURFACE) and is deliberately NOT listed there: it runs
// only behind SPOINT_GPU_WITNESS / a manual `scripts/gpulock.mjs run ...` invocation, and it does
// not run in this CI's gpu-free arm at all.
//
// The gpu-free half (the band ordering itself) is scripts/rain-over-grass-draw-order-witness.mjs.
//
// Measurement: rain streaks move every frame, so two frames of rain differ from each other
// whether or not the band changed. Each round therefore captures its own rain-free reference
// frame (all four weather meshes hidden) and measures each arm against THAT frame, in the grass
// canopy mask only. A round's rain-vs-rain-free count is then the amount of rain actually visible
// over the canopy, and the two rain-free frames of a round are the scene's own noise floor.
//
// Rounds are judged by MEDIANS and by how many agree in sign, never by mean over standard error:
// a scene-wide event (a lightning flash, a streaming wave, an exposure snap) lands in the counted
// pixels of the one round it hits, and one such round wrecks a standard error while leaving the
// median and the sign count intact. A round whose own rain-free pair disagrees by more than
// --outlier-x times the median is rejected outright and reported rather than averaged in.
//
// Two masks are measured: the grass canopy core (pixels the grass layer changes by more than
// --mask-threshold when it is toggled off, which excludes the exposure shift that toggle also
// causes) and the whole frame. The canopy core is the claim; the whole frame is context. Rain
// over grass is a low-amplitude change -- most of it lands between 4 and 8 of 255 -- so
// --pixel-threshold is deliberately small and the rain-free pair is what says how small it can be.
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, DEFAULT_VIEWPORT } from './lib/cdp-browser.mjs'
import { vendorLaunchArgs } from './lib/witness-gpu.mjs'
import { witnessGpu } from './lib/gpu-probe.mjs'
import { decodePng } from './tsl-parity/png.mjs'
import { WEATHER_DRAWS_OVER_FOLIAGE_BAND, GRASS_TRANSPARENT_DRAW_BAND } from '../client/core/drawBands.js'

const LABEL = 'rain-over-grass-browser-witness'
const LF = String.fromCharCode(10)

function flag(name, dflt = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
function flagNumber(name, dflt) {
  const raw = flag(name)
  const v = Number(raw)
  return raw !== null && Number.isFinite(v) ? v : dflt
}

const PORT = flag('port', '3271')
const WORLD = flag('world', 'tps-game')
const PARAMS = flag('params', 'singleplayer')
const GPU_MODE = flag('gpu', 'accelerated')
const BEFORE_BAND = flagNumber('before-band', 0)
const ROUNDS = flagNumber('rounds', 20)
const WARM_MS = flagNumber('settle', 4000)
const GAP_MS = flagNumber('gap', 120)
const TIMEOUT_MS = flagNumber('timeout', 240000)
const MASK_T = flagNumber('mask-threshold', 50)
const PIX_T = flagNumber('pixel-threshold', 8)
const MIN_MASK_PX = flagNumber('min-mask-px', 20000)
const MAX_MASK_FRAC = flagNumber('max-mask-frac', 0.35)
const MIN_SIGNAL_PX = flagNumber('min-signal-px', 200)
const MIN_RATIO = flagNumber('min-ratio', 1.05)
const OUTLIER_X = flagNumber('outlier-x', 3)
const MAX_REJECTED_FRAC = flagNumber('max-rejected-frac', 0.25)
const MIN_KEEP_ROUNDS = flagNumber('min-keep-rounds', 8)
const MIN_T = flagNumber('min-t', 2.5)
// The canopy mask is measured from a live grass toggle, so its size tracks the scene and the
// effect's size tracks it; the fraction of rounds that agree in sign therefore moves with machine
// load. It is held to a clear majority -- with the median gain and the t statistic beside it, not
// as the sole evidence -- while the whole frame, which rain only touches in part, is held lower.
const MIN_POS_FRAC = flagNumber('min-positive-frac', 0.6)
const MIN_FRAME_POS_FRAC = flagNumber('min-frame-positive-frac', 0.5)
const MIN_CANOPY_DELTA_PX = flagNumber('min-canopy-delta-px', 400)
const MIN_FRAME_DELTA_PX = flagNumber('min-frame-delta-px', 1000)
// Snow flakes are sparser and slower than rain streaks, so the band change moves fewer canopy
// pixels and it takes as many rounds as rain to separate that from the scene's own wobble.
const SNOW_ROUNDS = flagNumber('snow-rounds', 12)
const MIN_HERO_GAIN_PX = flagNumber('min-hero-gain-px', 300)
const HERO_ATTEMPTS = flagNumber('hero-attempts', 5)
const HERO_NOISE_X = flagNumber('hero-noise-x', 2)
const MAX_NOISE_FRAC = flagNumber('max-noise-frac', 0.25)
const WEATHER_INTENSITY = flagNumber('intensity', 1)
const [VIEW_W, VIEW_H] = String(flag('viewport', DEFAULT_VIEWPORT.width + 'x' + DEFAULT_VIEWPORT.height)).split('x').map(Number)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRATCH = resolve(flag('scratch', join(tmpdir(), 'spoint-rain-over-grass')))
const OUT_DIR = resolve(flag('out', join(tmpdir(), 'spoint-rain-over-grass-shots')))

// Every other browser witness in scripts/ rides behind SPOINT_GPU_WITNESS and reports SKIP without
// it, and this one is no different: a bare `node scripts/<this>.mjs` must not boot a headful
// accelerated Chrome. Ask for it explicitly, under the GPU lock.
if (process.env.SPOINT_GPU_WITNESS !== '1') {
  console.log(`SKIP ${LABEL}: SPOINT_GPU_WITNESS != 1 -- this witness reaches cdp-browser, so it runs only under SPOINT_GPU_WITNESS=1 (scripts/gpulock.mjs run <owner> -- node scripts/${LABEL}.mjs --knob=qualityGovernorOff=true) and never in check.mjs's gpu-free arm`)
  process.exit(0)
}

function finish(verdict, detail) {
  console.log(`RESULT: ${verdict} arm=${GPU_MODE} label=${LABEL} -- ${String(detail).split(LF).join(' ')}`)
  process.exit(verdict === 'PASS' ? 0 : 1)
}
const fail = (detail) => finish('FAIL', detail)

const OPS = {
  '==': (got, want) => Object.is(got, want),
  '>': (got, want) => typeof got === 'number' && Number.isFinite(got) && got > want,
  '>=': (got, want) => typeof got === 'number' && Number.isFinite(got) && got >= want,
  '<=': (got, want) => typeof got === 'number' && Number.isFinite(got) && got <= want,
}
const checks = []
function expect(label, got, op, want) {
  const pass = OPS[op](got, want) === true
  checks.push({ label, got, op, want, pass })
  return pass
}

function parseKnobs(raw) {
  if (!raw) return []
  return raw.split(',').map((pair) => {
    const i = pair.indexOf('=')
    if (i <= 0 || i === pair.length - 1) fail(`--knob=${raw} refused: expected --knob=<key>=<value>`)
    const key = pair.slice(0, i)
    const v = pair.slice(i + 1)
    return { key, value: v === 'true' ? true : v === 'false' ? false : (Number.isFinite(+v) ? +v : v) }
  })
}
const KNOBS = parseKnobs(flag('knob', ''))

const GOVERNOR = `(() => {
  const st = window.__qualityGovernorState
  const api = window.__qualityGovernorApi
  return { tier: api ? api.tier : null, steps: st ? st.steps : null, knobs: st ? st.knobs : null }
})()`

const PROBE = `(() => {
  const w = window.__weather, g = window.__grass
  const ro = (m) => (m == null ? null : m.renderOrder)
  const vis = (m) => (m == null ? null : m.visible)
  return {
    type: w ? w.getType() : null,
    intensity: w ? w.getIntensity() : null,
    rain: { ro: ro(w && w._im), visible: vis(w && w._im) },
    snow: { ro: ro(w && w._imSnow), visible: vis(w && w._imSnow) },
    far: { ro: ro(w && w._imFar), visible: vis(w && w._imFar) },
    splash: { ro: ro(w && w._imSplash), visible: vis(w && w._imSplash) },
    grass: { ro: ro(g && g._im), midRo: ro(g && g._imMid), visible: vis(g && g._im), midVisible: vis(g && g._imMid), instances: g ? g.totalInstances : null },
    governorTier: window.__qualityGovernorApi ? window.__qualityGovernorApi.tier : null,
    governorSteps: window.__qualityGovernorState ? window.__qualityGovernorState.steps : null,
    governorKnobs: window.__qualityGovernorState ? window.__qualityGovernorState.knobs : null,
  }
})()`

const SETUP = `(() => {
  const W = window
  const rc = W.__renderControls
  const out = { knobs: [] }
  for (const k of ${JSON.stringify(KNOBS)}) out.knobs.push({ key: k.key, want: k.value, got: rc.set(k.key, k.value) })
  out.governorOff = rc.get('qualityGovernorOff')
  out.governor = rc.get('qualityGovernor')
  out.dprAuto = rc.get('dprAuto')
  out.dprOff = rc.get('dprOff')
  out.resolutionKeys = ['dpr', 'dprAuto', 'dprOff', 'vdrs', 'vdrsOff', 'threeVdrs', 'fsr1', 'halfResWater', 'bloomResolutionScale']
    .map((k) => ({ key: k, value: rc.get(k) }))
  const el = window.__renderer && window.__renderer.domElement
  out.canvas = el ? { width: el.width, height: el.height, cssWidth: el.clientWidth, cssHeight: el.clientHeight } : null
  out.pixelRatio = window.__renderer && typeof window.__renderer.getPixelRatio === 'function' ? window.__renderer.getPixelRatio() : null
  W.__grassWind = 0
  const wx = W.__weather
  if (wx && typeof wx.setIntensity === 'function') wx.setIntensity(${WEATHER_INTENSITY})
  out.intensity = wx && typeof wx.getIntensity === 'function' ? wx.getIntensity() : null
  const tod = W.__timeOfDayApi
  if (tod && typeof tod.setPaused === 'function') { tod.setPaused(true); if (typeof tod.setFraction === 'function') tod.setFraction(0.35) }
  out.todPaused = tod && typeof tod.isPaused === 'function' ? tod.isPaused() : null
  out.todFraction = tod && typeof tod.getFraction === 'function' ? tod.getFraction() : null
  const st = W.__qualityGovernorState
  out.governorSteps = st ? st.steps : null
  out.governorTier = W.__qualityGovernorApi ? W.__qualityGovernorApi.tier : null
  out.governorKnobs = st ? st.knobs : null
  return out
})()`

const setBandSrc = (band) => `(() => {
  const w = window.__weather
  const targets = [w._im, w._imSplash, w._imSnow, w._imFar]
  for (const m of targets) m.renderOrder = ${band}
  return targets.map((m) => m.renderOrder)
})()`

const setWeatherVisibleSrc = (v, baseVis) => `(() => {
  const w = window.__weather
  const targets = [w._im, w._imSplash, w._imSnow, w._imFar]
  const want = ${JSON.stringify(baseVis ?? [true, true, true, true])}
  for (let i = 0; i < targets.length; i++) targets[i].visible = ${v ? 'true' : 'false'} && want[i]
  return targets.map((m) => m.visible)
})()`

const setTypeSrc = (type) => `(() => {
  window.__weatherType = ${JSON.stringify(type)}
  window.__weather.setType(${JSON.stringify(type)})
  return window.__weather.getType()
})()`

const setGrassVisibleSrc = (v) => `(() => {
  const g = window.__grass
  g._im.visible = ${v ? 'true' : 'false'}
  g._imMid.visible = ${v ? 'true' : 'false'}
  return [g._im.visible, g._imMid.visible]
})()`

const setFarVisibleSrc = (v) => `(() => {
  const w = window.__weather
  w._imFar.visible = ${v ? 'true' : 'false'}
  return w._imFar.visible
})()`

async function shot(page, name) {
  const r = await page._send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT_DIR, `${name}.png`), Buffer.from(r.data, 'base64'))
  return decodePng(r.data)
}

function changedCount(a, b, idx, t) {
  let n = 0
  for (const i of idx) {
    const o = i * 3
    if (Math.abs(a.rgb[o] - b.rgb[o]) > t) { n++; continue }
    if (Math.abs(a.rgb[o + 1] - b.rgb[o + 1]) > t) { n++; continue }
    if (Math.abs(a.rgb[o + 2] - b.rgb[o + 2]) > t) n++
  }
  return n
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
const sem = (xs) => {
  if (xs.length < 2) return Infinity
  const m = mean(xs)
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)) / xs.length)
}

function gainedGrid(before, after, ref, idx, w, h, t) {
  const GX = 8
  const GY = 6
  const grid = new Array(GX * GY).fill(0)
  let total = 0
  let bottom = 0
  const cellPixels = (w / GX) * (h / GY)
  for (const i of idx) {
    const o = i * 3
    const dAfter = Math.max(
      Math.abs(after.rgb[o] - ref.rgb[o]),
      Math.abs(after.rgb[o + 1] - ref.rgb[o + 1]),
      Math.abs(after.rgb[o + 2] - ref.rgb[o + 2]),
    )
    const dBefore = Math.max(
      Math.abs(before.rgb[o] - ref.rgb[o]),
      Math.abs(before.rgb[o + 1] - ref.rgb[o + 1]),
      Math.abs(before.rgb[o + 2] - ref.rgb[o + 2]),
    )
    if (dAfter <= t || dBefore > t) continue
    total++
    const x = i % w
    const y = (i - x) / w
    if (y >= h / 2) bottom++
    grid[Math.min(GY - 1, Math.floor(y / (h / GY))) * GX + Math.min(GX - 1, Math.floor(x / (w / GX)))]++
  }
  const rows = []
  for (let cy = 0; cy < GY; cy++) {
    const cells = []
    for (let cx = 0; cx < GX; cx++) cells.push(String(Math.round(1000 * grid[cy * GX + cx] / cellPixels) / 10).padStart(5))
    rows.push(`y${cy} ${cells.join('')}`)
  }
  rows.push(`(percent of each cell that gained rain; y0 is the top of the frame, total ${total} px, ${bottom} of them in the lower half)`)
  return { rows, total, bottom }
}

// A state change reaches the screen on the next RENDERED frame, and under a loaded host this box
// rendered on the order of seconds per frame -- a fixed wall-clock wait shorter than one frame
// reads the state BEFORE it lands. Wait on the frame itself wherever a probe asserts a state the
// renderer owns (Weather.js hides its four meshes inside update(), so "clear" needs a frame).
// The wait is bounded: an occluded headful window or a renderer that has stopped issuing frames
// must not turn "wait for a frame" into a hang that holds the GPU lock for the whole host.
async function frames(page, n, perFrameMs = 20000) {
  for (let i = 0; i < n; i++) {
    const arrived = await Promise.race([
      page.evaluate(`new Promise((r) => requestAnimationFrame(() => r(true)))`).then((v) => v === true, () => false),
      new Promise((r) => setTimeout(() => r(false), perFrameMs)),
    ])
    if (arrived !== true) {
      console.log(`[${LABEL}] warn: no rendered frame arrived within ${perFrameMs}ms (frame ${i + 1} of ${n}); the renderer is stalled, so this probe may read the state from before the change`)
      return false
    }
  }
  return true
}

async function waitFor(page, expr, ms, label) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = await page.evaluate(expr).catch(() => false)
    if (v === true) return true
    await page.waitForTimeout(200)
  }
  return false
}

async function main() {
  process.env.WORLD = process.env.WORLD || WORLD
  process.env.PORT = PORT
  process.env.SPOINT_NO_WATCH = '1'

  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(SCRATCH, { recursive: true })
  process.env.SPOINT_STATIC_CACHE_DIR = join(SCRATCH, 'static')

  console.log(`[${LABEL}] booting real server on port ${PORT} (world=${process.env.WORLD}) ...`)
  const { boot } = await import('../src/sdk/server.js')
  const server = await boot({ storageDir: join(SCRATCH, 'data') })
  const base = `http://127.0.0.1:${PORT}`

  let browser = null
  try {
    // Headful is required for a real GPU adapter, and a headful window this host is also driving
    // for a dozen other lanes gets backgrounded or occluded -- requestAnimationFrame then stops,
    // every probe reads the state from before the change and the whole arm stalls. Push back on
    // the throttling instead of measuring a browser that is not rendering.
    browser = await chromium.launch({ headless: false, args: [...vendorLaunchArgs(GPU_MODE), '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'] })
    const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT })
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    await page.goto(`${base}/?${PARAMS}`, { waitUntil: 'domcontentloaded' })

    const gpu = await witnessGpu(page, GPU_MODE)
    console.log(`[${LABEL}] gpu ${JSON.stringify(gpu)}`)

    const t0 = Date.now()
    let reached = false
    while (Date.now() - t0 < TIMEOUT_MS) {
      const st = await page.evaluate(`({
        prewarmed: performance.getEntriesByName('boot:foliage-prewarmed').length > 0,
        playable: !!(window.__app && window.__app.revealedAt != null),
        weather: !!window.__weather,
        grass: !!(window.__grass && window.__grass.totalInstances > 0),
      })`).catch(() => ({}))
      reached = st.prewarmed && st.playable && st.weather && st.grass
      if (reached) break
      await page.waitForTimeout(250)
    }
    if (!reached) fail(`page never became playable with weather and grass within ${TIMEOUT_MS}ms (pageErrors=${pageErrors.length}${pageErrors[0] ? ': ' + pageErrors[0].slice(0, 200) : ''})`)

    const setup = await page.evaluate(SETUP)
    console.log(`[${LABEL}] setup ${JSON.stringify(setup)}`)
    for (const k of KNOBS) expect(`knob ${k.key} readback`, setup.knobs.find((x) => x.key === k.key)?.got, '==', k.value)
    expect('qualityGovernorOff reads back true', setup.governorOff, '==', true)
    expect('no pixel doubling: canvas backing store matches the viewport', JSON.stringify([setup.canvas && setup.canvas.width, setup.canvas && setup.canvas.height]), '==', JSON.stringify([VIEW_W, VIEW_H]))
    expect('no pixel doubling: device pixel ratio is 1', Math.round((setup.pixelRatio ?? 0) * 1e6) / 1e6, '==', 1)

    if (!(await waitFor(page, `(window.__weather.getType() === 'rain' && window.__weather.getIntensity() > 0 && window.__weather._im.visible === true)`, 60000, 'rain'))) {
      await page.evaluate(setTypeSrc('rain'))
      if (!(await waitFor(page, `(window.__weather.getType() === 'rain' && window.__weather.getIntensity() > 0 && window.__weather._im.visible === true)`, 30000, 'rain'))) {
        fail('weather never reached a live rain state, so the rain-over-grass comparison cannot be made')
      }
    }

    await page.waitForTimeout(WARM_MS)
    const baseProbe = await page.evaluate(PROBE)
    console.log(`[${LABEL}] probe ${JSON.stringify(baseProbe)}`)
    expect('grass band is the shipped grass band', baseProbe.grass.ro, '==', GRASS_TRANSPARENT_DRAW_BAND)
    expect('grass mid band is the shipped grass band', baseProbe.grass.midRo, '==', GRASS_TRANSPARENT_DRAW_BAND)
    expect('weather band sorts above the grass band', baseProbe.rain.ro, '>', baseProbe.grass.ro)
    expect('weather meshes carry the shipped band', JSON.stringify([baseProbe.rain.ro, baseProbe.splash.ro, baseProbe.snow.ro, baseProbe.far.ro]), '==', JSON.stringify([WEATHER_DRAWS_OVER_FOLIAGE_BAND, WEATHER_DRAWS_OVER_FOLIAGE_BAND, WEATHER_DRAWS_OVER_FOLIAGE_BAND, WEATHER_DRAWS_OVER_FOLIAGE_BAND]))
    expect('snow draws in the same band as rain', baseProbe.snow.ro, '==', baseProbe.rain.ro)
    expect('far billboard tier draws in the same band as the near tier', baseProbe.far.ro, '==', baseProbe.rain.ro)

    await page.evaluate(setGrassVisibleSrc(false))
    await page.waitForTimeout(WARM_MS)
    const shotNoGrass = await shot(page, '01-no-grass')

    await page.evaluate(setGrassVisibleSrc(true))
    await page.waitForTimeout(WARM_MS)
    const shotBase = await shot(page, '02-grass-base')

    const pixels = shotBase.w * shotBase.h
    const allIdx = []
    for (let i = 0; i < pixels; i++) allIdx.push(i)
    const grassIdx = allIdx.filter((i) => {
      const o = i * 3
      return Math.abs(shotBase.rgb[o] - shotNoGrass.rgb[o]) > MASK_T
        || Math.abs(shotBase.rgb[o + 1] - shotNoGrass.rgb[o + 1]) > MASK_T
        || Math.abs(shotBase.rgb[o + 2] - shotNoGrass.rgb[o + 2]) > MASK_T
    })
    expect('grass canopy fills enough of the frame to measure', grassIdx.length, '>=', MIN_MASK_PX)
    expect('grass canopy mask is grass and not the whole-frame exposure shift the toggle also causes', grassIdx.length, '<=', pixels * MAX_MASK_FRAC)

    const baseVis = [baseProbe.rain.visible, baseProbe.splash.visible, baseProbe.snow.visible, baseProbe.far.visible]
    const roundStats = []
    for (let r = 0; r < ROUNDS; r++) {
      const last = r === ROUNDS - 1
      const name = (n) => (last ? n : `${n}-r${r}`)
      const hidden = await page.evaluate(setWeatherVisibleSrc(false, baseVis))
      if (r === 0) expect('weather visibility can be dropped so a rain-free reference frame exists', JSON.stringify(hidden), '==', JSON.stringify([false, false, false, false]))
      await page.waitForTimeout(GAP_MS)
      const refA = await shot(page, name('10-rain-off-a'))
      await page.waitForTimeout(GAP_MS)
      const refB = await shot(page, name('11-rain-off-b'))
      await page.evaluate(setWeatherVisibleSrc(true, baseVis))
      await page.evaluate(setBandSrc(BEFORE_BAND))
      await page.waitForTimeout(GAP_MS)
      const armBefore = await shot(page, name(`12-rain-band-${BEFORE_BAND}`))
      await page.evaluate(setBandSrc(WEATHER_DRAWS_OVER_FOLIAGE_BAND))
      await page.waitForTimeout(GAP_MS)
      const armAfter = await shot(page, name(`13-rain-band-${WEATHER_DRAWS_OVER_FOLIAGE_BAND}`))
      const state = await page.evaluate(`({ type: window.__weather.getType(), intensity: window.__weather.getIntensity() })`)
      roundStats.push({
        round: r,
        type: state.type,
        intensity: state.intensity,
        noise: changedCount(refA, refB, grassIdx, PIX_T),
        before: changedCount(armBefore, refB, grassIdx, PIX_T),
        after: changedCount(armAfter, refB, grassIdx, PIX_T),
        noiseFrame: changedCount(refA, refB, allIdx, PIX_T),
        beforeFrame: changedCount(armBefore, refB, allIdx, PIX_T),
        afterFrame: changedCount(armAfter, refB, allIdx, PIX_T),
      })
    }

    // Hero capture: the before/after pair that is published as evidence. It is captured after the
    // measured rounds, under the identical camera/world/seed/time-of-day and the same band change,
    // three times over, and the attempt whose own rain-free pair is quietest is kept -- a scene
    // wide flash lands in the counted pixels even when the reference frames agree, so the kept
    // pair is also asserted to gain canopy rain itself rather than being a decorative screenshot.
    let hero = null
    for (let a = 0; a < HERO_ATTEMPTS; a++) {
      const name = (n) => `${n}-hero${a}`
      await page.evaluate(setWeatherVisibleSrc(false, baseVis))
      await page.waitForTimeout(GAP_MS)
      const hRefA = await shot(page, name('10-rain-off-a'))
      await page.waitForTimeout(GAP_MS)
      const hRefB = await shot(page, name('11-rain-off-b'))
      await page.evaluate(setWeatherVisibleSrc(true, baseVis))
      await page.evaluate(setBandSrc(BEFORE_BAND))
      await page.waitForTimeout(GAP_MS)
      const hBefore = await shot(page, name(`12-rain-band-${BEFORE_BAND}`))
      await page.evaluate(setBandSrc(WEATHER_DRAWS_OVER_FOLIAGE_BAND))
      await page.waitForTimeout(GAP_MS)
      const hAfter = await shot(page, name(`13-rain-band-${WEATHER_DRAWS_OVER_FOLIAGE_BAND}`))
      const noise = changedCount(hRefA, hRefB, grassIdx, PIX_T)
      const before = changedCount(hBefore, hRefB, grassIdx, PIX_T)
      const after = changedCount(hAfter, hRefB, grassIdx, PIX_T)
      if (hero === null || noise < hero.noise) hero = { attempt: a, noise, before, after, ref: hRefB, armBefore: hBefore, armAfter: hAfter }
    }
    for (const n of [`11-rain-off-b`, `12-rain-band-${BEFORE_BAND}`, `13-rain-band-${WEATHER_DRAWS_OVER_FOLIAGE_BAND}`]) {
      copyFileSync(join(OUT_DIR, `${n}-hero${hero.attempt}.png`), join(OUT_DIR, `hero-${n}.png`))
    }
    console.log(`[${LABEL}] hero ${JSON.stringify({ attempt: hero.attempt, of: HERO_ATTEMPTS, noisePx: hero.noise, beforePx: hero.before, afterPx: hero.after, files: [`hero-11-rain-off-b.png`, `hero-12-rain-band-${BEFORE_BAND}.png`, `hero-13-rain-band-${WEATHER_DRAWS_OVER_FOLIAGE_BAND}.png`] })}`)
    // The kept pair's own NET difference is a single unpaired sample and stays noise dominated;
    // what the published images are held to is that the after frame carries rain over the canopy
    // at all, and -- below, from the gain map -- that it carries canopy pixels the before frame
    // has no rain on. The sign of the effect is the 20 measured rounds' business, not the pair's.
    expect('the published after image contains rain over the grass canopy', hero.after, '>=', MIN_SIGNAL_PX)

    // A round whose own rain-free pair disagrees by many times the typical round is a round the
    // scene itself moved (a lightning flash, a streaming wave, an exposure snap): its reference
    // frame cannot measure a draw-order effect, so the round is rejected and reported rather than
    // averaged in. What survives is judged by MEDIANS and by how many rounds agree in sign, since
    // a scene-wide event still lands inside the counted pixels of the one round it hit.
    console.log(`[${LABEL}] rounds ${JSON.stringify(roundStats)}`)
    const frameNoiseFloor = median(roundStats.map((s) => s.noiseFrame))
    const keep = roundStats.filter((s) => s.noiseFrame <= frameNoiseFloor * OUTLIER_X)
    const rejected = roundStats.filter((s) => s.noiseFrame > frameNoiseFloor * OUTLIER_X)
    console.log(`[${LABEL}] rejected ${JSON.stringify({ noiseFloor: +frameNoiseFloor.toFixed(1), outlierX: OUTLIER_X, rounds: rejected.map((s) => s.round), kept: keep.length, of: ROUNDS })}`)
    expect(`at most ${MAX_REJECTED_FRAC * 100}% of the rounds are too noisy to measure`, rejected.length, '<=', Math.floor(ROUNDS * MAX_REJECTED_FRAC))
    expect('enough quiet rounds survive to measure the band change', keep.length, '>=', MIN_KEEP_ROUNDS)

    const noiseMed = median(keep.map((s) => s.noise))
    const beforeMed = median(keep.map((s) => s.before))
    const afterMed = median(keep.map((s) => s.after))
    const deltas = keep.map((s) => s.after - s.before)
    const delta = median(deltas)
    const deltaMean = mean(deltas)
    const deltaSem = sem(deltas)
    const roundsAbove = deltas.filter((d) => d > 0).length
    const ratio = beforeMed > 0 ? afterMed / beforeMed : Infinity

    const frameDeltas = keep.map((s) => s.afterFrame - s.beforeFrame)
    const frameDelta = median(frameDeltas)
    const frameNoise = median(keep.map((s) => s.noiseFrame))
    const frameBefore = median(keep.map((s) => s.beforeFrame))
    const frameAfter = median(keep.map((s) => s.afterFrame))
    const frameAbove = frameDeltas.filter((d) => d > 0).length
    const frameRatio = frameBefore > 0 ? frameAfter / frameBefore : Infinity

    console.log(`[${LABEL}] canopy ${JSON.stringify({ maskPx: grassIdx.length, grassInstances: baseProbe.grass.instances, noise: +noiseMed.toFixed(1), before: +beforeMed.toFixed(1), after: +afterMed.toFixed(1), delta: +delta.toFixed(1), deltaMean: +deltaMean.toFixed(1), deltaSem: +deltaSem.toFixed(1), ratio: +ratio.toFixed(3), roundsAbove, roundsKept: keep.length, of: ROUNDS })}`)
    console.log(`[${LABEL}] frame ${JSON.stringify({ pixelThreshold: PIX_T, noise: +frameNoise.toFixed(1), before: +frameBefore.toFixed(1), after: +frameAfter.toFixed(1), delta: +frameDelta.toFixed(1), deltaMean: +mean(frameDeltas).toFixed(1), deltaSem: +sem(frameDeltas).toFixed(1), ratio: +frameRatio.toFixed(3), roundsAbove: frameAbove })}`)

    const gained = gainedGrid(hero.armBefore, hero.armAfter, hero.ref, grassIdx, shotBase.w, shotBase.h, PIX_T)
    for (const row of gained.rows) console.log(`[${LABEL}] gained ${row}`)
    console.log(`[${LABEL}] gained map from hero attempt ${hero.attempt} (percent of each cell that gained rain; y0 is the top of the frame, total ${gained.total} px, ${gained.bottom} of them in the lower half)`)
    expect('the canopy pixels that gained rain are inside the grass canopy, not a whole-frame wash', gained.bottom, '>', gained.total * 0.5)
    expect(`the published after image has at least ${MIN_HERO_GAIN_PX} canopy pixel(s) the before image has no rain on`, gained.total, '>=', MIN_HERO_GAIN_PX)
    expect('the published pair is a quiet capture, not a scene-wide flash', hero.noise, '<=', noiseMed * HERO_NOISE_X)

    const noiseCeiling = grassIdx.length * MAX_NOISE_FRAC
    const canopyRainBefore = beforeMed - noiseMed
    const canopyRainAfter = afterMed - noiseMed
    const frameRainBefore = frameBefore - frameNoise
    const frameRainAfter = frameAfter - frameNoise
    console.log(`[${LABEL}] rain above wobble ${JSON.stringify({ canopyBefore: +canopyRainBefore.toFixed(1), canopyAfter: +canopyRainAfter.toFixed(1), frameBefore: +frameRainBefore.toFixed(1), frameAfter: +frameRainAfter.toFixed(1) })}`)
    // Both "rain minus the scene's own wobble" absolutes are printed but NOT asserted: that
    // difference carries the wobble's full variance (the whole frame wobbles by tens of thousands
    // of pixels on its own), so under load it drifts through zero even when the effect is intact.
    // The paired per-round delta is the statistic that separates them, so it is what is asserted.
    expect('the rain-free canopy is quiet enough for the reference frame to mean something', noiseMed, '<=', noiseCeiling)
    // Only the canopy can carry the "band 0 hides rain" claim: over sky and bare terrain rain was
    // never behind anything. Even inside the canopy band 0 still shows rain -- rain between the
    // camera and the blades was never occluded, and the gaps between blades let some through --
    // so the claim is directional: above the scene's own wobble the weather band puts more rain
    // over the canopy than the old band did. It is not, and must not be, "band 0 shows nothing".
    expect(`band ${WEATHER_DRAWS_OVER_FOLIAGE_BAND} puts at least ${MIN_CANOPY_DELTA_PX} more canopy pixel(s) of rain above the wobble than band ${BEFORE_BAND}`, +(canopyRainAfter - canopyRainBefore).toFixed(1), '>=', MIN_CANOPY_DELTA_PX)
    expect('most quiet rounds gain canopy rain from the band change', roundsAbove, '>=', Math.ceil(keep.length * MIN_POS_FRAC))
    expect(`the grass canopy gain is at least ${MIN_T} standard error(s) wide`, +(deltaMean / deltaSem).toFixed(2), '>=', MIN_T)
    // The whole frame is context, not the claim: it carries the sky, the terrain and every wobble
    // rain does not touch, so it is held to a majority of rounds rather than the canopy's share.
    expect('most quiet rounds gain rain over the whole frame from the band change', frameAbove, '>=', Math.ceil(keep.length * MIN_FRAME_POS_FRAC))
    expect(`the median grass canopy gain is at least ${MIN_CANOPY_DELTA_PX} pixel(s)`, +delta.toFixed(1), '>=', MIN_CANOPY_DELTA_PX)
    expect(`the median whole-frame gain is at least ${MIN_FRAME_DELTA_PX} pixel(s)`, +frameDelta.toFixed(1), '>=', MIN_FRAME_DELTA_PX)
    expect(`band ${WEATHER_DRAWS_OVER_FOLIAGE_BAND} puts at least ${MIN_RATIO}x the rain over the grass canopy`, +ratio.toFixed(3), '>=', MIN_RATIO)
    expect('rain over the canopy is a visible change, not a rounding artefact', +afterMed.toFixed(1), '>=', MIN_SIGNAL_PX)
    expect('weather stayed rain across every capture round', JSON.stringify([...new Set(roundStats.map((s) => s.type))]), '==', JSON.stringify(['rain']))

    await page.evaluate(setBandSrc(WEATHER_DRAWS_OVER_FOLIAGE_BAND))
    await page.waitForTimeout(GAP_MS)
    const shotFarOn = await shot(page, '07-far-tier-on')
    await page.evaluate(setFarVisibleSrc(false))
    await page.waitForTimeout(GAP_MS)
    const shotFarOff = await shot(page, '08-far-tier-off')
    await page.evaluate(setFarVisibleSrc(true))
    const farPx = changedCount(shotFarOn, shotFarOff, allIdx, PIX_T)
    console.log(`[${LABEL}] far tier pixels ${farPx}`)
    expect('far billboard tier still contributes pixels beyond the near volume', farPx, '>', 0)

    const clearReached = await waitFor(page, `window.__weather.getType() === 'clear'`, 5000, 'clear')
    if (!clearReached) await page.evaluate(setTypeSrc('clear'))
    await frames(page, 3)
    const clearProbe = await page.evaluate(PROBE)
    console.log(`[${LABEL}] clear probe ${JSON.stringify({ type: clearProbe.type, rain: clearProbe.rain.visible, snow: clearProbe.snow.visible, far: clearProbe.far.visible, splash: clearProbe.splash.visible })}`)
    expect('clear draws no weather at all', JSON.stringify([clearProbe.rain.visible, clearProbe.snow.visible, clearProbe.far.visible, clearProbe.splash.visible]), '==', JSON.stringify([false, false, false, false]))

    const snowReached = await waitFor(page, `window.__weather.getType() === 'snow' && window.__weather._imSnow.visible === true`, 5000, 'snow')
    if (!snowReached) await page.evaluate(setTypeSrc('snow'))
    await frames(page, 3)
    const snowProbe = await page.evaluate(PROBE)
    expect('snow draws in the same band as rain', snowProbe.snow.ro, '==', WEATHER_DRAWS_OVER_FOLIAGE_BAND)
    if (snowProbe.type === 'snow' && snowProbe.snow.visible === true) {
      // Snow gets its own rain-free reference per round, for the same reason rain does: the
      // rain-era reference frame is minutes and a type change away and cannot be compared to it.
      const snowVis = [snowProbe.rain.visible, snowProbe.splash.visible, snowProbe.snow.visible, snowProbe.far.visible]
      const snowDeltas = []
      let snowLastAfterPx = 0
      for (let s = 0; s < SNOW_ROUNDS; s++) {
        const last = s === SNOW_ROUNDS - 1
        const name = (n) => (last ? n : `${n}-s${s}`)
        await page.evaluate(setWeatherVisibleSrc(false, snowVis))
        await page.waitForTimeout(GAP_MS)
        const snowRef = await shot(page, name('09-snow-rain-free'))
        await page.evaluate(setWeatherVisibleSrc(true, snowVis))
        await page.evaluate(setBandSrc(BEFORE_BAND))
        await page.waitForTimeout(GAP_MS)
        const snowBefore = await shot(page, name(`10-snow-band-${BEFORE_BAND}`))
        await page.evaluate(setBandSrc(WEATHER_DRAWS_OVER_FOLIAGE_BAND))
        await page.waitForTimeout(GAP_MS)
        const snowAfter = await shot(page, name(`11-snow-band-${WEATHER_DRAWS_OVER_FOLIAGE_BAND}`))
        const beforePx = changedCount(snowBefore, snowRef, grassIdx, PIX_T)
        const afterPx = changedCount(snowAfter, snowRef, grassIdx, PIX_T)
        snowDeltas.push(afterPx - beforePx)
        snowLastAfterPx = afterPx
      }
      console.log(`[${LABEL}] snow ${JSON.stringify({ deltas: snowDeltas, median: median(snowDeltas), rounds: SNOW_ROUNDS })}`)
      expect('snow over grass changes the same canopy rain does', snowLastAfterPx, '>=', MIN_SIGNAL_PX)
      expect('snow gains canopy pixels from the same band change rain does', median(snowDeltas), '>', 0)
      expect('most snow rounds gain canopy pixels from the band change', snowDeltas.filter((d) => d > 0).length, '>=', Math.ceil(SNOW_ROUNDS * 0.6))
    } else {
      expect('snow was reachable so its band could be compared on screen', snowProbe.type, '==', 'snow')
    }

    const endProbe = await page.evaluate(PROBE)
    const endGovernor = await page.evaluate(GOVERNOR)
    console.log(`[${LABEL}] end governor ${JSON.stringify(endGovernor)}`)
    expect('governor shed nothing more once qualityGovernorOff was set', endProbe.governorSteps, '<=', setup.governorSteps ?? 0)
    expect('governor drove no different knobs between the first and last capture', JSON.stringify(endProbe.governorKnobs), '==', JSON.stringify(baseProbe.governorKnobs))
    expect('no uncaught page errors', pageErrors.length, '==', 0)
    await page.close().catch((e) => console.log(`[${LABEL}] close: ${e && e.message ? e.message : e}`))
    await browser.close().catch((e) => console.log(`[${LABEL}] close: ${e && e.message ? e.message : e}`))
    browser = null
    server.stop()

    for (const c of checks) console.log(`[${LABEL}] ${c.pass ? '[PASS]' : '[FAIL]'} ${c.label}: got ${JSON.stringify(c.got)} expected ${c.op} ${JSON.stringify(c.want)}`)
    const failed = checks.filter((c) => !c.pass)
    console.log(`[${LABEL}] shots in ${OUT_DIR}`)
    if (failed.length) finish('FAIL', `${failed.length} of ${checks.length} check(s) failed: ${failed.map((c) => `${c.label} got ${JSON.stringify(c.got)} expected ${c.op} ${JSON.stringify(c.want)}`).join('; ')}`)
    finish('PASS', `${checks.length}/${checks.length} checks passed -- maskPx=${grassIdx.length} canopyNoise=${noiseMed.toFixed(1)} overGrassBefore=${beforeMed.toFixed(1)} overGrassAfter=${afterMed.toFixed(1)} canopyGain=${delta.toFixed(1)} roundsAbove=${roundsAbove}/${keep.length} kept of ${ROUNDS} frameGain=${frameDelta.toFixed(1)} farTierPx=${farPx} shots=${OUT_DIR}`)
  } catch (e) {
    if (browser) await browser.close().catch((e) => console.log(`[${LABEL}] close: ${e && e.message ? e.message : e}`))
    server.stop()
    throw e
  }
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e)
  finish('FAIL', `run threw: ${e && e.message ? e.message : e}`)
})
