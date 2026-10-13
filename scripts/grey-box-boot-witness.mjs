#!/usr/bin/env node
// Grey-box boot witness. Boots the shipped client HEADFUL on a real adapter and
// measures whether the window contains a rendered frame at all:
//
//   node scripts/gpulock.mjs run greybox -- \
//     node scripts/grey-box-boot-witness.mjs --gpu=amd [--settle=8000] [--url=<url>]
//
// The three claims this witness is allowed to make, and the counted units it
// makes them from:
//   * GREY -- per band (sky/far, mid, near), the fraction of pixels carrying
//     chroma, the luminance standard deviation and the count of distinct
//     quantised colours. A uniform window reads chroma fraction ~0, sd ~0 and
//     one distinct colour.
//   * UNDRAWN -- how many render objects were skipped because three's
//     Pipelines.isReady() was still false, read from the async pipeline sink's
//     own counters plus the renderer's draw calls for the frame.
//   * SETTLED -- whether the async pipeline sink drains to zero pending, which
//     is the assertion the async-pipeline lane wrote and never ran.
//
// No per-pass GPU timing is cited anywhere in this witness.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from './lib/cdp-browser.mjs'
import { vendorLaunchArgs } from './lib/witness-gpu.mjs'
import { probeGpu, rasterizerClass } from './lib/gpu-probe.mjs'
import { assertServedClientRoot, clientRootTag, rebuildClientBundle, CLIENT_ROOT_BUNDLE } from './lib/served-client-root.mjs'
import { ensureStandaloneServer, stopWitnessServers } from './lib/witness-server.mjs'

const LABEL = 'grey-box-boot-witness'
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const flag = (name, dflt = null) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const has = (name) => process.argv.includes(`--${name}`)

const PORT = Number(flag('port', '3187'))
const GPU_MODE = flag('gpu', 'amd')
const SETTLE_MS = Number(flag('settle', '8000'))
const DRAIN_MS = Number(flag('drain', '4000'))
const [VIEW_W, VIEW_H] = String(flag('viewport', '1280x720')).split('x').map(Number)
const WORLD = flag('world', null)
const OUT = resolve(flag('out', join(REPO_ROOT, '.gm', 'witness-out', 'grey-box')))
const URL_OVERRIDE = flag('url', null)
const EXPLORE = has('explore')
// In the shared work tree dist/client/app.js is stale nearly all the time -- a sibling lane
// edits a client source and the server's freshness check then falls through to raw ESM, so
// "the browser window" a tester opens is served a DIFFERENT client root than the one a
// witness that rebuilt first sees, and the two are not comparable. --root=any measures
// whichever root the server actually serves and records it; --root=bundle refuses anything
// else, so a raw-ESM boot can never be reported as the bundled client. The default is `any`:
// a stale bundle must not turn into a refused arm, and the served entry sha is recorded and
// compared across arms, so a run whose arms did not all see the SAME bytes says so.
const WANT_ROOT = flag('root', 'any') === 'any' ? null : flag('root', 'any')
// Each arm is a page of its own, so the init script (and therefore the mutation) is per arm
// and two arms can disagree while being served the SAME bytes. That is what separates "the
// device rejected the pipeline" from "the client left the object undrawn", and it is also what
// makes this a bisect without a checkout: every arm below is the one bundle plus an in-page
// mutation, so a difference between two arms is that mutation and nothing else.
//
//   shipped          -- the bytes as they stand; async pipelines with the bounded escort.
//   commit-norescue  -- the same bytes with the escort switched off, which is byte-for-byte the
//                       behaviour of commit 0a5602cb (render: create WebGPU render pipelines off
//                       the draw path). An object whose async creation never yields a pipeline is
//                       then never drawn.
//   pre-commit       -- the same bytes with createRenderPipelineAsync answered by
//                       createRenderPipeline, which is what the draw path did BEFORE that commit:
//                       synchronous, always yields a pipeline, cannot strand an object.
//   reject-escort    -- every async creation forced to reject, escort on. Deterministic stranding
//                       against the fix.
//   reject-norescue  -- every async creation forced to reject, escort off. Deterministic stranding
//                       as the shipped commit would behave. The expected GREY arm.
//
// Same bundle sha or the pair proves nothing.
const ARM_SPECS = String(flag('arms', 'shipped')).split(',').map(s => s.trim()).filter(Boolean)
const armOf = (spec) => {
  const preCommit = spec === 'pre-commit'
  const name = preCommit ? 'sync' : spec
  const mutation = name === 'sync' ? 'sync' : (name === 'reject' || name === 'reject-escort' || name === 'reject-norescue' ? 'reject' : '')
  const noRescue = /norescue\b/.test(spec)
  return { spec, mutation, noRescue, preCommit }
}

