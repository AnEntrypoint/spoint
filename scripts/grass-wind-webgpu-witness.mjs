#!/usr/bin/env node
// Does the shared grass gust field COMPILE and DRAW on real accelerated WebGPU, and what does it
// cost in wall and main-thread CPU?
//
// PERF-grass-coherent-wind-1013 landed the join on a measurement taken on the WebGL fallback
// (webgpu=none, backend=webgl2) and vsync-locked, so the one path that ships -- the TSL/WGSL path,
// where client/core/GrassTSL.js's gustField is a texture() sampled in the VERTEX stage with an
// explicit level 0 -- has never been compiled by a real WebGPU driver. A textureSample in the
// vertex stage is illegal in WGSL; only textureSampleLevel is not. The legacy GLSL path booted
// clean, and that is not evidence about WGSL.
//
// It matters because the failure is silent. AGENTS.md: a WebGPU pipeline that fails validation
// dispatches nothing and surfaces nothing -- three caches the wrapper before the compile result,
// draw() returns early on it and nothing resets it, so the shape stays broken for the process
// lifetime, and the error arrives only ASYNC via device.onuncapturederror. So this witness reads
// three separate error channels rather than trusting a clean console:
//
//   1. GPUDevice.createShaderModule -> getCompilationInfo(), on every module whose WGSL carries a
//      grass marker (windShadow / clumpRank / vFieldXZ / vLocalNoise). This is the compile itself.
//   2. GPUDevice.createRenderPipeline{,Async} wrapped in pushErrorScope('validation') /
//      popErrorScope(), so a pipeline that fails validation is refused instead of silent.
//   3. device.addEventListener('uncapturederror', ...) -- the async channel three's renderer sees.
//
// And it does not stop at "it compiled": the wind has to still ANIMATE and grass has to still DRAW
// on that path, both measured. Animation is read from the bytes the CPU hands the GPU: the field
// is a 64x64 rgba16float DataTexture, so queue.writeTexture of exactly 64*64*8 bytes is the field
// upload, and a checksum of its payload says whether the field actually changed between frames --
// a frozen field and a wind that costs nothing to compute look identical to every other counter.
//
// The before/after: the CPU half of the join is switchable in one page load (the field is advanced
// from the uGrassTime setter, which tickWind drives, so stubbing window.__grass.tickWind returns
// the lattice to the "no field at all" state the before arm had), and the draw instrument gets a
// deterministic positive control (hiding grass must drop the API-boundary draw count by exactly
// the grass draws). The GPU half is NOT switchable: no reproduction switch exists in the client
// for per-blade wind -- `grassWind` is a preset key nothing in the grass code reads -- so the
// GPU-side delta is reported as a non-resolution with that evidence rather than as a number.
//
// Boots a real accelerated browser, so it is refused by name from the gpu-free arm of
// scripts/check.mjs and runs only behind SPOINT_GPU_WITNESS plus gpulock.

import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, DEFAULT_VIEWPORT } from './lib/cdp-browser.mjs'
import { gpuArgs, assertGpu } from './lib/gpu-probe.mjs'
import { vendorPinArgs } from './lib/witness-gpu.mjs'
import { assertServedClientRoot, clientRootTag, rebuildIfRequested, CLIENT_ROOT_BUNDLE } from './lib/served-client-root.mjs'
import { flagNumber } from './lib/witness-args.mjs'
import { contentionWatch, contentionMark, contentionVerdict, formatContention } from './lib/host-contention.mjs'

const LABEL = 'grass-wind-webgpu'
const log = (s) => console.log(`[${LABEL}] ${s}`)

