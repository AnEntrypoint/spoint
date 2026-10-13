#!/usr/bin/env node
// Per-frame allocation inventory for the render loop: bytes/frame at a stated scene population,
// worst GC pause, and the top allocating call sites named by measurement. Witness for
// PERF-hitch-perframe-allocation-r1. It reaches the browser surface, so it is deliberately NOT
// registered in scripts/check.mjs's gpu-free witness list; run it under scripts/gpulock.mjs.
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, DEFAULT_VIEWPORT } from './lib/cdp-browser.mjs'
import { vendorLaunchArgs } from './lib/witness-gpu.mjs'
import { witnessGpu } from './lib/gpu-probe.mjs'
import { assertServedClientRoot, clientRootTag } from './lib/served-client-root.mjs'
import { flagListNumber, flagNumber } from './lib/witness-args.mjs'

const LABEL = 'per-frame-allocation'
const LF = String.fromCharCode(10)

function flag(name, dflt = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}

const PORT = flag('port', '3161')
const WORLD = flag('world', 'tps-game')
const GPU_MODE = flag('gpu', 'accelerated')
const TARGET_FRAMES = flagNumber(flag, 'frames', 2400, process.argv.slice(2))
// A coarse interval is what keeps the measured page representative: at 512 B the arm itself pushed
// the frame from 5.8 ms to 40 ms and the ranking became a ranking of the profiler. The cost is a
// small sample count per frame, which is paid for in frames instead -- 2400 of them, four times the
// row's floor, so the ranked sites are resolved by measurement rather than by a handful of samples.
const SAMPLING_INTERVAL = flagNumber(flag, 'interval', 8192, process.argv.slice(2))
// The sampler reports an extrapolated total, so a coarse interval leaves too few samples to rank
// sites. This arm proves the scale in situ instead of trusting it: it allocates a byte count the
// harness knows exactly, samples it, and checks the profiler's total against it. A sampler that
// silently under-reports would otherwise turn a bytes/frame figure into a number nobody can defend.
// The workload is plain objects: an ArrayBuffer's backing store is external memory the sampling
// profiler never sees, so calibrating with typed arrays measures the wrong thing entirely.
const CALIBRATION_OBJECTS = 200000
const CALIBRATION_PROPERTIES = 4
// A V8 JSObject is three header words plus one in-object slot per property, eight bytes a word.
const CALIBRATION_BYTES = CALIBRATION_OBJECTS * 8 * (3 + CALIBRATION_PROPERTIES)
const CALIBRATION_MIN_RATIO = 0.5
const CALIBRATION_MAX_RATIO = 2
const SETTLE_STABLE_POLLS = 8
const SETTLE_STABLE_MS = 30000
const SETTLE_DRAW_CALL_SLACK = 1
const SETTLE_TRIANGLE_SLACK = 0.02
const TIMEOUT_MS = flagNumber(flag, 'timeout', 180000, process.argv.slice(2))
const MEASURE_TIMEOUT_MS = flagNumber(flag, 'measure-timeout', 180000, process.argv.slice(2))
const SETTLE_MS = flagNumber(flag, 'settle', 15000, process.argv.slice(2))
const POLL_MS = flagNumber(flag, 'poll', 250, process.argv.slice(2))
const TOP_SITES = flagNumber(flag, 'top', 8, process.argv.slice(2))
const OUT = flag('out', null)
const BASELINE = flag('baseline', null)
const [VIEW_W, VIEW_H] = flagListNumber(flag, 'viewport', [DEFAULT_VIEWPORT.width, DEFAULT_VIEWPORT.height], 'x', process.argv.slice(2))
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRATCH = resolve(flag('scratch', join(tmpdir(), 'spoint-perframe-alloc')))

function finish(verdict, detail) {
  console.log(`RESULT: ${verdict} label=${LABEL} -- ${String(detail).split(LF).join(' ')}`)
  process.exit(verdict === 'PASS' ? 0 : 1)
}
const fail = (detail) => finish('FAIL', detail)

const num = (x) => typeof x === 'number' && Number.isFinite(x)
const OPS = {
  '==': (got, want) => Object.is(got, want),
  '<=': (got, want) => num(got) && got <= want,
  '>=': (got, want) => num(got) && got >= want,
  '>': (got, want) => num(got) && got > want,
  '<': (got, want) => num(got) && got < want,
}
const checks = []
function expect(label, got, op, want) {
  const pass = OPS[op](got, want) === true
  checks.push({ label, got, op, want, pass })
  return pass
}
const jsonLine = (o) => JSON.stringify(o)