const LF = String.fromCharCode(10)
const lines = []
const say = (s) => { lines.push(s); console.log(s) }

// --- the in-page probe -------------------------------------------------------
// The canvas is read back through a 2D canvas, so the numbers are the pixels the
// compositor actually has, not a re-render. Chroma is max(r,g,b)-min(r,g,b): a
// grey or flat-filled window has none. Bands are screen rows, top to bottom.
// The canvas readback is NOT the window. Measured 2026-10-12 on this harness: drawing the
// WebGPU canvas into a 2D canvas and reading it back yields every pixel (0,0,0) -- 921600
// pixels, sdLum 0, one distinct colour -- from a page whose composited screenshot in the
// same millisecond measures meanLum 149.92, sdLum 51.2, chromaFrac 0.947 and 3273 distinct
// colours. A witness that reads the canvas that way reports an empty window for a page that
// is drawing 23-75 draws and 404467 triangles a frame, so the canvas numbers are kept below
// as `canvasReadback` and are never the basis of a grey verdict. The verdict comes from the
// CDP screenshot, decoded with sharp when it is installed.
const BAND_CHROMA_MIN = 12

function classifyPixels(data, channels, W, H) {
  const edges = [0, Math.floor(H / 3), Math.floor(2 * H / 3), H]
  const names = ['far', 'mid', 'near']
  const stat = (y0, y1, name) => {
    let n = 0, sL = 0, sL2 = 0, chroma = 0
    const colours = new Set()
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * channels
        const r = data[i], g = data[i + 1], b = data[i + 2]
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
        const L = 0.2126 * r + 0.7152 * g + 0.0722 * b
        n++; sL += L; sL2 += L * L
        if (mx - mn > BAND_CHROMA_MIN) chroma++
        if (colours.size < 4096) colours.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3))
      }
    }
    const mean = n ? sL / n : 0
    const sd = n ? Math.sqrt(Math.max(0, sL2 / n - mean * mean)) : 0
    return { name, pixels: n, meanLum: Number(mean.toFixed(3)), sdLum: Number(sd.toFixed(3)), chromaFrac: n ? Number((chroma / n).toFixed(6)) : 0, distinctColours: colours.size }
  }
  return {
    all: stat(0, H, 'all'),
    bands: names.map((nm, i) => stat(edges[i], edges[i + 1], nm)),
  }
}

let _sharp = null
async function sharpOrNull() {
  if (_sharp !== null) return _sharp
  try { _sharp = (await import('sharp')).default } catch (_) { _sharp = false }
  return _sharp
}

// Decoding in this process is what makes the screenshot a measurement instead of an
// artefact: no eye ever sees it, so the numbers have to come from the bytes.
async function classifyScreenshot(pngPath) {
  const sharp = await sharpOrNull()
  if (!sharp) return { decoded: false, reason: 'sharp is not installed (optionalDependency), so the PNG is a capture only and no pixel verdict was computed from it' }
  const { data, info } = await sharp(pngPath).raw().toBuffer({ resolveWithObject: true })
  const out = classifyPixels(data, info.channels, info.width, info.height)
  return { decoded: true, width: info.width, height: info.height, channels: info.channels, ...out }
}

