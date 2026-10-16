#!/usr/bin/env node
// Measures the terrain maxLevel ladder with rAF UNLOCKED, so a median is work-determined and not a
// multiple of the 60 Hz refresh divisor. scripts/perf-run.mjs carries no --disable-frame-rate-limit
// or --disable-gpu-vsync, so every median it reports sits on the vsync grid and a 60 -> 30 fps step
// is the only thing it can resolve. This harness is that instrument.
//
// Arms are swept LIVE inside one browser session: packages/mapspinner/src/lod-config.js
// resolveLodConfig reads window.__maxLevel on every frame, so a rung is a write, not a reboot, and
// the before/after pair shares one page, one bundle and one vegetation population.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chromium } from './lib/cdp-browser.mjs'
import { assertGpu, gpuArgs, gpuModeOf } from './lib/gpu-probe.mjs'
import { vendorPinArgs } from './lib/witness-gpu.mjs'
import { assertServedClientRoot, clientRootTag, rebuildIfRequested, CLIENT_ROOT_BUNDLE } from './lib/served-client-root.mjs'
import { contentionWatch, contentionMark, contentionVerdict, formatContention } from './lib/host-contention.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const RUNGS = arg('rungs', '2,6,11,16,22').split(',').map((s) => Number(s.trim())).filter(Number.isFinite)
// The tap arms are INTERLEAVED (5,3,5,3) rather than blocked, because the terrain vertex stencil's
// tap count is a live uniform (window.__fdTaps): 5 is the central difference this terrain shipped
// with and 3 the forward difference it ships with now, so the pair is measured inside ONE page, one
// bundle and one vegetation population, adjacent in time. Two separate runs on a box shared with
// nine other lanes cannot be told apart from the drift between them; an adjacent pair can.
const TAPS = arg('taps', '5,3,5,3').split(',').map((s) => Number(s.trim())).filter(Number.isFinite)
const VEG_WAIT_MS = Number(arg('veg-wait-ms', '120000'))
const CAPTURE_MS = Number(arg('capture-ms', '6000'))
const SETTLE_MS = Number(arg('settle-ms', '3000'))
const WIDTH = Number(arg('width', '1920'))
const HEIGHT = Number(arg('height', '1080'))
const GPU_FLAG = arg('gpu', 'amd')
const OUT = arg('out', '')
const PORT = process.env.PORT || '3097'
const GPU_MODE = gpuModeOf(GPU_FLAG)
const VENDOR = GPU_MODE.vendor || GPU_FLAG
const UNLOCKED_RAF_ARGS = ['--disable-frame-rate-limit', '--disable-gpu-vsync']
const LOAD_TIMEOUT_MS = 480_000

const percentile = (sorted, p) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))])

function metricsMap(page) {
  return page._send('Performance.getMetrics').then((r) => {
    const out = {}
    for (const m of (r && r.metrics) || []) out[m.name] = m.value
    return out
  })
}

async function evaluateOrThrow(page, fn, ms) {
  return Promise.race([
    Promise.resolve(page.evaluate(fn)),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`page.evaluate did not answer within ${ms}ms`)), ms)),
  ])
}

async function captureArm(page, captureMs) {
  await page._send('Performance.enable').catch(() => {})
  const m0 = await metricsMap(page)
  const res = await page.evaluate((ms) => new Promise((resolve) => {
    const frameDeltas = []
    let last = performance.now()
    let first = true
    const t0 = performance.now()
    function tick(now) {
      const dt = now - last
      last = now
      if (!first) frameDeltas.push(dt)
      first = false
      if (now - t0 < ms) requestAnimationFrame(tick)
      else resolve({ frameDeltas })
    }
    requestAnimationFrame(tick)
  }), captureMs)
  const m1 = await metricsMap(page)
  const sorted = res.frameDeltas.slice().sort((a, b) => a - b)
  const frames = sorted.length
  const threadTimeMs = ((m1.ThreadTime || 0) - (m0.ThreadTime || 0)) * 1000
  const scriptMs = ((m1.ScriptDuration || 0) - (m0.ScriptDuration || 0)) * 1000
  return {
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    minMs: sorted[0] || 0,
    fps: frames ? 1000 / percentile(sorted, 0.5) : 0,
    frames,
    threadTimePerFrameMs: frames ? threadTimeMs / frames : 0,
    scriptPerFrameMs: frames ? scriptMs / frames : 0,
  }
}

