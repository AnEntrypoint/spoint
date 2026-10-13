#!/usr/bin/env node
// Witness: cold-load time-to-first-frame and the first frame's own cost, on one instrument.
//
// Two defects sat on this path and both made the first frame unmeasurable:
//
//   * client/workers/OffscreenRenderWorker.js gated the frame post on
//     `nowMs - lastStatsPost > FRAME_STATS_GATE_MS` with `lastStatsPost` reset to 0 at init. The
//     rAF timestamp a worker sees is relative to the WORKER's own time origin, so it starts at 0
//     and the gate reads false for the first 250ms of the loop: the first rendered frame was never
//     reported, getStats().frame stayed null for up to a second, and the reported frame numbers
//     started at whatever the count had reached a quarter second in.
//   * client/core/ProgramReadiness.js pendingProgramCount() read renderer.info.programs, which
//     three's common renderer never defines, so the boot shader warm wait resolved on its first
//     poll and its cost was invisible.
//
// One instrument measures both: a real server, one real browser on a pinned adapter
// (vendorPinArgs --use-adapter-luid, window.__rendererInfo asserted), two page loads.
//
//   ARM worker-cold-start -- a fresh module Worker on a quiet page of the same origin, so the
//     measurement is not shared with a booting world: init posted -> 'ready' -> the first reported
//     frame. This is the arm that proves the first frame is reported (frame counter 1) and carries
//     its own render cost.
//   ARM cold-load -- the real app boot. Time-to-first-frame is the rAF timestamp of the first
//     animation frame at or after window.__app.revealedAt (app.js stamps it as the loading screen
//     hides), so it is the first frame of the revealed world and not a loading-screen frame. The
//     frame's cost is the main-thread duration of that rAF callback, which is the instrument that
//     resolves level cost (a rAF-to-rAF wall is vsync-quantized and does not).
//
// rAF is unlocked (--disable-frame-rate-limit --disable-gpu-vsync) so neither figure carries the
// refresh divisor. No per-pass GPU figure is read anywhere: those are invalidated (s0).
import { chromium, DEFAULT_VIEWPORT } from './lib/cdp-browser.mjs'
import { writeFileSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertGpu } from './lib/gpu-probe.mjs'
import { vendorPinArgs } from './lib/witness-gpu.mjs'
import {
  assertServedClientRoot, clientRootTag, rebuildClientBundle, CLIENT_ROOT_RAW, CLIENT_ROOT_BUNDLE,
} from './lib/served-client-root.mjs'

const TAG = '[first-frame]'
const LABEL = 'first-frame-boot-witness'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function flag(name, dflt = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const has = (name) => process.argv.includes(`--${name}`)

const PORT = flag('port', '3138')
const WORLD = flag('world', 'tps-game')
const PARAMS = flag('params', 'singleplayer')
const GPU_VENDOR = flag('gpu', null)
const OBSERVE_MS = Number(flag('observe', '4000'))
const SETTLE_TIMEOUT_MS = Number(flag('timeout', '180000'))
const VACUOUS = !has('skip-vacuous-arm')
const BEFORE_WORKER_RAW = flag('before-worker', null)
const BEFORE_WORKER = BEFORE_WORKER_RAW ? (BEFORE_WORKER_RAW.startsWith('/') ? BEFORE_WORKER_RAW : '/' + BEFORE_WORKER_RAW) : null
const SHIPPED_WORKER_URL = '/workers/OffscreenRenderWorker.js'
const SHIPPED_WORKER_PATH = join(ROOT, 'client', 'workers', 'OffscreenRenderWorker.js')
const DERIVED_BEFORE_PATH = join(ROOT, 'client', 'workers', 'ff-before-clock.mjs')
// The guard the row added, verbatim: removing it from the shipped file is the whole difference
// between the arm that reports the first rendered frame and the arm that swallows it.
const FIRST_FRAME_GUARD = 'if (frameCount === 1 || nowMs - lastStatsPost > PROTOCOL.WORKER_CLOCK_MS.FRAME_STATS_GATE_MS) {'
const WITHOUT_FIRST_FRAME_GUARD = 'if (nowMs - lastStatsPost > PROTOCOL.WORKER_CLOCK_MS.FRAME_STATS_GATE_MS) {'
const UNLOCK_RAF = process.env.SPOINT_UNLOCK_RAF !== '0'
const UNLOCKED_RAF_ARGS = UNLOCK_RAF ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : []

const failures = []
const check = (label, ok, detail) => {
  if (ok) return true
  failures.push(detail || label)
  return false
}
const say = (line) => console.log(TAG + ' ' + line)
const round = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null)