const PIXEL_PROBE = `(() => {
  const canvases = Array.from(document.querySelectorAll('canvas'))
  const c = canvases.slice().sort((a, b) => (b.width * b.height) - (a.width * a.height))[0]
  if (!c) return { __error: 'no canvas in the document' }
  const w = c.width, h = c.height
  const off = document.createElement('canvas')
  off.width = w; off.height = h
  const ctx = off.getContext('2d', { willReadFrequently: true })
  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(c, 0, 0)
  const d = ctx.getImageData(0, 0, w, h).data
  const bands = [
    { name: 'far', y0: 0, y1: Math.floor(h / 3) },
    { name: 'mid', y0: Math.floor(h / 3), y1: Math.floor(2 * h / 3) },
    { name: 'near', y0: Math.floor(2 * h / 3), y1: h },
  ]
  const CHROMA_MIN = 12
  const acc = bands.map(b => ({ ...b, n: 0, sumL: 0, sumL2: 0, chroma: 0, colours: new Set() }))
  const all = { n: 0, sumL: 0, sumL2: 0, chroma: 0, colours: new Set() }
  for (let y = 0; y < h; y++) {
    const bi = y < bands[0].y1 ? 0 : (y < bands[1].y1 ? 1 : 2)
    const a = acc[bi]
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const r = d[i], g = d[i + 1], bl = d[i + 2]
      const mx = r > g ? (r > bl ? r : bl) : (g > bl ? g : bl)
      const mn = r < g ? (r < bl ? r : bl) : (g < bl ? g : bl)
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * bl
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (bl >> 3)
      for (const t of [a, all]) {
        t.n++; t.sumL += L; t.sumL2 += L * L
        if (mx - mn > CHROMA_MIN) t.chroma++
        if (t.colours.size < 4096) t.colours.add(key)
      }
    }
  }
  const finish = (t) => {
    const mean = t.n ? t.sumL / t.n : 0
    const sd = t.n ? Math.sqrt(Math.max(0, t.sumL2 / t.n - mean * mean)) : 0
    return {
      name: t.name || 'all',
      pixels: t.n,
      meanLum: Number(mean.toFixed(3)),
      sdLum: Number(sd.toFixed(3)),
      chromaFrac: t.n ? Number((t.chroma / t.n).toFixed(6)) : 0,
      distinctColours: t.colours.size,
    }
  }
  return {
    canvas: { w, h, count: canvases.length },
    all: finish(all),
    bands: acc.map(finish),
  }
})()`