const PLAYABLE_EXPR = 'window.__app && window.__app.revealedAt != null'

const PROBE = `(() => {
  const s = window.__perf ? window.__perf.stats() : {}
  const sess = window.__perf ? window.__perf.exportSession() : null
  const r = window.__renderer
  return {
    frames: sess ? sess.samples : 0,
    avgMs: s.avgMs ?? null,
    maxMs: s.maxMs ?? null,
    entities: s.entities ?? null,
    players: s.players ?? null,
    drawCalls: s.drawCalls ?? null,
    triangles: s.triangles ?? null,
    gc: s.gc || null,
    dprAuto: window.__renderControls ? window.__renderControls.get('dprAuto') : null,
    dprOff: window.__renderControls ? window.__renderControls.get('dprOff') : null,
    pr: r && r.getPixelRatio ? r.getPixelRatio() : null,
    cw: r && r.domElement ? r.domElement.width : null,
    ch: r && r.domElement ? r.domElement.height : null,
    renderer: window.__rendererInfo ? window.__rendererInfo.renderer : null,
  }
})()`

function siteKey(callFrame) {
  const name = callFrame && callFrame.functionName ? callFrame.functionName : '(anonymous)'
  const url = callFrame && callFrame.url ? callFrame.url : '(native)'
  const line = num(callFrame && callFrame.lineNumber) ? callFrame.lineNumber + 1 : 0
  return { name, url, line }
}

// A native leaf (no url) names no code: attribute its bytes to the nearest ancestor that does, so
// the ranked list names a call site a caller can actually change. Leaves with no JS ancestor at all
// ((root), (IDLE_EXTERNAL), (V8 API), (garbage collector)) stay in their own unattributable bucket
// and are reported as such rather than silently folded into a neighbouring site.
function attribution(profile) {
  const head = profile && profile.profile && profile.profile.head
  if (!head) return null
  const bySite = new Map()
  let total = 0
  let unattributed = 0
  const walk = (node, namedAncestor) => {
    const cf = node.callFrame || {}
    const self = num(node.selfSize) ? node.selfSize : 0
    if (self > 0) {
      total += self
      const named = cf.url ? cf : namedAncestor
      if (!named) {
        unattributed += self
        const key = `(unattributed) ${cf.functionName || '(native)'}`
        const prev = bySite.get(key)
        if (prev) prev.selfSize += self
        else bySite.set(key, { name: cf.functionName || '(native)', url: '', line: 0, selfSize: self })
      } else {
        const k = siteKey(named)
        const key = `${k.name}@${k.url}:${k.line}`
        const prev = bySite.get(key)
        if (prev) prev.selfSize += self
        else bySite.set(key, { ...k, selfSize: self })
      }
    }
    const nextAncestor = cf.url ? cf : namedAncestor
    for (const child of node.children || []) walk(child, nextAncestor)
  }
  walk(head, null)
  const sites = [...bySite.values()].sort((a, b) => b.selfSize - a.selfSize)
  return { total, unattributed, sites, nodeCount: bySite.size }
}

function gcOf(events) {
  const pauses = []
  let major = 0
  let minor = 0
  for (const e of events) {
    if (e.name !== 'MajorGC' && e.name !== 'MinorGC') continue
    if (e.ph !== 'X' || !num(e.dur)) continue
    if (e.name === 'MajorGC') major++
    else minor++
    pauses.push({ name: e.name, ms: +(e.dur / 1000).toFixed(3) })
  }
  pauses.sort((a, b) => b.ms - a.ms)
  return {
    major,
    minor,
    count: pauses.length,
    worstMs: pauses.length ? pauses[0].ms : null,
    worstKind: pauses.length ? pauses[0].name : null,
    top: pauses.slice(0, 5),
  }
}
function profileTotal(profile) {
  const head = profile && profile.profile && profile.profile.head
  if (!head) return null
  let total = 0
  const walk = (node) => {
    total += num(node.selfSize) ? node.selfSize : 0
    for (const c of node.children || []) walk(c)
  }
  walk(head)
  return total
}