// An init script is a discarded EXPRESSION unless it ends in `())`.
const rafRecorder = (vacuous) => `(() => {
  const W = window
  const rec = { raf: [], revealedAt: null, timeOrigin: performance.timeOrigin, installs: 0 }
  W.__firstFrameRecorder = rec
  rec.installs++
  const orig = W.requestAnimationFrame.bind(W)
  W.requestAnimationFrame = function (cb) {
    return orig(function (t) {
      if (rec.revealedAt === null && W.__app && typeof W.__app.revealedAt === 'number') rec.revealedAt = W.__app.revealedAt
      const t0 = performance.now()
      try {
        cb(t)
        rec.raf.push({ t: t, ms: performance.now() - t0, own: false })
      } finally {
        if (rec.raf.length > 60000) rec.raf.splice(0, rec.raf.length - 60000)
      }
    })
  }
  // A pump of our own. The world's loop is not the only thing that can stop asking for frames, and
  // a frame timestamp this instrument cannot observe is a first frame it cannot place: the pump
  // keeps one animation frame per frame alive for the whole boot, and is marked so it never counts
  // as the world's own work.
  const pump = function (t) {
    rec.raf.push({ t: t, ms: 0, own: true })
    orig(pump)
  }
  orig(pump)
  if (${vacuous ? 'true' : 'false'}) W.__spointProgramReadinessVacuous = true
  return true
})()`

const WORKER_COLD_START = (observeMs, workerPath) => `(async () => {
  const W = window
  const t0 = performance.now()
  const canvas = document.createElement('canvas')
  canvas.width = 320
  canvas.height = 180
  document.body.appendChild(canvas)
  let offscreen
  try {
    offscreen = canvas.transferControlToOffscreen()
  } catch (e) {
    return { error: 'transferControlToOffscreen threw: ' + (e && e.message ? e.message : String(e)) }
  }
  const url = new URL('${workerPath}', location.href).href
  let worker
  try {
    worker = new Worker(url, { type: 'module' })
  } catch (e) {
    return { error: 'new Worker threw: ' + (e && e.message ? e.message : String(e)) }
  }
  const arrivals = []
  let workerError = null
  worker.onerror = (e) => { workerError = { message: String((e && e.message) || 'worker onerror'), filename: String((e && e.filename) || ''), lineno: Number((e && e.lineno) || 0) } }
  worker.onmessageerror = () => { workerError = workerError || { message: 'messageerror: a posted value could not be structured-cloned', filename: '', lineno: 0 } }
  worker.onmessage = (e) => {
    const m = (e && e.data) || {}
    arrivals.push({
      at: performance.now() - t0,
      type: m.type,
      frame: m.frame === undefined ? null : m.frame,
      ms: m.ms === undefined ? null : m.ms,
      renderMs: m.renderMs === undefined ? null : m.renderMs,
      drawCalls: m.drawCalls === undefined ? null : m.drawCalls,
      triangles: m.triangles === undefined ? null : m.triangles,
      code: m.code || null,
      message: m.message || null,
    })
  }
  const initSentMs = performance.now() - t0
  worker.postMessage({ type: 'init', canvas: offscreen, width: 320, height: 180, dpr: 1 }, [offscreen])
  const deadline = ${observeMs}
  while (performance.now() - t0 < deadline) await new Promise((r) => setTimeout(r, 20))
  try { worker.postMessage({ type: 'stop' }) } catch (e) {}
  await new Promise((r) => setTimeout(r, 300))
  try { worker.terminate() } catch (e) {}
  return { initSentMs: initSentMs, elapsedMs: performance.now() - t0, arrivals: arrivals, workerError: workerError }
})()`

