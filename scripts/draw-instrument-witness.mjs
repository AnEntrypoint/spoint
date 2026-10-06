#!/usr/bin/env node
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from './lib/cdp-browser.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

function flag(name, dflt = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const has = (name) => process.argv.includes(`--${name}`)

const PORT = flag('port', '3137')
const GL = flag('gl', 'swiftshader')
const BACKEND = flag('backend', 'webgl')
const FRAMES = Number(flag('frames', '10'))
const PARAMS = flag('params', 'singleplayer')
const TIMEOUT_MS = Number(flag('timeout', '240000'))
const SETTLE_MS = Number(flag('settle', '6000'))
const WORLD = flag('world', 'tps-game')

const GPU_ARGS = {
  swiftshader: ['--use-gl=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
  nvidia: ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
}

const PROBE = `(() => {
  const W = window
  if (W.__drawProbe) return
  const probe = { samples: [], hooked: false, rendererKind: null }
  W.__drawProbe = probe
  W.__dpGlCalls = 0
  W.__dpGlDraws = 0
  W.__dpWgpuCalls = 0
  W.__dpWgpuDraws = 0
  W.__dpThreeDraws = 0
  W.__dpThreeTris = 0
  W.__dpResets = 0
  W.__dpOn = false
  const GL_DRAW = new Set(['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements', 'multiDrawElementsWEBGL', 'multiDrawArraysWEBGL'])
  const WGPU_DRAW = new Set(['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect'])
  const origGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const ctx = origGetContext.call(this, type, attrs)
    if (ctx && (type === 'webgl2' || type === 'webgl') && !ctx.__dpWrapped) {
      ctx.__dpWrapped = true
      const proto = Object.getPrototypeOf(ctx)
      for (const k of Object.getOwnPropertyNames(proto)) {
        if (k === 'constructor') continue
        const d = Object.getOwnPropertyDescriptor(proto, k)
        if (!d || typeof d.value !== 'function') continue
        const orig = d.value
        Object.defineProperty(ctx, k, {
          value: function () {
            if (W.__dpOn) { W.__dpGlCalls++; if (GL_DRAW.has(k)) W.__dpGlDraws++ }
            return orig.apply(this, arguments)
          },
          writable: true, configurable: true,
        })
      }
    }
    return ctx
  }
  const patchProto = (proto) => {
    if (!proto) return
    for (const k of Object.getOwnPropertyNames(proto)) {
      if (k === 'constructor') continue
      const d = Object.getOwnPropertyDescriptor(proto, k)
      if (!d || typeof d.value !== 'function') continue
      const orig = d.value
      Object.defineProperty(proto, k, {
        value: function () {
          if (W.__dpOn) { W.__dpWgpuCalls++; if (WGPU_DRAW.has(k)) W.__dpWgpuDraws++ }
          return orig.apply(this, arguments)
        },
        writable: true, configurable: true,
      })
    }
  }
  for (const n of ['GPUDevice', 'GPUQueue', 'GPUCommandEncoder', 'GPURenderPassEncoder', 'GPUComputePassEncoder', 'GPURenderBundleEncoder', 'GPUCanvasContext']) {
    if (W[n] && W[n].prototype) patchProto(W[n].prototype)
  }
  const hookInfo = (renderer) => {
    const info = renderer.info
    if (!info || info.__dpHooked) return
    info.__dpHooked = true
    const origReset = info.reset
    info.reset = function () {
      W.__dpThreeDraws += info.render.drawCalls !== undefined ? info.render.drawCalls : info.render.calls
      W.__dpThreeTris += info.render.triangles || 0
      W.__dpResets++
      return origReset.apply(this, arguments)
    }
    probe.hooked = true
    probe.rendererKind = renderer.isWebGPURenderer ? 'webgpu' : (renderer.isWebGLRenderer ? 'webgl' : renderer.constructor && renderer.constructor.name)
  }
  function tick(ts) {
    const renderer = W.__app && W.__app.renderer
    if (renderer) {
      hookInfo(renderer)
      const info = renderer.info
      if (probe.samples.length < 4000) {
        probe.samples.push({
          ts: +ts.toFixed(2),
          infoRenderCalls: info.render.calls === undefined ? null : info.render.calls,
          infoDrawCalls: info.render.drawCalls === undefined ? null : info.render.drawCalls,
          infoFrameCalls: info.render.frameCalls === undefined ? null : info.render.frameCalls,
          infoTriangles: info.render.triangles,
          threeDrawsTotal: W.__dpThreeDraws,
          threeTrisTotal: W.__dpThreeTris,
          resets: W.__dpResets,
          glCalls: W.__dpGlCalls,
          glDraws: W.__dpGlDraws,
          wgpuCalls: W.__dpWgpuCalls,
          wgpuDraws: W.__dpWgpuDraws,
        })
      }
      W.__dpOn = true
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})()`

const READY = `window.__app && window.__app.loadingMachine && window.__app.loadingMachine.isReady && window.__drawProbe && window.__drawProbe.hooked`

async function main() {
  process.env.SPOINT_SKIP_PREWARM = process.env.SPOINT_SKIP_PREWARM || '1'
  process.env.WORLD = process.env.WORLD || WORLD
  process.env.PORT = PORT
  process.env.SPOINT_NO_WATCH = '1'
  console.log(`[draw-instrument] booting real server on ${PORT} (world=${process.env.WORLD}) ...`)
  const { boot } = await import(pathToFileURL(resolve(ROOT, 'src', 'sdk', 'server.js')).href)
  const server = await boot()

  let browser
  try {
    browser = await chromium.launch({ headless: true, args: GPU_ARGS[GL] || GPU_ARGS.swiftshader })
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    const pageErrors = []
    page.on('pageerror', e => pageErrors.push(String(e)))
    await page._send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE })
    const query = BACKEND === 'webgpu' ? `${PARAMS}&webgpu=1` : PARAMS
    const url = `http://localhost:${PORT}/?${query}&world=${WORLD}&v=${Date.now()}`
    console.log(`[draw-instrument] navigating ${url}`)
    await page.goto(url, { waitUntil: 'domcontentloaded' })

    const t0 = Date.now()
    let ready = false
    while (Date.now() - t0 < TIMEOUT_MS) {
      ready = await page.evaluate(`!!(${READY})`).catch(() => false)
      if (ready) break
      await new Promise(r => setTimeout(r, 250))
    }
    if (!ready) {
      console.error('[draw-instrument] RESULT: FAIL -- page never became ready with the probe hooked')
      process.exit(1)
    }
    console.log(`[draw-instrument] ready @ ${Date.now() - t0}ms`)

    const built = `performance.getEntriesByType('mark').some(m => m.name === 'boot:scenery-built')`
    let scenery = false
    const tScenery = Date.now()
    while (Date.now() - tScenery < TIMEOUT_MS) {
      scenery = await page.evaluate(built).catch(() => false)
      if (scenery) break
      await new Promise(r => setTimeout(r, 250))
    }
    console.log(`[draw-instrument] boot:scenery-built ${scenery ? 'reached' : 'UNREACHED'} @ ${Date.now() - tScenery}ms`)
    await new Promise(r => setTimeout(r, SETTLE_MS))
    console.log(`[draw-instrument] settled ${SETTLE_MS}ms; veg=${await page.evaluate(`window.__veg ? (window.__veg.totalInstances || 0) : 0`).catch(() => 'n/a')}`)

    await page.evaluate(`(() => { window.__drawProbe.samples.length = 0; return true })()`)
    const wanted = FRAMES + 1
    const t1 = Date.now()
    while (Date.now() - t1 < TIMEOUT_MS) {
      const n = await page.evaluate(`window.__drawProbe.samples.length`).catch(() => 0)
      if (n >= wanted) break
      await new Promise(r => setTimeout(r, 100))
    }
    const out = await page.evaluate(`(() => {
      const p = window.__drawProbe
      const s = p.samples.slice(0, ${wanted})
      const r = window.__app.renderer
      const b = r.backend || {}
      return {
        rendererKind: p.rendererKind,
        autoReset: r.info.autoReset,
        hasDrawCallsField: r.info.render.drawCalls !== undefined,
        backendCtor: b.constructor && b.constructor.name,
        backendIsWebGL: !!b.isWebGLBackend,
        backendIsWebGPU: !!b.isWebGPUBackend,
        webgpuAdapterPresent: !!(navigator.gpu && typeof navigator.gpu.requestAdapter === 'function'),
        vegInstances: window.__veg ? (window.__veg.totalInstances || 0) : 0,
        samples: s,
      }
    })()`)

    const s = out.samples
    console.log(`[draw-instrument] renderer=${out.rendererKind} backend=${out.backendCtor} isWebGL=${out.backendIsWebGL} isWebGPU=${out.backendIsWebGPU} autoReset=${out.autoReset} hasDrawCallsField=${out.hasDrawCallsField} veg=${out.vegInstances} samples=${s.length}`)
    console.log('[draw-instrument] raw consecutive-frame samples:')
    for (let i = 0; i < s.length; i++) {
      const x = s[i]
      console.log(`  #${i} ts=${x.ts} info.render.calls=${x.infoRenderCalls} info.render.drawCalls=${x.infoDrawCalls} info.render.frameCalls=${x.infoFrameCalls} threeDrawsTotal=${x.threeDrawsTotal} resets=${x.resets} glDraws=${x.glDraws} glCalls=${x.glCalls} wgpuDraws=${x.wgpuDraws} wgpuCalls=${x.wgpuCalls}`)
    }
    console.log('[draw-instrument] per-frame deltas between consecutive samples:')
    const d = { infoRenderCalls: [], threeDraws: [], threeTris: [], glDraws: [], glCalls: [], wgpuDraws: [], wgpuCalls: [], resets: [] }
    for (let i = 1; i < s.length; i++) {
      const a = s[i - 1], b = s[i]
      const row = {
        infoRenderCalls: b.infoRenderCalls - a.infoRenderCalls,
        threeDraws: b.threeDrawsTotal - a.threeDrawsTotal,
        threeTris: b.threeTrisTotal - a.threeTrisTotal,
        glDraws: b.glDraws - a.glDraws,
        glCalls: b.glCalls - a.glCalls,
        wgpuDraws: b.wgpuDraws - a.wgpuDraws,
        wgpuCalls: b.wgpuCalls - a.wgpuCalls,
        resets: b.resets - a.resets,
      }
      for (const k of Object.keys(d)) d[k].push(row[k])
      console.log(`  frame ${i - 1}->${i}: ${JSON.stringify(row)}`)
    }
    const avg = (a) => +(a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)).toFixed(1)
    console.log('[draw-instrument] summary avg per frame: ' + JSON.stringify({
      infoRenderCallsDelta: avg(d.infoRenderCalls),
      threeDrawsPerFrame: avg(d.threeDraws),
      threeTrisPerFrame: avg(d.threeTris),
      resetsPerFrame: avg(d.resets),
      glDrawsPerFrame: avg(d.glDraws),
      glCallsPerFrame: avg(d.glCalls),
      wgpuDrawsPerFrame: avg(d.wgpuDraws),
      wgpuCallsPerFrame: avg(d.wgpuCalls),
    }))
    const first = s[0]
    const last = s[s.length - 1]
    console.log('[draw-instrument] ramp check: info.render.calls ' + first.infoRenderCalls + ' -> ' + last.infoRenderCalls + ' over ' + (s.length - 1) + ' frames (monotonic=' + (last.infoRenderCalls >= first.infoRenderCalls) + ')')
    console.log('[draw-instrument] pageErrors=' + pageErrors.length + (pageErrors.length ? ' first=' + pageErrors[0].slice(0, 200) : ''))
    await browser.close().catch(() => {})
    server.stop()
    console.log('[draw-instrument] RESULT: PASS')
    process.exit(0)
  } catch (e) {
    console.error('[draw-instrument] FAILED: ' + (e.stack || e.message))
    if (browser) await browser.close().catch(() => {})
    server.stop()
    process.exit(1)
  }
}

main()