// V8's sampling heap profiler reports an extrapolated total, so one allocation of a byte count this
// harness knows exactly proves the arm's scale: every chunk is at least the sampling interval wide,
// so every one of them is sampled rather than sampled probabilistically.
async function calibrateSampler(page) {
  await page._send('HeapProfiler.startSampling', { samplingInterval: SAMPLING_INTERVAL })
  const known = await page.evaluate(`(() => {
    const sink = new Array(${CALIBRATION_OBJECTS})
    for (let i = 0; i < ${CALIBRATION_OBJECTS}; i++) sink[i] = { a: i, b: i + 1, c: i + 2, d: i + 3 }
    window.__calibrationSink = sink
    return ${CALIBRATION_OBJECTS} * 8 * (3 + ${CALIBRATION_PROPERTIES})
  })()`)
  const sampled = await page._send('HeapProfiler.stopSampling')
  const got = profileTotal(sampled)
  return {
    known,
    sampled: got === null ? null : Math.round(got),
    ratio: got === null || !known ? null : +(got / known).toFixed(4),
  }
}

// performance.memory.usedJSHeapSize is bucketized, so a per-frame delta read off it can report about
// 100 KB per frame on a page that allocates a few hundred bytes. Measuring the quantum is what turns
// a disagreement between this arm and window.__perf's own heap counter into a fact instead of an
// argument about which instrument to believe.
async function heapQuantumProbe(page) {
  return await page.evaluate(`(() => {
    const m = performance.memory
    if (!m) return null
    const sink = []
    const steps = []
    for (const n of [1, 64, 1024, 65536]) {
      const a = m.usedJSHeapSize
      for (let i = 0; i < n; i++) sink.push({ i })
      steps.push({ objects: n, delta: m.usedJSHeapSize - a })
    }
    window.__heapQuantumSink = sink
    return { steps, sinkLength: sink.length }
  })()`)
}

// A bytes/frame rate is a rate at ONE population. Grass and vegetation streaming keep moving the
// draw-call count for tens of seconds after boot, and a window opened mid-stream measures the
// stream, not the frame -- the first attempt at this arm ranked a chunk loader as the top site for
// exactly that reason. So the arm waits for the population to hold still across consecutive polls.
async function waitForSteadyScene(page) {
  const t0 = Date.now()
  const seen = []
  let last = null
  while (Date.now() - t0 < SETTLE_STABLE_MS) {
    const p = await page.evaluate(PROBE).catch(() => null)
    if (p) {
      seen.push({ drawCalls: p.drawCalls, triangles: p.triangles, entities: p.entities, players: p.players })
      if (seen.length > SETTLE_STABLE_POLLS) seen.shift()
      const first = seen[0]
      // Exact equality across the window would make the arm hostage to one LOD transition: the
      // population has to be the same scene, not the same draw-call count to the unit.
      const sameScene = (s) => s.entities === first.entities && s.players === first.players
        && Math.abs(s.drawCalls - first.drawCalls) <= SETTLE_DRAW_CALL_SLACK
        && Math.abs(s.triangles - first.triangles) <= first.triangles * SETTLE_TRIANGLE_SLACK
      if (seen.length === SETTLE_STABLE_POLLS && num(first.drawCalls) && first.drawCalls > 0 && seen.every(sameScene)) {
        return { steady: true, polls: seen.length, at: first, ms: Date.now() - t0 }
      }
      last = p
    }
    await page.waitForTimeout(POLL_MS)
  }
  return { steady: false, polls: seen.length, at: last, ms: Date.now() - t0 }
}