// --- init script: instrument the WebGPU device before any page script --------
// Wrapping createRenderPipelineAsync where three calls it is what separates the two
// claims this witness has to tell apart: an async pipeline that never settles leaves
// three's Pipelines.isReady() false forever, and Renderer._renderObjectDirect then
// never draws that object at all. --mutation=sync-pipelines answers the same call
// with device.createRenderPipeline, so the compile is back on the draw path and the
// object cannot be left undrawn: that is the mutation arm, run against the SAME
// served bytes, so a difference between arms is the async path and nothing else.
const INIT_SCRIPT = `
(() => {
  const W = window
  // The reproduction switch in client/core/ProgramReadiness.js is read per rescue, so setting it
  // here at document start is the whole of the norescue arm: same bytes, escort off.
  W.__spointAsyncPipelineEscort = !NO_RESCUE
  W.__gpuPipe = { requested: 0, resolved: 0, rejected: 0, pending: 0, mutation: MUTATION_TOKEN }
  W.__gpuErrors = []
  // A uniform window has two very different causes and this witness must tell them apart: no frame
  // was ever submitted (client/app.js animate() returns early while window.__warmupInFlight, so the
  // canvas keeps its clear colour), or frames were submitted and objects were skipped. The page's
  // own console is the only place the first kind says anything -- "[terrain] planet init failed"
  // among them -- and there is no console event on this CDP wrapper, so capture it in page.
  const msgs = []
  W.__consoleMsgs = msgs
  for (const k of ['error', 'warn']) {
    const orig = console[k]
    console[k] = function () {
      try {
        if (msgs.length < 4000) {
          msgs.push(k + ': ' + Array.prototype.map.call(arguments, a => {
            try { return typeof a === 'string' ? a : ((a && a.message) || String(a)) } catch (_) { return '?' }
          }).join(' ').slice(0, 300))
        }
      } catch (_) {}
      return orig.apply(console, arguments)
    }
  }
  const P = typeof GPUDevice !== 'undefined' ? GPUDevice.prototype : null
  if (!P) { W.__gpuPipe.unavailable = 'GPUDevice is not defined at document start'; return }
  const sync = P.createRenderPipeline
  const asyncCreate = P.createRenderPipelineAsync
  if (MUTATION_TOKEN === 'reject') {
    // Deterministic form of the failure the async path makes permanent: three assigns
    // pipelineData.pipeline only from the awaited async promise, so a rejected async
    // creation leaves it undefined, Pipelines.isReady() stays false and
    // Renderer._renderObjectDirect never draws that object again. Every pipeline in the
    // scene is created through this call now, so a rejecting device is a blank window.
    P.createRenderPipelineAsync = function () {
      const st = W.__gpuPipe
      st.requested++
      return Promise.reject(new Error('grey-box witness: forced createRenderPipelineAsync rejection'))
    }
  } else if (MUTATION_TOKEN === 'sync') {
    // The draw path before "render: create WebGPU render pipelines off the draw path":
    // three hands getForRender() a null promises array there, and WebGPUPipelineUtils
    // answers a null array with device.createRenderPipeline, which always returns a
    // pipeline object. That is why the pre-commit arm cannot strand an object, and it is
    // the arm the commit has to beat.
    P.createRenderPipelineAsync = function (desc) {
      const st = W.__gpuPipe
      st.requested++
      try { st.resolved++; return Promise.resolve(sync.call(this, desc)) } catch (e) { st.rejected++; return Promise.reject(e) }
    }
  } else {
    P.createRenderPipelineAsync = function (desc) {
      const st = W.__gpuPipe
      st.requested++
      st.pending++
      let p
      try { p = asyncCreate.call(this, desc) } catch (e) { p = Promise.reject(e) }
      Promise.resolve(p).then(
        () => { st.resolved++; st.pending-- },
        () => { st.rejected++; st.pending-- },
      )
      return p
    }
  }
  const pop = P.popErrorScope
  if (typeof pop === 'function') {
    P.popErrorScope = function () {
      const p = pop.call(this)
      Promise.resolve(p).then(e => { if (e) W.__gpuErrors.push(String((e && e.message) || e)) }, () => {})
      return p
    }
  }
})()
`

const STATE_PROBE = `(() => {
  const w = window
  const globals = Object.keys(w).filter(k => k.startsWith('__'))
  const ri = w.__rendererInfo || null
  const ap = w.__asyncRenderPipelines || null
  const gp = w.__gpuPipe || null
  const r = w.__app && w.__app.renderer ? w.__app.renderer : (w.__spointRenderer || null)
  let draws = null, triangles = null, caches = null, backendName = null, webgpu = null
  if (r) {
    if (r.info && r.info.render) { draws = r.info.render.drawCalls; triangles = r.info.render.triangles }
    if (r._pipelines && r._pipelines.caches) caches = r._pipelines.caches.size
    if (r.backend) {
      webgpu = r.backend.isWebGPUBackend === true
      backendName = r.backend.isWebGPUBackend ? 'webgpu' : (r.backend.isWebGLBackend ? 'webgl' : 'unknown')
    }
  }
  return {
    globals,
    rendererInfo: ri,
    asyncRenderPipelines: ap,
    gpuPipe: gp,
    gpuErrors: (w.__gpuErrors || []).slice(0, 12),
    gpuErrorCount: (w.__gpuErrors || []).length,
    draws, triangles, pipelineCaches: caches,
    backend: backendName, isWebGPU: webgpu,
    frameGraph: !!w.__frameGraph, renderGraph: !!w.__renderGraph,
    terrain: !!(w.__terrain && w.__terrain.frame),
    app: !!w.__app,
    // The no-frame cause: animate() returns early while this is set, so zero frames reach the
    // canvas and the window keeps its clear colour -- uniform, and not a pipeline at all.
    warmupInFlight: w.__warmupInFlight === true,
    revealed: !!(w.__app && w.__app.revealedAt != null),
  }
})()`