async function main() {
  process.env.WORLD = process.env.WORLD || 'tps-game'
  process.env.PORT = PORT
  process.env.SPOINT_SKIP_PREWARM = process.env.SPOINT_SKIP_PREWARM || '1'
  process.env.SPOINT_NO_WATCH = '1'

  console.log(`[vs-ladder] booting real server on port ${PORT} (world=${process.env.WORLD}) ...`)
  rebuildIfRequested('vs-ladder')
  const { boot } = await import('../src/sdk/server.js')
  let server = null
  let browser = null
  const rows = []
  try {
    server = await boot()
    console.log('[vs-ladder] server up.')

    browser = await chromium.launch({
      args: [...gpuArgs({ accelerated: GPU_MODE.accelerated }), ...vendorPinArgs(VENDOR), ...UNLOCKED_RAF_ARGS],
    })
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } })
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))

    const url = `http://localhost:${PORT}/?singleplayer&world=${process.env.WORLD}&at=${encodeURIComponent(arg('at', '-15,-12.5'))}`
    console.log(`[vs-ladder] rAF UNLOCKED (--disable-frame-rate-limit --disable-gpu-vsync); navigating to ${url}`)
    await page.goto(url, { waitUntil: 'domcontentloaded' })

    const servedRoot = await assertServedClientRoot(page, { want: CLIENT_ROOT_BUNDLE, label: 'vs-ladder' })
    console.log(`[vs-ladder] served ${clientRootTag(servedRoot)} required=${CLIENT_ROOT_BUNDLE}`)

    const start = Date.now()
    let ready = false
    while (Date.now() - start < LOAD_TIMEOUT_MS) {
      const probe = await evaluateOrThrow(page, () => {
        const app = window.__app
        return { ready: !!(app && app.loadingMachine && app.loadingMachine.isReady), state: app && app.loadingMachine ? String(app.loadingMachine.state) : null }
      }, 20000).catch(() => ({ ready: false, state: 'stalled' }))
      if (probe.ready) { ready = true; break }
      await new Promise((r) => setTimeout(r, 200))
    }
    if (!ready) throw new Error(`loadingMachine never reached isReady within ${LOAD_TIMEOUT_MS}ms`)

    const gpu = await assertGpu(page, { requireAccelerated: true, expectVendor: VENDOR })
    console.log(`[vs-ladder] rasterizer=${gpu.rasterizer} renderer=${gpu.renderer || 'none'} adapter=${gpu.adapter ? (gpu.adapter.description || gpu.adapter.vendor || 'yes') : 'none'}`)
    const info = await evaluateOrThrow(page, () => ({
      rendererInfo: window.__rendererInfo || null,
      dpr: window.devicePixelRatio || null,
      canvas: (() => { const c = window.__app && window.__app.renderer && window.__app.renderer.domElement; return c ? [c.width, c.height] : null })(),
      headSha: null,
    }), 20000)
    if (!info.rendererInfo) throw new Error('window.__rendererInfo is absent: the adapter was never asserted, so an unresolvable --use-adapter-luid would read as accelerated while running elsewhere')
    console.log(`[vs-ladder] rendererInfo=${JSON.stringify(info.rendererInfo)} dpr=${info.dpr} canvas=${JSON.stringify(info.canvas)}`)
    if (info.canvas && (info.canvas[0] !== WIDTH || info.canvas[1] !== HEIGHT)) {
      console.log(`[vs-ladder] WARNING drawing buffer ${info.canvas[0]}x${info.canvas[1]} != requested ${WIDTH}x${HEIGHT}`)
    }

    // The quality governor drives maxLevel (it clamps it per tier and it defaults ON), so a rung
    // this harness writes would be re-clamped between the write and the capture. Pinned off here
    // and read back per arm, because a shed rung reads as a fast frame the change did not buy.
    await page.evaluate(() => { window.__qualityGovernor = false })
    await evaluateOrThrow(page, () => { window.__warmupInFlight ? null : null }, 5000).catch(() => {})
    const watch = contentionWatch()
    const vegStart = Date.now()
    let veg = await evaluateOrThrow(page, () => (window.__vegProfile && window.__vegProfile.totalInstances) || 0, 15000).catch(() => 0)
    while (veg < 1000 && Date.now() - vegStart < VEG_WAIT_MS) {
      await new Promise((r) => setTimeout(r, 3000))
      veg = await evaluateOrThrow(page, () => (window.__vegProfile && window.__vegProfile.totalInstances) || 0, 15000).catch(() => 0)
    }
    console.log(`[vs-ladder] vegetation resident at first arm: ${veg} instance(s) after ${((Date.now() - vegStart) / 1000).toFixed(0)}s of a ${(VEG_WAIT_MS / 1000).toFixed(0)}s budget`)

    for (const level of RUNGS) {
      for (const taps of TAPS) {
        await page.evaluate((lv, tp) => { window.__maxLevel = lv; window.__fdTaps = tp }, level, taps)
        await new Promise((r) => setTimeout(r, SETTLE_MS))
        const state = await evaluateOrThrow(page, () => {
          const r = window.__app && window.__app.renderer
          return {
            maxLevel: window.__maxLevel,
            fdTaps: window.__fdTaps,
            governor: window.__qualityGovernor,
            calls: r ? r.info.render.calls : 0,
            triangles: r ? r.info.render.triangles : 0,
            veg: (window.__vegProfile && window.__vegProfile.totalInstances) || 0,
            warmup: !!window.__warmupInFlight,
          }
        }, 20000)
        const arm = await captureArm(page, CAPTURE_MS)
        contentionMark(watch)
        const row = {
          maxLevel: level,
          taps,
          readbackMaxLevel: state.maxLevel,
          readbackFdTaps: state.fdTaps,
          governor: state.governor,
          rep: 0,
          ...arm,
          drawCalls: state.calls,
          triangles: state.triangles,
          veg: state.veg,
          warmup: state.warmup,
        }
        rows.push(row)
        console.log(`[vs-ladder] maxLevel=${String(level).padStart(2)} taps=${taps} readback=${state.maxLevel}/${state.fdTaps} governor=${state.governor} p50=${arm.p50Ms.toFixed(2)}ms fps=${arm.fps.toFixed(1)} thread=${arm.threadTimePerFrameMs.toFixed(2)}ms frames=${arm.frames} tris=${state.triangles} veg=${state.veg}`)
      }
    }
    if (pageErrors.length > 0) throw new Error(`page threw ${pageErrors.length} uncaught error(s): ${pageErrors[0]}`)
    await browser.close()
    browser = null
    const contention = contentionVerdict(watch)
    console.log(`[vs-ladder] ${formatContention(contention)}`)
    const out = {
      instrument: 'terrain-vs-ladder.mjs (rAF unlocked)',
      width: WIDTH,
      height: HEIGHT,
      vendor: VENDOR,
      rasterizer: gpu.rasterizer,
      rendererInfo: info.rendererInfo,
      captureMs: CAPTURE_MS,
      settledMs: SETTLE_MS,
      headSha: process.env.SPOINT_HEAD_SHA || null,
      contention: { contested: contention.contested },
      rows,
    }
    const text = JSON.stringify(out, null, 2)
    if (OUT) { writeFileSync(OUT, text + '\n'); console.log(`[vs-ladder] wrote ${OUT}`) }
    console.log(text)
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (server) server.stop()
  }
}

main().catch((e) => { console.error('[vs-ladder] FAILED:\n', e.stack || e.message); process.exit(1) })