if (!process.env.SPOINT_GPU_WITNESS) {
  console.log(`[${LABEL}] SKIP: SPOINT_GPU_WITNESS is unset -- this witness needs an accelerated browser and is refused by name from the gpu-free arm of scripts/check.mjs`)
  process.exit(0)
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

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
const AT = String(flag('at', '-500,-500'))
const SETTLE_MS = flagNumber(flag, 'settle', 45000, argv)
const CONTROL_MS = flagNumber(flag, 'control', 10000, argv)
const AB_MS = flagNumber(flag, 'ab', 6000, argv)
// Alternating ON/OFF windows. Four long windows cannot separate the effect from a box that is
// slowly changing speed: with one ON and one OFF each side, mean(ON) - mean(OFF) is biased by the
// per-window drift, and a 0.1 ms/frame effect sitting on a 0.1 ms/window drift reads as 0.12 either
// way. Eight short windows give four ADJACENT pairs, and under a linear drift every adjacent pair
// carries the same bias, so the drift can be estimated from the two series and removed -- and the
// spread of the four paired differences is then the noise the effect has to beat.
const AB_WINDOWS = Math.max(2, Math.round(flagNumber(flag, 'windows', 8, argv) / 2) * 2)
const WALK_MS = flagNumber(flag, 'walk', 45000, argv)
const WALK_SPEED = flagNumber(flag, 'walk-speed', 7, argv)
const ROUTE = String(flag('route', '-500,-500;-380,-500;-500,-500'))
const EXPECT_VENDOR = flag('expect-vendor', GPU)
const LAUNCH_ARGS = [...gpuArgs({ accelerated: true }), ...vendorPinArgs(GPU)]
const VIEW = String(flag('viewport', DEFAULT_VIEWPORT.width + 'x' + DEFAULT_VIEWPORT.height)).split('x').map(Number)
const VIEWPORT = { width: VIEW[0] || 1280, height: VIEW[1] || 720 }
const RUN_ID = String(flag('run-id', 'r' + Date.now().toString(36)))

const FIELD_BYTES = 64 * 64 * 8 // 64x64 rgba16float: the one texture in the frame that is the field

// ---------------------------------------------------------------- the in-page instrument

const INIT = `(() => {
  const P = {
    installed: true,
    hasWebGPU: typeof GPUDevice !== 'undefined',
    devices: 0,
    modules: 0,
    grassModules: [],
    pipelines: 0,
    pipelineErrors: [],
    uncaptured: [],
    uploads: [],
    uploadsDropped: 0,
    uploadHist: {},
    draws: 0,
    frames: 0,
    frameWork: [],
    frameWall: [],
    curFrame: -1,
    _lastTs: 0,
    rafWrapped: false,
  }
  window.__gww = P

  const hashU16 = (u16) => {
    let h = 2166136261
    const n = u16.length
    for (let i = 0; i < n; i += 13) { h ^= u16[i]; h = Math.imul(h, 16777619) }
    return h >>> 0
  }

  if (typeof GPUDevice !== 'undefined') {
    const D = GPUDevice.prototype

    // 1. the compile itself
    const origModule = D.createShaderModule
    if (origModule) {
      D.createShaderModule = function (desc) {
        const m = origModule.call(this, desc)
        try {
          const code = (desc && desc.code) || ''
          P.modules++
          if (/windShadow|clumpRank|vFieldXZ|vLocalNoise|grassNoise/.test(code)) {
            const vi = code.indexOf('@vertex')
            const fi = code.indexOf('@fragment')
            const vSrc = vi >= 0 ? code.slice(vi, fi > vi ? fi : code.length) : ''
            const rec = {
              len: code.length,
              label: (desc && desc.label) || null,
              vertexSampleLevel: (vSrc.match(/textureSampleLevel/g) || []).length,
              vertexSampleNoLevel: (vSrc.match(/textureSample\\s*\\(/g) || []).length,
              fragmentSampleNoLevel: ((fi >= 0 ? code.slice(fi) : '').match(/textureSample\\s*\\(/g) || []).length,
              hasUvArg: /textureSampleLevel\\([^)]*,[^)]*,[^)]*,[^)]*\\)/.test(vSrc),
              excerpt: vi >= 0 ? code.slice(vi, vi + 400) : null,
              compilationChecked: false,
              compilationErrors: null,
              compilationWarnings: null,
              compilationMessages: null,
            }
            P.grassModules.push(rec)
            if (typeof m.getCompilationInfo === 'function') {
              m.getCompilationInfo().then((info) => {
                const msgs = (info && info.messages) || []
                rec.compilationErrors = msgs.filter((x) => x.type === 'error').length
                rec.compilationWarnings = msgs.filter((x) => x.type === 'warning').length
                rec.compilationMessages = msgs.slice(0, 6).map((x) => ({ type: x.type, line: x.lineNum, message: String(x.message).slice(0, 240) }))
                rec.compilationChecked = true
              }).catch((e) => { rec.compilationCheckError = String((e && e.message) || e) })
            }
          }
        } catch (e) { P.moduleHookError = String((e && e.message) || e) }
        return m
      }
    }

    // 2. a pipeline that fails validation is REFUSED, not silent
    const wrapPipeline = (name) => {
      const orig = D[name]
      if (!orig) return
      D[name] = function (desc) {
        P.pipelines++
        let scoped = true
        try { this.pushErrorScope('validation') } catch (e) { scoped = false }
        let out
        try { out = orig.call(this, desc) } catch (e) {
          if (scoped) { try { this.popErrorScope() } catch (_) {} }
          throw e
        }
        const pop = () => {
          if (!scoped) return
          try {
            this.popErrorScope().then((err) => {
              if (err) P.pipelineErrors.push({ at: Math.round(performance.now()), message: String((err && err.message) || err) })
            }).catch(() => {})
          } catch (_) {}
        }
        if (out && typeof out.then === 'function') out.then(pop, pop); else pop()
        return out
      }
    }
    wrapPipeline('createRenderPipeline')
    wrapPipeline('createRenderPipelineAsync')
    wrapPipeline('createComputePipeline')
    wrapPipeline('createComputePipelineAsync')
  }

  if (typeof GPUAdapter !== 'undefined') {
    const origReq = GPUAdapter.prototype.requestDevice
    if (origReq) {
      GPUAdapter.prototype.requestDevice = async function (...a) {
        const dev = await origReq.apply(this, a)
        try {
          P.devices++
          // 3. the async channel: three's renderer.onError
          dev.addEventListener('uncapturederror', (e) => {
            const err = e && e.error
            P.uncaptured.push({ at: Math.round(performance.now()), message: String((err && err.message) || (e && e.message) || e) })
          })
        } catch (_) {}
        return dev
      }
    }
  }

  if (typeof GPUQueue !== 'undefined') {
    const origW = GPUQueue.prototype.writeTexture
    if (origW) {
      GPUQueue.prototype.writeTexture = function (dst, data, layout, size) {
        try {
          // writeTexture's first argument is a GPUTexelCopyTextureInfo ({ texture, mipLevel,
          // origin }), not the GPUTexture itself, so the size and format live one level down.
          const tex = (dst && dst.texture) ? dst.texture : dst
          const w = tex && tex.width
          const h = tex && tex.height
          const fmt = tex && tex.format
          let bytes = 0
          if (data && data.byteLength) bytes = data.byteLength
          else if (layout && layout.bytesPerRow && size && size[1]) bytes = layout.bytesPerRow * size[1]
          const key = w + 'x' + h + ' ' + fmt + ' ' + bytes
          P.uploadHist[key] = (P.uploadHist[key] || 0) + 1
          if (w === 64 && h === 64 && (fmt === 'rgba16float' || bytes === 32768)) {
            let u16 = null
            if (data && data.BYTES_PER_ELEMENT === 2) u16 = data
            else if (data && data.byteLength) u16 = new Uint16Array(data.buffer || data, data.byteOffset || 0, Math.floor(data.byteLength / 2))
            const rec = { at: Math.round(performance.now()), bytes, fmt, hash: u16 ? hashU16(u16) : null }
            if (P.uploads.length < 60000) P.uploads.push(rec)
            else P.uploadsDropped++
          }
        } catch (e) { P.uploadHookError = String((e && e.message) || e) }
        return origW.call(this, dst, data, layout, size)
      }
    }
  }

  if (typeof GPURenderPassEncoder !== 'undefined') {
    const PR = GPURenderPassEncoder.prototype
    for (const n of ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect']) {
      const o = PR[n]
      if (!o) continue
      PR[n] = function (...a) { P.draws++; return o.apply(this, a) }
    }
  }

  const origRaf = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = function (cb) {
    return origRaf(function (ts) {
      const idx = P.frameWork.length
      P.frameWork.push(0)
      P.curFrame = idx
      if (P._lastTs) {
        const d = ts - P._lastTs
        if (d < 2000 && P.frameWall.length < 60000) P.frameWall.push(d)
      }
      P._lastTs = ts
      const t0 = performance.now()
      let r
      try { r = cb(ts) } finally { P.frameWork[idx] = performance.now() - t0; P.frames++ }
      return r
    })
  }
  P.rafWrapped = true
})()`

// ---------------------------------------------------------------- helpers

const pct = (a, p) => {
  if (!a.length) return null
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]
}
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null)
const f2 = (v) => (v === null || v === undefined ? 'null' : v.toFixed(2))
const f3 = (v) => (v === null || v === undefined ? 'null' : v.toFixed(3))