// Counts real draws and frame walls over N animation frames, so "draws per
// frame" is a counted work unit and not a single instantaneous read.
const FRAME_PROBE = `(async (n) => {
  const w = window
  const r = w.__app && w.__app.renderer ? w.__app.renderer : (w.__spointRenderer || null)
  const samples = []
  let last = performance.now()
  for (let i = 0; i < n; i++) {
    await new Promise(res => requestAnimationFrame(res))
    const now = performance.now()
    samples.push({
      wallMs: Number((now - last).toFixed(3)),
      drawCalls: r && r.info && r.info.render ? r.info.render.drawCalls : null,
      pending: w.__asyncRenderPipelines ? w.__asyncRenderPipelines.pending : null,
    })
    last = now
  }
  const walls = samples.map(s => s.wallMs).sort((a, b) => a - b)
  const draws = samples.map(s => s.drawCalls).filter(v => v != null)
  return {
    frames: samples.length,
    wallP50: walls.length ? walls[Math.floor(walls.length * 0.5)] : null,
    wallMax: walls.length ? walls[walls.length - 1] : null,
    drawsPerFrame: draws.length ? {
      min: Math.min(...draws),
      max: Math.max(...draws),
      mean: Number((draws.reduce((a, b) => a + b, 0) / draws.length).toFixed(2)),
    } : null,
    pendingSamples: samples.map(s => s.pending),
    samples: samples.slice(0, 8),
  }
})(30)`