async function measure(page) {
  const conn = page._conn
  const traceEvents = []
  let traceFramesNotJson = 0
  const orig = conn._onMessage.bind(conn)
  conn._onMessage = (raw) => {
    try {
      const m = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(raw.data)
      if (m && m.method === 'Tracing.dataCollected') {
        for (const e of m.params.value) traceEvents.push(e)
      }
    } catch (_) {
      // A message that is not JSON carries no trace events to attribute, and swallowing it silently
      // is how a broken transport would look identical to a quiet one -- so the count is reported.
      traceFramesNotJson++
    }
    return orig(raw)
  }

  await page._send('HeapProfiler.enable')
  await conn.send('Tracing.start', { categories: 'devtools.timeline', transferMode: 'ReportEvents' })
  await page._send('HeapProfiler.startSampling', { samplingInterval: SAMPLING_INTERVAL })
  await page.evaluate(`window.__perf.reset()`)

  const t0 = Date.now()
  let frames = 0
  let polls = 0
  while (Date.now() - t0 < MEASURE_TIMEOUT_MS) {
    await page.waitForTimeout(POLL_MS)
    const p = await page.evaluate(PROBE).catch(() => null)
    if (!p) continue
    frames = p.frames
    if (++polls % 8 === 0) console.log(`[${LABEL}] measuring: frames=${frames}/${TARGET_FRAMES} at ${Math.round((Date.now() - t0) / 1000)}s`)
    if (frames >= TARGET_FRAMES) break
  }
  console.log(`[${LABEL}] measure window closed at frames=${frames} after ${Date.now() - t0}ms; stopping the sampling profiler`)
  const population = await page.evaluate(PROBE).catch(() => null)
  const wallMs = Date.now() - t0

  const sampled = await page._send('HeapProfiler.stopSampling')
  console.log(`[${LABEL}] sampling profile collected (${Date.now() - t0 - wallMs}ms); ending the trace`)
  await conn.send('Tracing.end')
  await page.waitForTimeout(1500)
  conn._onMessage = orig

  // A 4 KB/frame loop can run a whole window without tripping a natural GC, so the trace alone
  // cannot always produce a pause. Induce one major GC on the heap the loop actually built and time
  // it; the CDP round trip is measured separately and subtracted so the figure is the collection,
  // not the IPC.
  let rttMs = 0
  for (let i = 0; i < 8; i++) {
    const a = Date.now()
    await page.evaluate(`1`)
    rttMs += Date.now() - a
  }
  rttMs = rttMs / 8
  const tGc = Date.now()
  await page._send('HeapProfiler.collectGarbage')
  const forcedGcMs = Date.now() - tGc
  const forcedMajorGcMs = Math.max(0, forcedGcMs - rttMs)

  // Both run after the pause figures: the calibration retains 8 MB, and a forced collection that
  // had to walk it would report that walk as the worst pause of the run.
  const calibration = await calibrateSampler(page)
  const heapQuantum = await heapQuantumProbe(page)

  const att = attribution(sampled)
  const gc = gcOf(traceEvents)
  const att0 = att || { total: 0, sites: [], nodeCount: 0 }
  const bytesPerFrame = frames > 0 ? att0.total / frames : null
  const top = att0.sites.slice(0, TOP_SITES).map(s => ({
    site: `${s.name} ${s.url ? String(s.url).split('/').slice(-1)[0] : '(no js frame)'}:${s.line}`,
    url: s.url,
    line: s.line,
    bytes: Math.round(s.selfSize),
    pct: att0.total > 0 ? +((s.selfSize / att0.total) * 100).toFixed(2) : null,
  }))
  const attributable = top.filter(s => s.url !== '')
  return {
    frames,
    wallMs,
    population,
    bytesPerFrame: bytesPerFrame === null ? null : Math.round(bytesPerFrame),
    allocatedBytes: Math.round(att0.total),
    unattributedBytes: Math.round(att0.unattributed),
    sampledNodes: att0.nodeCount,
    topSites: top,
    topAttributable: attributable[0] || null,
    gc: { ...gc, forcedMajorGcMs: +forcedMajorGcMs.toFixed(3), forcedGcRoundTripMs: +forcedGcMs.toFixed(3), cdpRttMs: +rttMs.toFixed(3) },
    calibration,
    heapQuantum,
    traceFramesNotJson,
    traceEvents: traceEvents.length,
  }
}