async function coldLoadArm(browser, base, vacuous) {
  const tag = vacuous ? 'cold-load-vacuous' : 'cold-load'
  const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT })
  await page._send('Page.addScriptToEvaluateOnNewDocument', { source: rafRecorder(vacuous) })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)))
  const url = `${base}/?${PARAMS}`
  say(`${tag}: navigating to ${url} (rAF ${UNLOCK_RAF ? 'unlocked' : 'vsync-locked'}) ...`)
  await page.goto(url, { waitUntil: 'domcontentloaded' })

  const t0 = Date.now()
  let ready = false
  while (Date.now() - t0 < SETTLE_TIMEOUT_MS) {
    ready = await page.evaluate(`!!(window.__app && window.__app.loadingMachine && window.__app.loadingMachine.isReady)`).catch(() => false)
    if (ready) break
    await new Promise((r) => setTimeout(r, 200))
  }
  const readyWallMs = Date.now() - t0
  if (!ready) throw new Error(`loadingMachine never reached isReady within ${SETTLE_TIMEOUT_MS}ms`)
  // The world's loop is not guaranteed to still be asking for frames the moment isReady lands, so
  // the arm waits for a frame at or after the reveal that carries the world's own work rather than
  // assuming one arrived inside a fixed nap.
  const settleStart = Date.now()
  while (Date.now() - settleStart < 12000) {
    const seen = await page.evaluate(`(() => { const rec = window.__firstFrameRecorder; const rev = window.__app && window.__app.revealedAt; if (!rec || typeof rev !== 'number') return false; return rec.raf.some((e) => !e.own && e.ms > 0 && e.t >= rev) })()`).catch(() => false)
    if (seen) break
    await page.waitForTimeout(400)
  }
  await page.waitForTimeout(1200)
  if (pageErrors.length) say(`${tag}: ${pageErrors.length} uncaught page error(s); first: ${pageErrors[0].slice(0, 240)}`)

  const gpu = await assertGpu(page, { requireAccelerated: !!GPU_VENDOR, expectVendor: GPU_VENDOR })
  // The bytes this arm measures must carry this row's source. The server serves either the prebuilt
  // bundle or raw ESM, and only raw ESM is the checkout's own files, so the arm is admitted on raw
  // ESM alone; if the bundle has been rebuilt under us it is rebuilt from THIS checkout and the page
  // is loaded again, so either way the measured bytes are this tree's.
  let servedRoot = await assertServedClientRoot(page, { want: CLIENT_ROOT_RAW, label: LABEL }).catch((e) => e)
  if (servedRoot instanceof Error) {
    say(`${tag}: ${servedRoot.message} -- rebuilding the bundle from this checkout and re-navigating`)
    rebuildClientBundle()
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    servedRoot = await assertServedClientRoot(page, { want: CLIENT_ROOT_BUNDLE, label: LABEL })
  }
  say(`${tag}: served ${clientRootTag(servedRoot)}`)
  const observed = await page.evaluate(`(() => {
    const W = window
    const rec = W.__firstFrameRecorder || { raf: [] }
    const revealed = W.__app && typeof W.__app.revealedAt === 'number' ? W.__app.revealedAt : null
    const raf = rec.raf || []
    const after = revealed === null ? [] : raf.filter((e) => e.t >= revealed)
    const byFrame = new Map()
    for (const e of after) {
      const cur = byFrame.get(e.t) || { t: e.t, ms: 0, ownMs: 0, calls: 0 }
      cur.calls++
      if (e.own) cur.ownMs += e.ms
      else cur.ms += e.ms
      byFrame.set(e.t, cur)
    }
    const frames = [...byFrame.values()].sort((a, b) => a.t - b.t)
    const first = frames.length ? frames[0] : null
    const firstWorking = frames.find((f) => f.ms > 0) || null
    const vegApi = W.__veg || W.__vegetation || null
    let veg = null
    if (vegApi) {
      const counts = []
      const meshes = vegApi._meshes
      try {
        const each = (m) => { if (m && typeof m.count === 'number') counts.push(m.count) }
        if (meshes && typeof meshes.forEach === 'function') meshes.forEach(each)
        else if (meshes && typeof meshes === 'object') for (const k of Object.keys(meshes)) each(meshes[k])
      } catch (e) { counts.length = 0 }
      veg = {
        totalInstances: typeof vegApi.totalInstances === 'number' ? vegApi.totalInstances : null,
        instancerCount: counts.length,
        instances: counts.slice(0, 40),
        instancesNonZero: counts.filter((n) => n > 0).length,
      }
    }
    return {
      rendererInfo: W.__rendererInfo || null,
      revealedAtMs: revealed,
      rafEntries: raf.length,
      raftFirstAtMs: raf.length ? raf[0].t : null,
      firstFrameAtMs: first ? first.t : null,
      firstFrameCostMs: first ? first.ms : null,
      firstWorkingFrameAtMs: firstWorking ? firstWorking.t : null,
      firstWorkingFrameCostMs: firstWorking ? firstWorking.ms : null,
      framesAfterReveal: frames.length,
      programReadinessWait: W.__programReadinessWait || null,
      asyncPipelines: W.__asyncRenderPipelines || null,
      deferredFirstUse: W.__deferredFirstUsePipelines || null,
      veg: veg,
      appKeys: W.__app ? Object.keys(W.__app).slice(0, 60) : null,
      marks: performance.getEntriesByType('mark').map((m) => ({ name: m.name, t: Math.round(m.startTime) })),
    }
  })()`).catch((e) => ({ error: 'evaluate failed: ' + e.message }))

  const ri = observed.rendererInfo || null
  say(`${tag}: adapter asserted ${JSON.stringify(ri ? (ri.renderer || ri.glRenderer || ri) : null)} rasterizer=${gpu.rasterizer} haystack=${JSON.stringify(gpu.haystack || null)}`)
  say(`${tag}: loadingMachine.isReady after ${readyWallMs}ms (wall); revealedAt=${JSON.stringify(observed.revealedAtMs)} rafEntries=${observed.rafEntries} framesAfterReveal=${observed.framesAfterReveal}`)
  say(`${tag}: warm wait ${JSON.stringify(observed.programReadinessWait)}`)
  say(`${tag}: vegetation ${JSON.stringify(observed.veg)}`)
  say(`${tag}: marks ${JSON.stringify(observed.marks)}`)

  return { observed, gpu, readyWallMs }
}