async function main() {
  mkdirSync(OUT, { recursive: true })
  // --rebuild-bundle makes the arm's bytes a function of this checkout at this moment, so
  // two arms that disagree differ by the code and not by whatever a sibling lane wrote
  // into dist/ between them. The served sha is recorded, so two arms are comparable only
  // when they report the same one.
  if (has('rebuild-bundle')) { say(`[${LABEL}] --rebuild-bundle: running scripts/bundle-client.mjs before boot`); rebuildClientBundle() }
  const served = await ensureStandaloneServer({ port: PORT, label: `${LABEL} node server.js :${PORT}` })
  if (!served.up) throw new Error(`server not up on :${PORT}`)
  say(`[${LABEL}] server :${PORT} up=${served.up} owned=${served.owned}`)

  const launchArgs = [...vendorLaunchArgs(GPU_MODE), `--window-size=${VIEW_W},${VIEW_H + 90}`]
  say(`[${LABEL}] launch args: ${launchArgs.join(' ')}`)
  const browser = await chromium.launch({ owner: `${LABEL}-browser`, args: launchArgs })
  const arms = ARM_SPECS.map(armOf)
  const report = { label: LABEL, arms: arms.map(a => a.spec), gpu: null, clientRoot: null, results: [] }
  const baseUrl = `http://localhost:${PORT}/?${[WORLD ? `world=${WORLD}` : null, 'singleplayer'].filter(Boolean).join('&')}`
  try {
    for (const arm of arms) {
      await runArm(browser, report, arm, `${baseUrl}&nc=${Date.now()}-${arm.spec}`)
    }
  } finally {
    await browser.close()
  }
  // This witness measured 2026-10-12 as hanging after its last line: it wrote its JSON and
  // then never exited, so the gpulock parent kept heartbeating a lock it had finished with
  // and every other lane on the box queued behind a finished arm. The CDP socket and the
  // spawned server outlive main(), so the end of main() is not an exit.
  const undecoded = report.results.filter(a => a.verdict === 'UNDECODED').length
  await stopWitnessServers().catch(() => {})
  const bad = undecoded > 0 || report.confounded === true
  report.exitCode = bad ? 1 : 0
  writeFileSync(join(OUT, 'grey-box.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(OUT, 'grey-box.txt'), lines.join(LF) + LF)
  say(`[${LABEL}] arms=${report.results.length} undecoded=${undecoded} confounded=${report.confounded === true} -- exiting ${report.exitCode}`)
  process.exit(report.exitCode)
}

async function runArm(browser, report, arm, url) {
  const armName = arm.spec
  const page = await browser.newPage({ viewport: { width: VIEW_W, height: VIEW_H } })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e).slice(0, 300)))
  await page._send('Page.addScriptToEvaluateOnNewDocument', {
    source: INIT_SCRIPT
      .replace(/MUTATION_TOKEN/g, JSON.stringify(arm.mutation))
      .replace(/NO_RESCUE/g, arm.noRescue ? 'true' : 'false'),
  })
  const tag = (s) => say(`[${LABEL}] [${armName}] ${s}`)
  tag(`url ${url}`)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })

  try {
    const root = await assertServedClientRoot(page, { want: WANT_ROOT, label: LABEL })
    report.clientRoot = clientRootTag(root)
    tag(`${report.clientRoot}`)
    // One bundle or the arms are not comparable. The first arm fixes the served entry sha and
    // every later arm is checked against it: a server restart, or a sibling lane rebuilding
    // dist/ mid-run, would otherwise make an arm-on-arm difference indistinguishable from an
    // untracked bytes change.
    if (report.servedEntrySha === undefined) report.servedEntrySha = root.sha256
    else if (report.servedEntrySha !== root.sha256) {
      report.confounded = true
      tag(`CONFOUNDED: this arm was served ${String(root.sha256).slice(0, 12)} but the first arm of this run was served ${String(report.servedEntrySha).slice(0, 12)} -- arm-on-arm differences in this run are not attributable to the mutation`)
    }

    const gpu = await probeGpu(page)
    gpu.rasterizer = rasterizerClass(gpu)
    report.gpu = gpu
    tag(`gpu renderer=${gpu.renderer} vendor=${gpu.vendor} rasterizer=${gpu.rasterizer}`)
    if (!gpu.renderer && !gpu.adapter) tag(`WARN: no renderer string exposed (haystack=${JSON.stringify(gpu.haystack)}) -- window.__rendererInfo is absent, so the adapter is UNPINNED`)

    // Wait for the app to have a world, then let it settle.
    const t0 = Date.now()
    let ready = false
    while (Date.now() - t0 < 120000) {
      const st = await page.evaluate(() => ({ terrain: !!(window.__terrain && window.__terrain.frame), app: !!window.__app }))
      if (st.terrain || st.app) { ready = true; break }
      await page.waitForTimeout(1000)
    }
    tag(`boot ready=${ready} after ${Date.now() - t0}ms`)
    await page.waitForTimeout(SETTLE_MS)

    const state = await page.evaluate(STATE_PROBE)
    tag(`state ${JSON.stringify(state)}`)
    const canvasReadback = await page.evaluate(PIXEL_PROBE)
    tag(`canvasReadback ${JSON.stringify(canvasReadback)}`)
    const frames = await page.evaluate(FRAME_PROBE)
    tag(`frames ${JSON.stringify(frames)}`)

    // The drain assertion the async-pipeline lane wrote and never ran: after
    // DRAIN_MS with no new scenery entering, pending must reach 0.
    await page.waitForTimeout(DRAIN_MS)
    const drained = await page.evaluate(`(() => {
      const a = window.__asyncRenderPipelines
      const g = window.__gpuPipe
      const r = window.__app && window.__app.renderer ? window.__app.renderer : (window.__spointRenderer || null)
      let readyObjects = null, totalObjects = null
      try {
        if (r && r._pipelines && r._pipelines.caches) {
          const pl = r._pipelines
          totalObjects = 0; readyObjects = 0
          for (const [k, v] of pl.caches) { totalObjects++; if (v && pl.backend && pl.backend.get(v).pipeline !== undefined) readyObjects++ }
        }
      } catch (_) {}
      return {
        sink: a ? { pending: a.pending, requested: a.requested, resolved: a.resolved, rejected: a.rejected, escorted: a.escorted, rescued: a.rescued, rescueFailed: a.rescueFailed, dropped: a.dropped } : null,
        gpu: g ? { pending: g.pending, requested: g.requested, resolved: g.resolved, rejected: g.rejected, mutation: g.mutation } : null,
        gpuErrorCount: (window.__gpuErrors || []).length,
        gpuErrors: (window.__gpuErrors || []).slice(0, 8),
        drawCalls: r && r.info && r.info.render ? r.info.render.drawCalls : null,
        triangles: r && r.info && r.info.render ? r.info.render.triangles : null,
        pipelineCaches: r && r._pipelines && r._pipelines.caches ? r._pipelines.caches.size : null,
        pipelinesReady: readyObjects, pipelinesTotal: totalObjects,
        escortSwitch: window.__spointAsyncPipelineEscort === undefined ? null : window.__spointAsyncPipelineEscort,
        warmupInFlight: window.__warmupInFlight === true,
        consoleMsgs: (window.__consoleMsgs || []).slice(-12),
        consoleMsgCount: (window.__consoleMsgs || []).length,
      }
    })()`)
    tag(`drain ${JSON.stringify(drained)}`)

    const shot = join(OUT, `grey-box-${armName}.png`)
    await page.screenshot({ path: shot })
    const pixels = await classifyScreenshot(shot)
    tag(`screenshot ${JSON.stringify(pixels)}`)
    tag(`wrote ${shot}`)

    // A grey box is one colour and no chroma. Both numbers come from the decoded PNG,
    // never from the canvas readback. The per-band chroma count is the "non-grey pixels
    // per band" number: a window that renders sky but no terrain is not one verdict.
    //
    // UNDRAWN is the counted-work-unit verdict and it outranks both: `renderer.info.render
    // .drawCalls` is the number of draws the renderer submitted, so 0 means the scene was not
    // drawn at all. Measured 2026-10-13: an arm whose every async pipeline was forced to reject
    // read 0 draw calls and 0 triangles while its decoded screenshot still carried a sky gradient
    // and a dark near band -- 26348 chroma pixels in the far band, 0 in the mid band, 40 distinct
    // colours in the mid band -- which a whole-window chroma fraction reports as "renders". A
    // window is not rendered because its clear colour has a gradient in it.
    const drawCalls = drained && typeof drained.drawCalls === 'number' ? drained.drawCalls : null
    const verdict = pixels.decoded === false
      ? 'UNDECODED'
      : drawCalls === 0
        ? 'UNDRAWN'
        : (pixels.all.distinctColours <= 1 || (pixels.all.sdLum < 1 && pixels.all.chromaFrac < 0.001))
          ? 'GREY'
          : 'RENDERS'
    if (pixels.decoded) {
      for (const b of pixels.bands) tag(`band ${b.name} chromaPixels=${Math.round(b.chromaFrac * b.pixels)}/${b.pixels} sdLum=${b.sdLum} distinct=${b.distinctColours}`)
    }
    tag(`verdict=${verdict}`)
    report.results.push({ name: armName, mutation: arm.mutation, noRescue: arm.noRescue, url, ready, state, pixels, canvasReadback, frames, drained, verdict, shot, pageErrors })
  } finally {
    await page.close()
  }
}

main().catch(e => {
  console.error(`[${LABEL}] ${e && e.stack || e}`)
  process.exit(1)
})
