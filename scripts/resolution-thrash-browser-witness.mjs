#!/usr/bin/env node
// Counts every render-resolution transition a real browser run performs and attributes each one
// to the call site that issued it. A "resolution transition" is a write to the renderer canvas'
// width/height that CHANGES the value, or a renderer.setSize/setPixelRatio call: each one
// reallocates the drawing buffer and every render target sized from it.
//
// The deliverable is a COUNT and a COST, attributed. It never reports a per-pass GPU timing.
import { chromium, DEFAULT_VIEWPORT } from './lib/cdp-browser.mjs'
import { gpuModeFlag, vendorGpuArgs } from './lib/gpu-probe.mjs'
import { vendorLaunchArgs } from './lib/witness-gpu.mjs'
import { flagNumber } from './lib/witness-args.mjs'

function flag(name, dflt = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const has = (n) => process.argv.includes(`--${n}`)

const PORT = flag('port', '3721')
const PARAMS = flag('params', 'singleplayer')
const WORLD = flag('world', 'empty')
const OBSERVE_MS = flagNumber(flag, 'observe', 10000, process.argv.slice(2))
const TIMEOUT_MS = flagNumber(flag, 'timeout', 240000, process.argv.slice(2))
const SHOTS = flagNumber(flag, 'shots', 0, process.argv.slice(2))
const HEADLESS = !has('headed')
const GPU_VENDOR = flag('gpu', null)
const VIEW = String(flag('viewport', DEFAULT_VIEWPORT.width + 'x' + DEFAULT_VIEWPORT.height)).split('x').map(Number)
const OUT = flag('out', null)

const LABEL = 'resolution-thrash'
const fail = (m) => { console.error(`[${LABEL}] RESULT: FAIL -- ${m}`); process.exit(1) }

// Installed at document start so it sees the boot-time writes, not only the settled ones.
// Ends in `())` because an init script that is a bare expression is discarded.
const INIT = `(() => {
  const P = HTMLCanvasElement.prototype
  const wd = Object.getOwnPropertyDescriptor(P, 'width')
  const hd = Object.getOwnPropertyDescriptor(P, 'height')
  if (!wd || !hd || !wd.set || !hd.set) { window.__resLogError = 'canvas width/height is not an accessor pair'; return }
  const log = []
  const seen = []
  window.__resLog = log
  window.__resSeen = seen
  window.__resLogInstalled = true
  const frameOf = (s) => String(s || '').split('\\n').slice(1, 10)
    .map((l) => l.trim())
    .filter((l) => l && l.indexOf('resTrap') < 0 && l.indexOf('frameOf') < 0)
    .slice(0, 5)
    .join(' <- ')
  function idOf(el) {
    let i = seen.indexOf(el)
    if (i < 0) { seen.push(el); i = seen.length - 1 }
    return i
  }
  function trap(which, d) {
    Object.defineProperty(P, which, {
      configurable: true,
      enumerable: d.enumerable,
      get() { return d.get.call(this) },
      set: function resTrap(v) {
        const before = d.get.call(this)
        const t0 = performance.now()
        d.set.call(this, v)
        const dt = performance.now() - t0
        log.push({ k: which, before: before, after: v, t: Math.round(t0), dt: +dt.toFixed(3), c: idOf(this), dom: !!(document.body && document.body.contains(this)), stack: frameOf(new Error().stack) })
      },
    })
  }
  trap('width', wd)
  trap('height', hd)
  window.addEventListener('resize', () => {
    log.push({ k: 'resize-event', before: null, after: window.innerWidth + 'x' + window.innerHeight, t: Math.round(performance.now()), dt: 0, c: -1, dom: false, stack: 'window resize event' })
  })
  function wrapRenderer(r) {
    if (!r || r.__resTrapped) return
    r.__resTrapped = true
    for (const m of ['setSize', 'setPixelRatio']) {
      const proto = Object.getPrototypeOf(r)
      const src = proto && Object.getOwnPropertyDescriptor(proto, m)
      const orig = (src && src.value) || r[m]
      if (typeof orig !== 'function') continue
      const fn = function (...a) {
        const t0 = performance.now()
        const out = orig.apply(this, a)
        log.push({ k: m, before: null, after: JSON.stringify(a), t: Math.round(t0), dt: +(performance.now() - t0).toFixed(3), c: idOf(this.domElement), dom: true, stack: frameOf(new Error().stack) })
        return out
      }
      Object.defineProperty(r, m, { configurable: true, writable: true, value: fn })
    }
  }
  // A VDRS / threeVdrs flip is a render-target reallocation even when the canvas never moves.
  for (const g of ['__vdrs', '__vdrsScale', '__threeVdrs', '__threeVdrsScale', '__dpr', '__halfResWater', '__bloomResolutionScale']) {
    let v = window[g]
    Object.defineProperty(window, g, {
      configurable: true,
      get: () => v,
      set: (nv) => {
        if (nv !== v) log.push({ k: 'global', before: v, after: nv, t: Math.round(performance.now()), dt: 0, c: -1, dom: false, stack: 'global ' + g })
        v = nv
      },
    })
  }
  // Render targets (ssao/bloom/ssr/threeVdrs/terrain) are resolution too; three's own bundle is a
  // single module instance under this origin, so patching its prototype catches every one of them.
  import('/node_modules/three/build/three.webgpu.js').then((m) => {
    const RT = m.RenderTarget && m.RenderTarget.prototype
    if (!RT || !RT.setSize) { window.__resRtError = 'RenderTarget.setSize not reachable'; return }
    window.__resRtInstalled = true
    const orig = RT.setSize
    RT.setSize = function (...a) {
      const t0 = performance.now()
      const out = orig.apply(this, a)
      log.push({ k: 'rt', before: this.width + 'x' + this.height, after: a[0] + 'x' + a[1], t: Math.round(t0), dt: +(performance.now() - t0).toFixed(3), c: -1, dom: false, stack: frameOf(new Error().stack) })
      return out
    }
  }).catch((e) => { window.__resRtError = String((e && e.message) || e) })
  let _app = null
  Object.defineProperty(window, '__app', {
    configurable: true,
    get: () => _app,
    set: (v) => { _app = v; try { wrapRenderer(v && v.renderer) } catch (e) { window.__resTrapError = String((e && e.message) || e) } },
  })
})()`

// Runs in the page: replay the raw write log into a resolution timeline and attribute by stack.
const REPORT = `(() => {
  const raw = window.__resLog || []
  const r = window.__app && window.__app.renderer
  const canvasEl = r && r.domElement
  const rcIndex = canvasEl ? window.__resSeen.indexOf(canvasEl) : -1
  const canvasWrites = raw.filter((e) => e.c === rcIndex && (e.k === 'width' || e.k === 'height'))
  const changed = canvasWrites.filter((e) => e.before !== e.after)
  const redundant = canvasWrites.filter((e) => e.before === e.after)
  const calls = raw.filter((e) => e.k === 'setSize' || e.k === 'setPixelRatio')
  let w = null, h = null
  const timeline = []
  for (const e of canvasWrites) {
    if (e.k === 'width') w = e.after
    else h = e.after
    if (w === null || h === null) continue
    const key = w + 'x' + h
    if (timeline.length && timeline[timeline.length - 1].size === key) continue
    timeline.push({ size: key, t: e.t, dt: e.dt, stack: e.stack })
  }
  const transitions = timeline.length ? timeline.slice(1) : []
  const rt = raw.filter((e) => e.k === 'rt')
  const rtChanged = rt.filter((e) => e.before !== e.after)
  const globals = raw.filter((e) => e.k === 'global')
  const bucket = {}
  const add = (b, e) => {
    const x = bucket[b] || (bucket[b] = { n: 0, sumDt: 0, maxDt: 0, what: {} })
    x.n++
    x.sumDt += e.dt
    if (e.dt > x.maxDt) x.maxDt = e.dt
    const tag = e.k + ' ' + (e.before === null ? '' : e.before + '->') + e.after
    x.what[tag] = (x.what[tag] || 0) + 1
  }
  for (const e of changed) add('canvas:' + e.stack, e)
  for (const e of calls) add('call:' + e.stack, e)
  for (const e of rtChanged) add('rt:' + e.stack, e)
  for (const e of globals) add('global:' + e.stack, e)
  const stacks = Object.keys(bucket).map((s) => ({ kind: s.slice(0, s.indexOf(':')), stack: s.slice(s.indexOf(':') + 1), n: bucket[s].n, sumDt: +bucket[s].sumDt.toFixed(3), maxDt: bucket[s].maxDt, what: bucket[s].what }))
  stacks.sort((a, c) => c.sumDt - a.sumDt || c.n - a.n)
  return {
    installed: window.__resLogInstalled === true,
    installError: window.__resLogError || window.__resTrapError || null,
    rendererCanvasIndex: rcIndex,
    rawWrites: raw.length,
    canvasWrites: canvasWrites.length,
    canvasChanged: changed.length,
    canvasRedundant: redundant.length,
    setSizeCalls: calls.filter((c) => c.k === 'setSize').length,
    setPixelRatioCalls: calls.filter((c) => c.k === 'setPixelRatio').length,
    rtInstalled: window.__resRtInstalled === true,
    rtError: window.__resRtError || null,
    rtCalls: rt.length,
    rtChanged: rtChanged.length,
    rtSumDtMs: +rtChanged.reduce((a, e) => a + e.dt, 0).toFixed(3),
    rtMaxDtMs: rtChanged.reduce((a, e) => Math.max(a, e.dt), 0),
    globalFlips: globals.length,
    callSumDtMs: +calls.reduce((a, e) => a + e.dt, 0).toFixed(3),
    callMaxDtMs: calls.reduce((a, e) => Math.max(a, e.dt), 0),
    sumDtMs: +changed.reduce((a, e) => a + e.dt, 0).toFixed(3),
    maxDtMs: changed.reduce((a, e) => Math.max(a, e.dt), 0),
    meanDtMs: changed.length ? +(changed.reduce((a, e) => a + e.dt, 0) / changed.length).toFixed(3) : 0,
    redundantSumDtMs: +redundant.reduce((a, e) => a + e.dt, 0).toFixed(3),
    distinctSizes: timeline.map((x) => x.size),
    transitions: transitions,
    stacks: stacks.slice(0, 14),
    resizeEvents: raw.filter((e) => e.k === 'resize-event').map((e) => ({ at: e.t, size: e.after })),
    otherCanvasChanged: raw.filter((e) => e.c !== rcIndex && (e.k === 'width' || e.k === 'height') && e.before !== e.after).length,
    final: {
      canvas: canvasEl ? canvasEl.width + 'x' + canvasEl.height : null,
      pixelRatio: r && typeof r.getPixelRatio === 'function' ? r.getPixelRatio() : null,
      inner: window.innerWidth + 'x' + window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      isWebGPU: !!(r && r.isWebGPURenderer),
      renderer: window.__rendererInfo ? (window.__rendererInfo.renderer || window.__rendererInfo.glRenderer) : null,
      governorSteps: window.__qualityGovernorState ? window.__qualityGovernorState.steps : null,
      governorTier: window.__qualityGovernorState ? window.__qualityGovernorState.tier : null,
      dprStats: window.__dprStats || null,
      terrainVdrs: window.__terrainVdrs || null,
      preset: window.__qualityPreset || null,
    },
  }
})()`

async function main() {
  process.env.SPOINT_SKIP_PREWARM = process.env.SPOINT_SKIP_PREWARM || '1'
  process.env.WORLD = process.env.WORLD || WORLD
  process.env.PORT = PORT
  process.env.SPOINT_NO_WATCH = '1'
  console.log(`[${LABEL}] booting real server on port ${PORT} (world=${process.env.WORLD}) ...`)
  const { boot } = await import('../src/sdk/server.js')
  const server = await boot()
  const base = `http://localhost:${PORT}`

  let browser
  try {
    const args = GPU_VENDOR ? vendorGpuArgs(GPU_VENDOR) : vendorLaunchArgs(gpuModeFlag())
    browser = await chromium.launch({ headless: HEADLESS, args })
    const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT })
    await page._send('Page.addScriptToEvaluateOnNewDocument', { source: INIT })
    const url = `${base}/?${PARAMS}`
    console.log(`[${LABEL}] navigating to ${url} ...`)
    await page.goto(url, { waitUntil: 'domcontentloaded' })

    const t0 = Date.now()
    let ready = false
    while (Date.now() - t0 < TIMEOUT_MS) {
      ready = await page.evaluate(`!!(window.__app && window.__app.loadingMachine && window.__app.loadingMachine.isReady)`).catch(() => false)
      if (ready) break
      await new Promise((r) => setTimeout(r, 250))
    }
    const bootMs = Date.now() - t0
    const installed = await page.evaluate(`!!(window.__resLogInstalled === true)`).catch(() => false)
    if (!installed) fail('instrument not installed in the page -- an absent log would read as a measured zero')
    console.log(`[${LABEL}] ready=${ready} bootMs=${bootMs} instrument=installed`)
    if (!ready) fail('world never reached isReady, so the observation window measures an unfinished boot')

    console.log(`[${LABEL}] observing ${OBSERVE_MS} ms ...`)
    await page.waitForTimeout(OBSERVE_MS)

    if (SHOTS > 0) {
      console.log(`[${LABEL}] taking ${SHOTS} CDP screenshot(s) ...`)
      await page._send('Page.enable').catch(() => {})
      const shots = []
      for (let i = 0; i < SHOTS; i++) {
        const t = Date.now()
        const { data } = await page._send('Page.captureScreenshot', { format: 'png' })
        const ms = Date.now() - t
        const buf = Buffer.from(data, 'base64')
        const px = buf.length > 24 && buf.readUInt32BE(16)
        const py = buf.length > 24 && buf.readUInt32BE(20)
        shots.push({ i: i + 1, ms, bytes: buf.length, png: `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}` })
        console.log(`[${LABEL}]   shot ${i + 1}: png=${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)} bytes=${buf.length} wallMs=${ms}`)
      }
      const sizes = [...new Set(shots.map((s) => s.png))]
      console.log(`[${LABEL}] SHOT RESOLUTIONS=${JSON.stringify(sizes)} totalMs=${shots.reduce((a, s) => a + s.ms, 0)}`)
    }

    const rep = await page.evaluate(REPORT).catch((e) => ({ evaluateFailed: String(e && e.message || e) }))
    if (rep.evaluateFailed) fail('report evaluate failed: ' + rep.evaluateFailed)
    if (rep.installError) fail('instrument error: ' + rep.installError)

    console.log(`[${LABEL}] renderer=${JSON.stringify(rep.final)}`)
    console.log(`[${LABEL}] renderer-canvas writes=${rep.canvasWrites} changed=${rep.canvasChanged} redundant=${rep.canvasRedundant} otherCanvasChanged=${rep.otherCanvasChanged}`)
    console.log(`[${LABEL}] setSize calls=${rep.setSizeCalls} setPixelRatio calls=${rep.setPixelRatioCalls} callSumDtMs=${rep.callSumDtMs} callMaxDtMs=${rep.callMaxDtMs}`)
    console.log(`[${LABEL}] distinct canvas sizes in order: ${JSON.stringify(rep.distinctSizes)}`)
    console.log(`[${LABEL}] RESOLUTION TRANSITIONS=${rep.transitions.length} sumDtMs=${rep.sumDtMs} meanDtMs=${rep.meanDtMs} maxDtMs=${rep.maxDtMs} redundantReallocMs=${rep.redundantSumDtMs}`)
    for (const t of rep.transitions) console.log(`[${LABEL}]   -> ${t.size} @${t.t}ms dt=${t.dt}ms :: ${t.stack}`)
    console.log(`[${LABEL}] window resize events: ${JSON.stringify(rep.resizeEvents)}`)
    console.log(`[${LABEL}] render targets: installed=${rep.rtInstalled} err=${rep.rtError} setSize calls=${rep.rtCalls} changed=${rep.rtChanged} sumDtMs=${rep.rtSumDtMs} maxDtMs=${rep.rtMaxDtMs}`)
    console.log(`[${LABEL}] resolution-global flips (vdrs/threeVdrs/dpr/halfResWater/bloomResolutionScale)=${rep.globalFlips}`)
    console.log(`[${LABEL}] attribution by issuing call site:`)
    for (const s of rep.stacks) console.log(`[${LABEL}]   [${s.kind}] ${s.n}x sumDt=${s.sumDt}ms maxDt=${s.maxDt}ms ${JSON.stringify(s.what)} :: ${s.stack}`)

    if (OUT) {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(OUT, JSON.stringify(rep, null, 2))
      console.log(`[${LABEL}] wrote ${OUT}`)
    }

    const checks = []
    const expect = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); if (!ok) console.error(`[${LABEL}] FAIL ${name} -- ${detail}`) }
    expect('instrument installed in the page', rep.installed === true, `installed=${rep.installed}`)
    expect('renderer canvas identified', rep.final.canvas !== null && rep.rendererCanvasIndex >= 0, `canvas=${rep.final.canvas} idx=${rep.rendererCanvasIndex}`)
    expect('boot sized the renderer canvas at least once', rep.canvasWrites > 0, `writes=${rep.canvasWrites}`)
    const failing = checks.filter((c) => !c.ok)
    console.log(`[${LABEL}] ${checks.length} check(s), ${failing.length} failing.`)
    if (failing.length) { console.error(`[${LABEL}] RESULT: FAIL -- ${failing.map((f) => f.name).join('; ')}`); process.exit(1) }
    console.log(`[${LABEL}] RESULT: PASS transitions=${rep.transitions.length} sumDtMs=${rep.sumDtMs} setPixelRatioCalls=${rep.setPixelRatioCalls}`)
  } finally {
    if (browser) await browser.close().catch(() => {})
    try { for (const h of [server, server && server.server]) if (h && typeof h.stop === 'function') await h.stop() } catch (_) {}
  }
}

main().catch((e) => { console.error(`[${LABEL}] RESULT: FAIL -- ${e && e.stack || e}`); process.exit(1) })