async function workerArm(browser, base, workerPath, label) {
  const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT })
  const url = `${base}/landing/index.html`
  say(`${label}: navigating to ${url} for ${workerPath} ...`)
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  const raw = await page.evaluate(WORKER_COLD_START(OBSERVE_MS, workerPath)).catch((e) => ({ error: 'evaluate failed: ' + e.message }))
  if (raw.error) throw new Error(raw.error)

  const arrivals = raw.arrivals || []
  const readyMsg = arrivals.find((a) => a.type === 'ready')
  const frames = arrivals.filter((a) => a.type === 'frame')
  const first = frames.length ? frames[0] : null
  const firstSecond = frames.filter((a) => a.at <= 1000).length
  const first250 = frames.filter((a) => a.at <= 250).length
  const errors = arrivals.filter((a) => a.type === 'error')

  const out = {
    initSentMs: raw.initSentMs,
    observedMs: raw.elapsedMs,
    readyArrived: !!readyMsg,
    readyAtMs: readyMsg ? readyMsg.at : null,
    framesReported: frames.length,
    framesInFirst250Ms: first250,
    framesInFirst1000Ms: firstSecond,
    firstFrameNumber: first ? first.frame : null,
    firstFrameAtMs: first ? first.at : null,
    firstFrameWorkerMs: first ? first.ms : null,
    firstFrameRenderMs: first ? first.renderMs : null,
    firstFrameDrawCalls: first ? first.drawCalls : null,
    firstFrameTriangles: first ? first.triangles : null,
    reportedFrameNumbers: frames.slice(0, 6).map((f) => f.frame),
    worstRenderMs: frames.length ? Math.max(...frames.map((f) => (Number.isFinite(f.renderMs) ? f.renderMs : 0))) : null,
    workerError: raw.workerError,
    errorCount: errors.length,
    firstError: errors.length ? errors[0].message : null,
  }
  say(`${label}: ${JSON.stringify(out)}`)
  return out
}