const resetCounters = (page) => page.evaluate(() => {
  const P = window.__gww
  P.uploads.length = 0
  P.draws = 0
  P.frames = 0
  P.frameWork.length = 0
  P.frameWall.length = 0
  P._lastTs = 0
  return true
})

const readCounters = (page) => page.evaluate((fieldBytes) => {
  const P = window.__gww
  const hashes = new Set()
  for (const u of P.uploads) hashes.add(u.hash)
  const g = window.__grass
  return {
    frames: P.frames,
    draws: P.draws,
    uploads: P.uploads.length,
    uploadsDropped: P.uploadsDropped,
    uploadHist: P.uploadHist,
    uploadHookError: P.uploadHookError || null,
    distinctFieldHashes: hashes.size,
    fieldBytesSeen: P.uploads.length ? P.uploads[0].bytes : null,
    expectedBytes: fieldBytes,
    frameWork: P.frameWork.slice(-4000),
    frameWall: P.frameWall.slice(-4000),
    live: g ? g.totalInstances : null,
    near: (() => { const a = g && g._im; if (!a) return null; const m = a.mesh || a; return m.count || 0 })(),
    mid: (() => { const a = g && g._imMid; if (!a) return null; const m = a.mesh || a; return m.count || 0 })(),
    profile: window.__grassProfile || null,
  }
}, FIELD_BYTES)

async function metrics(page) {
  const r = await page._send('Performance.getMetrics')
  const out = {}
  for (const m of (r.metrics || [])) out[m.name] = m.value
  return out
}

async function measureWindow(page, ms, label, watch) {
  await resetCounters(page)
  const before = await metrics(page)
  const t0 = Date.now()
  await new Promise((r) => setTimeout(r, ms))
  if (watch) contentionMark(watch)
  const after = await metrics(page)
  const wallMs = Date.now() - t0
  const c = await readCounters(page)
  const d = (k) => ((after[k] || 0) - (before[k] || 0)) * 1000
  const threadMs = d('ThreadTime')
  const scriptMs = d('ScriptDuration')
  const out = {
    label,
    wallMs,
    frames: c.frames,
    drawsPerFrame: c.frames ? +(c.draws / c.frames).toFixed(2) : null,
    uploadsPerFrame: c.frames ? +(c.uploads / c.frames).toFixed(3) : null,
    distinctFieldHashes: c.distinctFieldHashes,
    fieldBytesSeen: c.fieldBytesSeen,
    cpuMsPerFrame: c.frames ? +(threadMs / c.frames).toFixed(3) : null,
    scriptMsPerFrame: c.frames ? +(scriptMs / c.frames).toFixed(3) : null,
    wallMsPerFrame: c.frames ? +(wallMs / c.frames).toFixed(3) : null,
    frameWallP50: pct(c.frameWall, 0.5),
    frameWallP95: pct(c.frameWall, 0.95),
    frameWallMax: c.frameWall.length ? Math.max(...c.frameWall) : null,
    frameWorkP50: pct(c.frameWork, 0.5),
    frameWorkP95: pct(c.frameWork, 0.95),
    frameWorkMax: c.frameWork.length ? Math.max(...c.frameWork) : null,
    live: c.live,
    near: c.near,
    mid: c.mid,
    threadMs: +threadMs.toFixed(1),
  }
  log(`window ${label}: ` + JSON.stringify({
    wallMs: out.wallMs, frames: out.frames, fps: c.frames ? +(c.frames / (wallMs / 1000)).toFixed(2) : null,
    cpuMsPerFrame: out.cpuMsPerFrame, wallMsPerFrame: out.wallMsPerFrame,
    frameWallP50: f2(out.frameWallP50), frameWallP95: f2(out.frameWallP95), frameWallMax: f2(out.frameWallMax),
    frameWorkP50: f2(out.frameWorkP50), frameWorkP95: f2(out.frameWorkP95),
    drawsPerFrame: out.drawsPerFrame, uploadsPerFrame: out.uploadsPerFrame,
    distinctFieldHashes: out.distinctFieldHashes, live: out.live, near: out.near, mid: out.mid,
  }))
  return out
}

// ---------------------------------------------------------------- boot

const port = String(20000 + Math.floor(Math.random() * 20000))
process.env.WORLD = process.env.WORLD || 'tps-game'
process.env.PORT = port
process.env.SPOINT_NO_WATCH = '1'