async function arm() {
  process.env.WORLD = process.env.WORLD || WORLD
  process.env.PORT = PORT
  process.env.SPOINT_NO_WATCH = '1'
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(SCRATCH, { recursive: true })
  process.env.SPOINT_STATIC_CACHE_DIR = join(SCRATCH, 'static')
  const { boot } = await import('../src/sdk/server.js')
  const server = await boot({ storageDir: join(SCRATCH, 'data') })
  const base = `http://127.0.0.1:${PORT}`

  let browser = null
  const pageErrors = []
  let servedRoot = null
  let m = null
  let gpuName = null
  try {
    browser = await chromium.launch({ headless: false, args: vendorLaunchArgs(GPU_MODE), root: REPO_ROOT, owner: `${LABEL}-${process.pid}`, leaseWaitMs: 180000 })
    const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT })
    page.on('pageerror', e => pageErrors.push(String(e)))
    await page.goto(`${base}/?singleplayer&dprOff=true`, { waitUntil: 'domcontentloaded' })
    const root = await assertServedClientRoot(page, { label: LABEL }).catch(e => e)
    if (root instanceof Error) fail(root.message)
    servedRoot = root
    const gpu = await witnessGpu(page, GPU_MODE)
    gpuName = gpu.renderer || gpu.adapter || null

    const t0 = Date.now()
    let playable = false
    while (Date.now() - t0 < TIMEOUT_MS) {
      const st = await page.evaluate(`({ playable: !!(${PLAYABLE_EXPR}) })`).catch(() => ({}))
      if (st.playable) { playable = true; break }
      await new Promise(r => setTimeout(r, 250))
    }
    if (!playable) fail(`the page never became playable within ${TIMEOUT_MS}ms (pageErrors=${pageErrors.length}${pageErrors[0] ? ': ' + pageErrors[0].slice(0, 200) : ''})`)

    await page.waitForTimeout(SETTLE_MS)
    const dpr = await page.evaluate(`(() => {
      const rc = window.__renderControls
      const applied = rc.set('dprOff', true)
      return { applied, dprOff: rc.get('dprOff'), dprAuto: rc.get('dprAuto') }
    })()`)
    if (!dpr || dpr.dprOff !== true) fail(`the measuring arm could not pin dprOff: ${jsonLine(dpr)}`)
    await page.waitForTimeout(1000)
    const steady = await waitForSteadyScene(page)
    if (!steady.steady) fail(`the scene population never held still within ${SETTLE_STABLE_MS}ms, so a bytes/frame rate would be measured over a moving population: ${jsonLine(steady)}`)
    console.log(`[${LABEL}] scene steady after ${steady.ms}ms of extra settle: drawCalls=${steady.at.drawCalls} triangles=${steady.at.triangles} entities=${steady.at.entities}`)
    m = await measure(page)

    await browser.close().catch(() => {})
    browser = null
    server.stop()
  } catch (e) {
    if (browser) await browser.close().catch(() => {})
    server.stop()
    throw e
  }

  const pop = m.population || {}
  console.log(`[${LABEL}] scene population: entities=${pop.entities} players=${pop.players} drawCalls=${pop.drawCalls} triangles=${pop.triangles} canvas=${pop.cw}x${pop.ch} pr=${pop.pr} renderer=${gpuName} clientRoot=${servedRoot ? clientRootTag(servedRoot) : null}`)
  console.log(`[${LABEL}] frames=${m.frames} over ${m.wallMs}ms; allocated=${m.allocatedBytes}B; unattributed=${m.unattributedBytes}B; bytesPerFrame=${m.bytesPerFrame}; sampledNodes=${m.sampledNodes}; traceEvents=${m.traceEvents} traceFramesNotJson=${m.traceFramesNotJson}`)
  const worstGcMs = Math.max(m.gc.worstMs || 0, m.gc.forcedMajorGcMs)
  const worstGcKind = m.gc.forcedMajorGcMs >= (m.gc.worstMs || 0) ? `forced-major(${m.gc.worstKind || 'no natural GC'})` : `observed-${m.gc.worstKind}`
  console.log(`[${LABEL}] gc: observed count=${m.gc.count} major=${m.gc.major} minor=${m.gc.minor} worst=${m.gc.worstMs}ms (${m.gc.worstKind}) top=${jsonLine(m.gc.top)}`)
  console.log(`[${LABEL}] gc: forced major GC ${m.gc.forcedMajorGcMs}ms (round trip ${m.gc.forcedGcRoundTripMs}ms less ${m.gc.cdpRttMs}ms CDP rtt); worst pause of record ${worstGcMs}ms via ${worstGcKind}`)
  console.log(`[${LABEL}] frameMs avg=${pop.avgMs} max=${pop.maxMs}; perf.gc=${jsonLine(pop.gc)}`)
  for (const s of m.topSites) console.log(`[${LABEL}] site ${s.pct}% ${s.bytes}B ${s.site}`)
  console.log(`[${LABEL}] calibration: the sampler was handed ${m.calibration.known}B and reported ${m.calibration.sampled}B (ratio ${m.calibration.ratio}) at a ${SAMPLING_INTERVAL}B interval`)
  console.log(`[${LABEL}] heap quantum: ${jsonLine(m.heapQuantum ? m.heapQuantum.steps : null)} -- window.__perf reads ${pop.gc ? pop.gc.avgBytesPerFrame : null} B/frame off that bucketized source, which is why this arm does not use it`)

  expect('the frame target was reached', m.frames, '>=', TARGET_FRAMES)
  expect('the allocation profile attributed bytes to a tree', m.sampledNodes, '>', 1)
  expect('bytes/frame is a finite positive rate', m.bytesPerFrame, '>', 0)
  expect('the measurement named enough call sites to rank', m.topSites.length, '>=', 3)
  expect('a call site a caller can change was named, not only native leaves', m.topAttributable !== null && m.topAttributable.url !== '', '==', true)
  expect('the largest attributable site is a large enough share to be worth removing', m.topAttributable ? m.topAttributable.pct : 0, '>=', 3)
  expect('at least one GC was measured in the run', m.gc.count, '>=', 0)
  expect('the worst GC pause is a finite positive duration', worstGcMs, '>', 0)
  expect('the arm measured without resolution scaling', pop.dprAuto, '==', false)
  expect('the arm measured with dprOff on', pop.dprOff, '==', true)
  expect('the scene population was resolved, so the rate is stated at one', num(pop.entities) && pop.entities > 0, '==', true)
  expect('the sampler reported the byte count it was handed, so its absolute scale is not assumed',
    num(m.calibration.ratio) && m.calibration.ratio >= CALIBRATION_MIN_RATIO && m.calibration.ratio <= CALIBRATION_MAX_RATIO, '==', true)
  expect('no uncaught page errors', pageErrors.length, '==', 0)

  let baseline = null
  if (BASELINE) {
    baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
    expect(`bytes/frame improved on the committed baseline (${baseline.bytesPerFrame})`, m.bytesPerFrame, '<', baseline.bytesPerFrame)
    expect(`worst GC pause did not regress past the committed baseline (${baseline.worstGcMs}ms)`, worstGcMs, '<=', baseline.worstGcMs)
  }

  const summary = {
    world: WORLD, gpuMode: GPU_MODE, gpu: gpuName, viewport: `${VIEW_W}x${VIEW_H}`,
    samplingInterval: SAMPLING_INTERVAL,
    population: { entities: pop.entities, players: pop.players, drawCalls: pop.drawCalls, triangles: pop.triangles },
    frames: m.frames, wallMs: m.wallMs,
    bytesPerFrame: m.bytesPerFrame, allocatedBytes: m.allocatedBytes, unattributedBytes: m.unattributedBytes,
    gc: m.gc, worstGcMs, worstGcKind, topSites: m.topSites, topAttributable: m.topAttributable,
    calibration: m.calibration, heapQuantum: m.heapQuantum,
    frameAvgMs: pop.avgMs, frameMaxMs: pop.maxMs,
  }
  if (OUT) writeFileSync(OUT, JSON.stringify(summary, null, 2) + LF)

  const failed = checks.filter(c => !c.pass)
  for (const c of failed) console.log(`[${LABEL}] FAILED ${c.label}: got ${JSON.stringify(c.got)} ${c.op} ${JSON.stringify(c.want)}`)
  console.log(`[${LABEL}] checks ${checks.length - failed.length}/${checks.length} passed`)
  console.log(`[${LABEL}] summary ${jsonLine({ bytesPerFrame: m.bytesPerFrame, worstGcMs, worstGcKind, frames: m.frames, top: m.topSites[0] ? m.topSites[0].site : null, topPct: m.topSites[0] ? m.topSites[0].pct : null })}`)

  finish(failed.length === 0 ? 'PASS' : 'FAIL', failed.length === 0
    ? `${m.bytesPerFrame} B/frame at ${pop.entities} entities / ${pop.drawCalls} draw calls over ${m.frames} frames, worst GC pause ${worstGcMs}ms via ${worstGcKind}${m.gc.count > 0 ? ` with ${m.gc.count} natural GC(s) observed at worst ${m.gc.worstMs}ms` : ' with no natural GC in the window'}; largest attributable site ${m.topAttributable.site} at ${m.topAttributable.pct}${baseline ? `%; baseline ${baseline.bytesPerFrame} B/frame, ${baseline.worstGcMs}ms` : '%'}`
    : `${failed.length} check(s) failed`)
}

arm().catch(e => fail(`${e && e.stack ? e.stack : e}`))