async function main() {
  process.env.SPOINT_SKIP_PREWARM = process.env.SPOINT_SKIP_PREWARM || '1'
  process.env.WORLD = process.env.WORLD || WORLD
  process.env.PORT = PORT
  process.env.SPOINT_NO_WATCH = '1'

  let server = null
  let browser = null
  try {
    const { boot } = await import('../src/sdk/server.js')
    server = await boot()
    const base = `http://localhost:${PORT}`
    say(`server up on ${base} (world=${process.env.WORLD})`)

    const args = GPU_VENDOR ? vendorPinArgs(GPU_VENDOR) : []
    browser = await chromium.launch({ headless: true, args: [...args, ...UNLOCKED_RAF_ARGS] })

    const worker = await workerArm(browser, base, SHIPPED_WORKER_URL, 'worker-cold-start')
    // The same instrument against the pre-fix gate, so the before/after is one box, one bundle and
    // one run: this worker is byte-identical to the shipped one except that the frame post is not
    // forced on frameCount === 1, which is exactly what the shipped code did before this row. It is
    // derived from the shipped file at run time and deleted afterwards, so no second copy of the
    // clock can drift away from the one that ships.
    let derivedBefore = null
    if (BEFORE_WORKER === '/auto') {
      const shipped = readFileSync(SHIPPED_WORKER_PATH, 'utf8')
      if (!shipped.includes(FIRST_FRAME_GUARD)) throw new Error('client/workers/OffscreenRenderWorker.js no longer carries the first-frame guard, so the before arm has nothing to remove and the before/after is no longer the one this row measured')
      writeFileSync(DERIVED_BEFORE_PATH, shipped.split(FIRST_FRAME_GUARD).join(WITHOUT_FIRST_FRAME_GUARD), 'utf8')
      derivedBefore = '/workers/ff-before-clock.mjs'
    }
    const beforeUrl = derivedBefore || BEFORE_WORKER
    const beforeWorker = beforeUrl ? await workerArm(browser, base, beforeUrl, 'worker-cold-start-before') : null
    if (derivedBefore) rmSync(DERIVED_BEFORE_PATH, { force: true })
    const cold = await coldLoadArm(browser, base, false)
    // What the warm wait is being paid for. The vacuous arm restores the pre-fix reader, so
    // pendingProgramCount answers 0, the wait resolves on its first poll and whatever was still
    // compiling lands in the frames after the reveal instead of behind the loading screen. One box,
    // one bundle, two boots: the wait's cost and the first frame it buys are measured together.
    const coldVacuous = await coldLoadArm(browser, base, true)

    const ob = cold.observed
    const wait = ob.programReadinessWait || null
    const vb = coldVacuous ? coldVacuous.observed : null
    const vwait = vb ? vb.programReadinessWait : null

    const firstCostMs = ob.firstWorkingFrameCostMs
    say(`MEASURED cold-load: time-to-first-frame ${round(ob.firstFrameAtMs)}ms (first animation frame at or after revealedAt ${round(ob.revealedAtMs)}ms; the world's own work in a frame after the reveal: ${firstCostMs === null ? 'n/a -- its loop recorded no work' : round(firstCostMs, 2) + 'ms at ' + round(ob.firstWorkingFrameAtMs) + 'ms'}), isReady ${cold.readyWallMs}ms, warm wait ${round(wait ? wait.waitedMs : null, 3)}ms with ${wait ? wait.pendingAtStart : null} outstanding, vegetation instances=${ob.veg ? ob.veg.totalInstances : null} over ${ob.veg ? ob.veg.instancesNonZero : null}/${ob.veg ? ob.veg.instancerCount : null} instancer(s)`)
    if (vb) say(`MEASURED cold-load BEFORE (vacuous reader): time-to-first-frame ${round(vb.firstFrameAtMs)}ms, first-frame cost ${vb.firstWorkingFrameCostMs === null ? 'n/a' : round(vb.firstWorkingFrameCostMs, 2) + 'ms'}, isReady ${coldVacuous.readyWallMs}ms, warm wait ${round(vwait ? vwait.waitedMs : null, 3)}ms with ${vwait ? vwait.pendingAtStart : null} outstanding`)
    if (vb) say(`MEASURED warm-wait delta: ${round(vwait ? vwait.waitedMs : null, 3)}ms -> ${round(wait ? wait.waitedMs : null, 3)}ms of boot wall, first-frame cost ${round(vb.firstFrameCostMs, 2)}ms -> ${round(ob.firstFrameCostMs, 2)}ms`)
    say(`MEASURED worker-cold-start: init->ready ${round(worker.readyAtMs)}ms, init->first-reported-frame ${round(worker.firstFrameAtMs)}ms, first reported frame number ${worker.firstFrameNumber}, its render cost ${round(worker.firstFrameRenderMs, 2)}ms, frames in the first 250ms ${worker.framesInFirst250Ms} of ${worker.framesReported} over ${round(worker.observedMs)}ms`)
    if (beforeWorker) say(`MEASURED worker-cold-start BEFORE (250ms clock as shipped): init->ready ${round(beforeWorker.readyAtMs)}ms, init->first-reported-frame ${round(beforeWorker.firstFrameAtMs)}ms, first reported frame number ${beforeWorker.firstFrameNumber}, that frame's render cost ${round(beforeWorker.firstFrameRenderMs, 2)}ms, frames in the first 250ms ${beforeWorker.framesInFirst250Ms} of ${beforeWorker.framesReported}`)
    say(`MEASURED first-frame delta: first reported frame number ${beforeWorker ? beforeWorker.firstFrameNumber : 'n/a'} -> ${worker.firstFrameNumber}, first-frame render cost ${beforeWorker ? round(beforeWorker.firstFrameRenderMs, 2) + 'ms of frame ' + beforeWorker.firstFrameNumber : 'unreported'} -> ${round(worker.firstFrameRenderMs, 2)}ms of frame ${worker.firstFrameNumber}`)

    check('the adapter is asserted from window.__rendererInfo', !!ob.rendererInfo,
      'window.__rendererInfo is absent, so the adapter was never pinned and this arm proves nothing')
    check('the boot reached the reveal', Number.isFinite(ob.revealedAtMs),
      'window.__app.revealedAt was never stamped, so the world was never revealed and there is no first frame to place')
    check('a frame at or after the reveal was actually observed', Number.isFinite(ob.firstFrameAtMs),
      'no animation frame was recorded at or after revealedAt, so the first frame is still unmeasured')
    check('the boot shader warm wait reported what it waited for', !!wait && Number.isFinite(wait.waitedMs),
      'window.__programReadinessWait is absent, so the warm wait cost is still invisible')
    check('the worker became ready', worker.readyArrived, 'the worker never posted ready: ' + String(worker.workerError))
    check('the first rendered frame is REPORTED, not swallowed by the 250ms clock', worker.firstFrameNumber === 1,
      'the first reported frame carries frame number ' + String(worker.firstFrameNumber) + ', so the 250ms clock swallowed the first rendered frame again')
    check('the first reported frame carries its own render cost', Number.isFinite(worker.firstFrameRenderMs) && worker.firstFrameRenderMs > 0,
      'the first reported frame has no finite render cost')
    check('the first frame arrived inside the old gate window it used to be swallowed by', Number.isFinite(worker.firstFrameAtMs) && worker.firstFrameAtMs < 1000,
      'the first frame arrived at ' + String(worker.firstFrameAtMs) + 'ms')

    await browser.close().catch(() => {})
    browser = null
    if (server) server.stop()

    for (const f of failures) say('[FAIL] ' + f)
    say(`RESULT: ${failures.length === 0 ? 'PASS' : 'FAIL'} arm=${GPU_VENDOR || 'default'} label=${LABEL}`)
    process.exitCode = failures.length === 0 ? 0 : 1
  } catch (e) {
    say('run FAILED: ' + (e && e.stack ? e.stack : String(e)))
    if (browser) await browser.close().catch(() => {})
    if (server) server.stop()
    process.exitCode = 1
  }
}

main()