rebuildIfRequested(LABEL)
const { boot } = await import(pathToFileURL(resolve(ROOT, 'src', 'sdk', 'server.js')).href)
const server = await boot()
log(`server on ${port} runId=${RUN_ID}`)

let browser
let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} (${detail})`)
}
const watch = contentionWatch()

try {
  browser = await chromium.launch({ args: LAUNCH_ARGS })
  const page = await browser.newPage({ viewport: VIEWPORT })
  const errors = []
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || (e && e.message) || e)))
  await page._send('Performance.enable').catch((e) => log('Performance.enable refused, so no ThreadTime will be readable: ' + e.message))
  const scriptInjected = await page._send('Page.addScriptToEvaluateOnNewDocument', { source: INIT }).then((r) => r).catch((e) => ({ error: e.message }))
  if (!scriptInjected || scriptInjected.error || !scriptInjected.identifier) {
    log('the GPU instrument was never installed: ' + JSON.stringify(scriptInjected))
    console.log('RESULT: FAIL instrument-not-installed')
    process.exit(1)
  }
  log('instrument installed: ' + JSON.stringify({ identifier: scriptInjected.identifier }))

  const url = `http://localhost:${port}/?singleplayer&world=tps-game&at=${encodeURIComponent(AT)}&v=${Date.now()}`
  log('goto ' + url)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })

  const servedRoot = await assertServedClientRoot(page, { want: CLIENT_ROOT_BUNDLE, label: LABEL })
  log(`served ${clientRootTag(servedRoot)} required=${CLIENT_ROOT_BUNDLE}`)

  const t0 = Date.now()
  let revealedAt = null
  while (Date.now() - t0 < 300000) {
    const r = await page.evaluate(() => ({ revealedAt: (window.__app && window.__app.revealedAt) || 0 })).catch(() => null)
    if (r && r.revealedAt) { revealedAt = r.revealedAt; break }
    await new Promise((r2) => setTimeout(r2, 250))
  }
  if (!revealedAt) { log('scenery never built'); console.log('RESULT: FAIL scenery-never-built'); process.exit(1) }

  const gpu = await assertGpu(page, { requireAccelerated: true, expectVendor: EXPECT_VENDOR })
  log('gpu ' + JSON.stringify({ rasterizer: gpu.rasterizer, renderer: gpu.renderer, vendor: gpu.adapter }))
  log('scenery-built at ' + revealedAt + 'ms')

  const govOff = await page.evaluate(() => {
    const rc = window.__renderControls
    if (!rc || typeof rc.set !== 'function') return { ok: false, reason: 'window.__renderControls.set absent' }
    rc.set('qualityGovernor', false)
    return { ok: true, readback: rc.get('qualityGovernor') }
  }).catch((e) => ({ ok: false, reason: e.message }))
  log('governor disable: ' + JSON.stringify(govOff))

  const info = await page.evaluate(() => ({
    rendererInfo: window.__rendererInfo || null,
    installed: !!(window.__gww && window.__gww.installed),
    hasWebGPU: window.__gww ? window.__gww.hasWebGPU : null,
    rafWrapped: window.__gww ? window.__gww.rafWrapped : null,
    grass: !!window.__grass,
  }))
  log('rendererInfo ' + JSON.stringify(info.rendererInfo))
  const backend = info.rendererInfo ? info.rendererInfo.backend : null
  const rclass = info.rendererInfo ? info.rendererInfo.class : null

  const tSettle = Date.now()
  let settled = null
  while (Date.now() - tSettle < SETTLE_MS) {
    await new Promise((r2) => setTimeout(r2, 2500))
    settled = await readCounters(page)
  }
  contentionMark(watch)
  log('settled ' + JSON.stringify({ live: settled.live, near: settled.near, mid: settled.mid, frames: settled.frames, draws: settled.draws }))
  log('upload histogram (w x h format bytes -> count): ' + JSON.stringify(settled.uploadHist))
  if (settled.uploadHookError) log('upload hook error: ' + settled.uploadHookError)

  // ------------------------------------------------------------- 1/2/3. did it compile?

  const compile = await page.evaluate(() => {
    const P = window.__gww
    return {
      installed: !!P.installed,
      hasWebGPU: P.hasWebGPU,
      devices: P.devices,
      modules: P.modules,
      pipelines: P.pipelines,
      grassModules: P.grassModules.map((m) => ({
        len: m.len, label: m.label,
        vertexSampleLevel: m.vertexSampleLevel,
        vertexSampleNoLevel: m.vertexSampleNoLevel,
        fragmentSampleNoLevel: m.fragmentSampleNoLevel,
        compilationChecked: m.compilationChecked,
        compilationErrors: m.compilationErrors,
        compilationWarnings: m.compilationWarnings,
        compilationCheckError: m.compilationCheckError || null,
        compilationMessages: m.compilationMessages || null,
        excerpt: m.excerpt ? m.excerpt.slice(0, 240) : null,
      })),
      pipelineErrors: P.pipelineErrors.slice(0, 8),
      pipelineErrorCount: P.pipelineErrors.length,
      uncaptured: P.uncaptured.slice(0, 8),
      uncapturedCount: P.uncaptured.length,
      uploadHookError: P.uploadHookError || null,
      moduleHookError: P.moduleHookError || null,
    }
  })
  log('compile evidence: ' + JSON.stringify({
    hasWebGPU: compile.hasWebGPU, devices: compile.devices, modules: compile.modules,
    pipelines: compile.pipelines, grassModules: compile.grassModules.length,
    pipelineErrorCount: compile.pipelineErrorCount, uncapturedCount: compile.uncapturedCount,
  }))
  for (const m of compile.grassModules) {
    log(`  grass WGSL module len=${m.len} vertexSampleLevel=${m.vertexSampleLevel} vertexSampleNoLevel=${m.vertexSampleNoLevel} fragmentSampleNoLevel=${m.fragmentSampleNoLevel} compilationErrors=${m.compilationErrors} warnings=${m.compilationWarnings} checked=${m.compilationChecked}`)
    if (m.excerpt) log('    excerpt: ' + m.excerpt.replace(/\s+/g, ' ').slice(0, 200))
  }
  if (compile.pipelineErrorCount) for (const e of compile.pipelineErrors) log('  validation error: ' + e.message)
  if (compile.uncapturedCount) for (const e of compile.uncaptured) log('  uncaptured error: ' + e.message)

  // ------------------------------------------------------------- 3. does grass draw?

  const setGrassVisible = (v) => page.evaluate((vis) => {
    const g = window.__grass
    if (!g) return { ok: false, reason: 'window.__grass absent' }
    g._im.visible = vis
    g._imMid.visible = vis
    return { ok: true, near: g._im.visible, mid: g._imMid.visible }
  }, v).catch((e) => ({ ok: false, reason: e.message }))

  const shown = await setGrassVisible(true)
  await new Promise((r) => setTimeout(r, 2000))
  const wShown = await measureWindow(page, CONTROL_MS, 'grass-shown', watch)
  const hidden = await setGrassVisible(false)
  await new Promise((r) => setTimeout(r, 2000))
  const wHidden = await measureWindow(page, CONTROL_MS, 'grass-hidden', watch)
  await setGrassVisible(true)
  await new Promise((r) => setTimeout(r, 2000))

  const grassDrawsPerFrame = (wShown.drawsPerFrame !== null && wHidden.drawsPerFrame !== null)
    ? +(wShown.drawsPerFrame - wHidden.drawsPerFrame).toFixed(2) : null
  log('control: ' + JSON.stringify({
    shown: shown, hidden: hidden,
    drawsShown: wShown.drawsPerFrame, drawsHidden: wHidden.drawsPerFrame,
    grassDrawsPerFrame,
    cpuShown: wShown.cpuMsPerFrame, cpuHidden: wHidden.cpuMsPerFrame,
    cpuShareMsPerFrame: (wShown.cpuMsPerFrame !== null && wHidden.cpuMsPerFrame !== null) ? +(wShown.cpuMsPerFrame - wHidden.cpuMsPerFrame).toFixed(3) : null,
    liveShown: wShown.live, liveHidden: wHidden.live,
  }))

  // ------------------------------------------------------------- 4. before/after, one page

  // The field is advanced from the uGrassTime setter, which tickWind drives, so stubbing tickWind
  // returns the lattice to the state the before arm had: no lattice, nothing uploaded, 0 ms/frame.
  const armInit = await page.evaluate(() => {
    const g = window.__grass
    if (!g) return { ok: false, reason: 'window.__grass absent' }
    if (!window.__gwwArm) window.__gwwArm = { orig: g.tickWind, stubbed: false }
    return { ok: true, hasOrig: typeof window.__gwwArm.orig === 'function' }
  })
  const setArm = (on) => page.evaluate((isOn) => {
    const g = window.__grass
    const A = window.__gwwArm
    if (!g || !A) return { ok: false, reason: 'arm absent' }
    g.tickWind = isOn ? A.orig : function () {}
    A.stubbed = !isOn
    return { ok: true, on: isOn, same: g.tickWind === A.orig }
  }, on).catch((e) => ({ ok: false, reason: e.message }))

  const wins = []
  if (armInit.ok) {
    for (let i = 0; i < AB_WINDOWS; i++) {
      const on = i % 2 === 0
      const sw = await setArm(on)
      if (i === 0 || i === AB_WINDOWS - 1) log(`arm ${on ? 'ON (field advanced)' : 'OFF (no lattice)'}: ` + JSON.stringify(sw))
      contentionMark(watch)
      await new Promise((r) => setTimeout(r, 1200))
      wins.push({ on, ...(await measureWindow(page, AB_MS, `field-${on ? 'on' : 'off'}-${i + 1}`, watch)) })
    }
    await setArm(true)
  } else {
    log('the before/after arm could not be installed: ' + JSON.stringify(armInit))
  }

  let ab = null
  if (wins.length >= 4 && wins.length % 2 === 0) {
    const on = wins.filter((w) => w.on)
    const off = wins.filter((w) => !w.on)
    const stat = (series, f) => {
      const first = f(series[0]), last = f(series[series.length - 1])
      const n = series.length
      // series members are two window indices apart (ON at 1,3,5,7 / OFF at 2,4,6,8)
      return { mean: mean(series.map(f)), driftPerWindow: (last - first) / (2 * (n - 1)), first, last }
    }
    const cpuOn = stat(on, (w) => w.cpuMsPerFrame)
    const cpuOff = stat(off, (w) => w.cpuMsPerFrame)
    const wallOn = stat(on, (w) => w.wallMsPerFrame)
    const wallOff = stat(off, (w) => w.wallMsPerFrame)
    // adjacent pairs: an ON window and the OFF window that follows it
    const paired = []
    const pairedWall = []
    for (let k = 0; k < off.length; k++) {
      paired.push(+(on[k].cpuMsPerFrame - off[k].cpuMsPerFrame).toFixed(3))
      pairedWall.push(+(on[k].wallMsPerFrame - off[k].wallMsPerFrame).toFixed(3))
    }
    const pairedMean = +mean(paired).toFixed(3)
    const driftPerWindow = +((cpuOn.driftPerWindow + cpuOff.driftPerWindow) / 2).toFixed(3)
    // an adjacent ON/OFF pair differs by (effect - drift), so the drift ADDS back
    const effectMs = +(pairedMean + driftPerWindow).toFixed(3)
    const noiseMs = +Math.max(...paired.map((p) => Math.abs(p - pairedMean))).toFixed(3)
    const shareNaiveMs = +(cpuOn.mean - cpuOff.mean).toFixed(3)
    const wallPairedMean = +mean(pairedWall).toFixed(3)
    const wallDriftPerWindow = +((wallOn.driftPerWindow + wallOff.driftPerWindow) / 2).toFixed(3)
    const wallEffectMs = +(wallPairedMean + wallDriftPerWindow).toFixed(3)
    const wallNoiseMs = +Math.max(...pairedWall.map((p) => Math.abs(p - wallPairedMean))).toFixed(3)
    const armTook = off.every((w) => w.distinctFieldHashes <= 1 && (w.uploadsPerFrame || 0) === 0)
      && on.every((w) => w.distinctFieldHashes > 1 && (w.uploadsPerFrame || 0) >= 0.9)
    // The effect has to beat the spread of the pairs it was estimated from, or it is the drift.
    const cpuResolved = armTook && effectMs > 0 && effectMs > noiseMs
    const wallResolved = armTook && Math.abs(wallEffectMs) > 0.05 && Math.abs(wallEffectMs) > wallNoiseMs
    ab = {
      windows: wins.length,
      onMean: +cpuOn.mean.toFixed(3), offMean: +cpuOff.mean.toFixed(3),
      shareNaiveMs, pairedCpu: paired, pairedMean, driftPerWindow, effectMs, noiseMs,
      onWall: +wallOn.mean.toFixed(3), offWall: +wallOff.mean.toFixed(3),
      wallPairedMean, wallDriftPerWindow, wallEffectMs, wallNoiseMs,
      armTook, cpuResolved, wallResolved,
      onHashes: on.map((w) => w.distinctFieldHashes),
      offHashes: off.map((w) => w.distinctFieldHashes),
      onUploadsPerFrame: on.map((w) => w.uploadsPerFrame),
      offUploadsPerFrame: off.map((w) => w.uploadsPerFrame),
      verdict: cpuResolved ? 'RESOLVED' : 'UNRESOLVED',
    }
    log('before/after (no lattice -> shared field, alternating, one page, one boot): ' + JSON.stringify(ab))
    log(`  drift handling: the naive ON-OFF difference is ${shareNaiveMs} ms/frame, but this run's own drift was ${driftPerWindow} ms/window, so after it is removed the effect is ${effectMs} ms/frame against a pair spread of ${noiseMs} ms/frame`)
    if (cpuResolved) {
      console.log(`  [PASS] the joined wind has a main-thread cost that appears only once the lattice is advanced (drift-corrected ${effectMs} ms/frame, pairs ${JSON.stringify(paired)}, pair spread ${noiseMs})`)
    } else {
      log(`  the before/after CPU did not resolve: drift-corrected effect ${effectMs} ms/frame against a pair spread of ${noiseMs} ms/frame (naive ${shareNaiveMs}, drift ${driftPerWindow}/window, armTook=${armTook}) -- ${armTook ? 'the effect is inside this run\'s own noise, so no per-frame CPU cost is attributed to the join here' : 'the arm switch never took, so both arms are one arm measured twice'}`)
    }
    if (!wallResolved) log(`  the before/after WALL did not resolve (drift-corrected ${wallEffectMs} ms/frame against a pair spread of ${wallNoiseMs}; the naive figure is ${wallPairedMean}): rAF-to-rAF wall is vsync-quantized, so a sub-millisecond change cannot be read on it`)
  }

  // ------------------------------------------------------------- 5. the hitch shape

  let hitch = null
  if (WALK_MS > 0) {
    const installed = await page.evaluate(() => {
      const g = window.__grass
      const A = window.__gwwArm
      if (!g || !A || typeof A.orig !== 'function') return { ok: false, reason: 'the real tickWind was never captured' }
      const R = window.__gwwTick = { n: 0, times: [], frames: [], pos: [], max: 0 }
      g.tickWind = function (dt) {
        const t0 = performance.now()
        const r = A.orig.call(this, dt)
        const d = performance.now() - t0
        R.n++
        if (R.times.length < 40000) { R.times.push(d); R.frames.push(window.__gww.curFrame) }
        if (d > R.max) R.max = d
        const App = window.__app
        if (R.pos.length < 40000) {
          const cam = (App && App.camera) ? [App.camera.position.x, App.camera.position.z] : null
          let ls = null
          try { const s = App && App.client && App.client.getLocalState ? App.client.getLocalState() : null; if (s && s.position) ls = [s.position[0], s.position[2]] } catch (_) {}
          let pl = null
          try { const p = App && App.player; if (p && p.position) pl = [p.position.x !== undefined ? p.position.x : p.position[0], p.position.z !== undefined ? p.position.z : p.position[2]] } catch (_) {}
          R.pos.push([cam ? cam[0] : null, cam ? cam[1] : null, ls ? ls[0] : null, ls ? ls[1] : null, pl ? pl[0] : null, pl ? pl[1] : null])
        }
        return r
      }
      window.__gww.uploads.length = 0
      window.__gww.frameWork.length = 0
      window.__gww.draws = 0
      window.__gww.frames = 0
      window.__gww.frameWall.length = 0
      window.__gww._lastTs = 0
      return { ok: true }
    }).catch((e) => ({ ok: false, reason: e.message }))
    log('re-centre instrument: ' + JSON.stringify(installed))

    const waypoints = ROUTE.split(';').map((p) => { const [x, z] = p.split(',').map(Number); return { x, z } })
    const started = await page.evaluate((wpts, speed) => {
      const route = window.__spoint && window.__spoint.route
      if (typeof route !== 'function') return { ok: false, reason: 'window.__spoint.route is not a function' }
      route(wpts, { mode: 'walk', speed })
      return { ok: true }
    }, waypoints, WALK_SPEED).catch((e) => ({ ok: false, reason: e.message }))
    log('walk ' + JSON.stringify(waypoints) + ' -> ' + JSON.stringify(started))

    if (started.ok) {
      await new Promise((r) => setTimeout(r, WALK_MS))
      contentionMark(watch)
      const r = await page.evaluate(() => {
        const R = window.__gwwTick
        const P = window.__gww
        const times = R.times.slice()
        const sorted = [...times].sort((a, b) => a - b)
        const med = sorted.length ? sorted[Math.floor(sorted.length * 0.5)] : 0
        // a re-centre rebuilds all 64x64 cells, a band rebuilds 8 rows: it is a step change, so
        // classify by a multiple of the median rather than by a fixed ms threshold
        const recentreIdx = []
        for (let i = 0; i < times.length; i++) if (times[i] > Math.max(med * 3, med + 0.3)) recentreIdx.push(i)
        const work = P.frameWork.slice()
        const recentreFrameWork = recentreIdx.map((i) => work[R.frames[i]]).filter((v) => Number.isFinite(v))
        const otherFrameWork = []
        const mark = new Set(recentreIdx.map((i) => R.frames[i]))
        for (let i = 0; i < times.length; i++) if (!mark.has(R.frames[i]) && Number.isFinite(work[R.frames[i]])) otherFrameWork.push(work[R.frames[i]])
        // The camera is useless as an odometer: FloatingOrigin sets camera.position to 0 on every
        // rebase, so its per-frame deltas are mostly the rebase, not the travel. Three sources are
        // sampled and the largest is the travel, with the source named so the number has a reason.
        const distFor = (ia, ib) => {
          let d = 0, n = 0, px = null, pz = null, first = null, last = null
          for (let i = 0; i < R.pos.length; i++) {
            const x = R.pos[i][ia], z = R.pos[i][ib]
            if (!Number.isFinite(x) || !Number.isFinite(z)) continue
            if (first === null) first = [+x.toFixed(1), +z.toFixed(1)]
            last = [+x.toFixed(1), +z.toFixed(1)]
            if (px !== null) { const s = Math.hypot(x - px, z - pz); if (s < 5) { d += s; n++ } }
            px = x; pz = z
          }
          return { m: +d.toFixed(1), samples: n, first, last }
        }
        const names = ['app.camera', 'client.getLocalState', 'app.player']
        const bySource = [distFor(0, 1), distFor(2, 3), distFor(4, 5)]
        let dist = 0, distSource = null
        for (let i = 0; i < bySource.length; i++) if (bySource[i].m > dist) { dist = bySource[i].m; distSource = names[i] }
        const wall = P.frameWall.slice()
        return {
          calls: R.n,
          recentres: recentreIdx.length,
          medianMs: med,
          maxMs: times.length ? Math.max(...times) : null,
          p95Ms: sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : null,
          recentreMaxMs: recentreIdx.length ? Math.max(...recentreIdx.map((i) => times[i])) : null,
          recentreMeanMs: recentreIdx.length ? recentreIdx.reduce((s, i) => s + times[i], 0) / recentreIdx.length : null,
          bandMeanMs: (() => { const o = []; for (let i = 0; i < times.length; i++) if (!recentreIdx.includes(i)) o.push(times[i]); return o.length ? o.reduce((s, v) => s + v, 0) / o.length : null })(),
          travelledM: +dist.toFixed(1),
          travelledSource: distSource,
          travelledBySource: bySource.map((s, i) => ({ source: names[i], m: s.m, samples: s.samples, first: s.first, last: s.last })),
          metresPerRecentre: recentreIdx.length ? +(dist / recentreIdx.length).toFixed(1) : null,
          recentreFrameWorkMax: recentreFrameWork.length ? Math.max(...recentreFrameWork) : null,
          otherFrameWorkMax: otherFrameWork.length ? Math.max(...otherFrameWork) : null,
          otherFrameWorkP95: otherFrameWork.length ? (() => { const s = [...otherFrameWork].sort((a, b) => a - b); return s[Math.floor(s.length * 0.95)] })() : null,
          frameWorkMax: work.length ? Math.max(...work) : null,
          frameWallMax: wall.length ? Math.max(...wall) : null,
          frames: P.frames,
          uploads: P.uploads.length,
        }
      })
      hitch = r
      log('re-centre: ' + JSON.stringify(r))
      const SMALLEST_VISIBLE_HITCH_MS = 34
      const worst = Math.max(r.recentreMaxMs || 0, r.recentreFrameWorkMax || 0)
      log(`hitch shape: worst re-centre block ${f3(r.recentreMaxMs)}ms, worst main-thread frame containing one ${f3(r.recentreFrameWorkMax)}ms, a frame without one ${f3(r.otherFrameWorkP95)}ms p95 / ${f3(r.otherFrameWorkMax)}ms max, against the ${SMALLEST_VISIBLE_HITCH_MS}ms smallest visible hitch`)
      hitch.worstMs = +worst.toFixed(3)
      hitch.underVisibleHitch = worst < SMALLEST_VISIBLE_HITCH_MS
      hitch.landsInsideAFrame = (r.recentreFrameWorkMax === null) || (r.recentreFrameWorkMax < SMALLEST_VISIBLE_HITCH_MS)
      hitch.smallestVisibleHitchMs = SMALLEST_VISIBLE_HITCH_MS
    } else {
      log('the walk phase could not start, so the re-centre cadence is unmeasured: ' + JSON.stringify(started))
      hitch = { ok: false, reason: started.reason }
    }
    await page.evaluate(() => {
      const g = window.__grass
      const A = window.__gwwArm
      if (g && A && typeof A.orig === 'function') g.tickWind = A.orig
      return true
    }).catch(() => {})
  }

  const contention = contentionVerdict(watch)
  log(formatContention(contention))

  // ------------------------------------------------------------- verdicts

  const finalUnits = await readCounters(page)
  const grassModuleOk = compile.grassModules.length > 0
  const compiled = grassModuleOk && compile.grassModules.every((m) => m.compilationChecked === true && m.compilationErrors === 0)
  const vertexLevelOk = grassModuleOk && compile.grassModules.some((m) => m.vertexSampleLevel > 0 && m.vertexSampleNoLevel === 0)

  check('the instrument ran on a page that has WebGPU', compile.installed === true && compile.hasWebGPU === true,
    `installed=${compile.installed} hasWebGPU=${compile.hasWebGPU} devices=${compile.devices}`)
  check('the renderer is WebGPURenderer on the webgpu backend', rclass === 'WebGPURenderer' && backend === 'webgpu',
    `class=${rclass} backend=${backend} gpu=${gpu.renderer}`)
  check('the grass WGSL was found and compiled', compiled,
    `${compile.grassModules.length} grass module(s) of ${compile.modules}, ${compile.grassModules.map((m) => `errors=${m.compilationErrors} checked=${m.compilationChecked}`).join(' ')}`)
  check('no pipeline failed validation', compile.pipelineErrorCount === 0 && compile.pipelines > 0,
    `${compile.pipelineErrorCount} error(s) over ${compile.pipelines} pipeline(s)`)
  check('the async error channel was read and is empty', compile.uncapturedCount === 0,
    `${compile.uncapturedCount} uncaptured error(s)`)
  check('the gust is sampled with an explicit level in the vertex stage', vertexLevelOk,
    compile.grassModules.map((m) => `textureSampleLevel=${m.vertexSampleLevel} textureSample(no level)=${m.vertexSampleNoLevel}`).join(' '))
  check('grass draws on the WebGPU path', grassDrawsPerFrame !== null && grassDrawsPerFrame > 0,
    `${wShown.drawsPerFrame} draw(s)/frame with grass shown, ${wHidden.drawsPerFrame} with it hidden, so ${grassDrawsPerFrame} are grass`)
  check('grass instances are non-zero', (finalUnits.live || 0) > 0,
    `live=${finalUnits.live} near=${finalUnits.near} mid=${finalUnits.mid} (the two instanced meshes the grass module owns)`)
  const onArms = wins.filter((w) => w.on)
  check('the field is uploaded to the GPU every frame', onArms.length > 0 && Math.min(...onArms.map((w) => w.uploadsPerFrame || 0)) >= 0.9,
    `${onArms.map((w) => w.uploadsPerFrame).join(', ')} upload(s)/frame of ${FIELD_BYTES} B on the ON arm(s)`)
  check('the wind animates on the WebGPU path', onArms.length > 0 && onArms.every((w) => w.distinctFieldHashes > 1),
    `${onArms.map((w) => w.distinctFieldHashes).join(', ')} distinct field payload(s) on the ON arm(s)`)
  check('the positive control moved the draw instrument', grassDrawsPerFrame !== null && grassDrawsPerFrame > 0,
    `hiding grass dropped the API-boundary draw count by ${grassDrawsPerFrame}`)
  if (hitch && hitch.ok !== false) {
    check('the lattice re-centre is not a visible hitch', hitch.underVisibleHitch === true,
      `worst re-centre block ${f3(hitch.recentreMaxMs)}ms over ${hitch.recentres} re-centre(s) in ${hitch.travelledM}m (${hitch.metresPerRecentre}m each), worst frame containing one ${f3(hitch.recentreFrameWorkMax)}ms, against ${hitch.smallestVisibleHitchMs}ms`)
  } else {
    check('the lattice re-centre cadence was measured', false,
      `the walk never ran, so the re-centre is unmeasured: ${JSON.stringify(hitch)}`)
  }
  const fieldCpu = (hitch && hitch.ok !== false && hitch.calls)
    ? `0.000->${f3(hitch.bandMeanMs)}/${f3(hitch.p95Ms)}/${f3(hitch.recentreMaxMs)}`
    : 'not-measured'
  check('the field refresh is timed per call on this backend', !!(hitch && hitch.ok !== false && hitch.calls > 0),
    `${hitch ? hitch.calls : 0} timed field update(s)`)
  check('no page errors', errors.length === 0, `errors=${errors.slice(0, 3).join(' | ')}`)
  if (errors.length) log('page error detail: ' + errors.slice(0, 2).join('\n---\n'))

  const abTag = ab ? `${ab.verdict} cpu ${ab.offMean}->${ab.onMean}ms/frame naive=${ab.shareNaiveMs} drift=${ab.driftPerWindow}/window effect=${ab.effectMs} pairSpread=${ab.noiseMs} armTook=${ab.armTook}` : 'NOT-RUN'
  console.log(`RESULT: ${failed === 0 ? 'PASS' : 'FAIL'} label=${LABEL} runId=${RUN_ID} backend=${backend} class=${rclass} gpu=${gpu.renderer} grassModules=${compile.grassModules.length} compiled=${compiled} validationErrors=${compile.pipelineErrorCount} uncaptured=${compile.uncapturedCount} vertexSampleLevel=${vertexLevelOk} drawsPerFrame=${wShown.drawsPerFrame} grassDrawsPerFrame=${grassDrawsPerFrame} instances=${finalUnits.live} animates=${onArms.map((w) => w.distinctFieldHashes).join('/')} fieldCpuMsPerFrame=${fieldCpu} ab=${abTag} wall ${ab ? `${ab.offWall}->${ab.onWall}` : 'null'} ms/frame wallEffect=${ab ? ab.wallEffectMs : 'null'} recentre=${hitch && hitch.ok !== false ? `${hitch.recentres} in ${hitch.travelledM}m worst ${f3(hitch.recentreMaxMs)}ms` : 'not-run'} contention=${contention.contested ? 'CONTESTED' : 'clean'} x${contention.slowdown}`)
} finally {
  if (browser) await browser.close().catch((e) => log('browser.close failed, so the lease may need sweeping: ' + e.message))
  if (server && typeof server.stop === 'function') { try { await server.stop() } catch (e) { log('server.stop failed: ' + e.message) } }
}
process.exit(failed === 0 ? 0 : 1)
