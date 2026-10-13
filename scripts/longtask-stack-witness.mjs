#!/usr/bin/env node
// PERF-unattributed-900ms-longtask-r270-74.
//
// Two ~920 ms frames survive the async-render-pipeline fix (c40bae4f). Each carries ONE long task of
// 910-939 ms while animate() is 102.1/91.4 ms and no render-graph node exceeds 72.98/28.5 ms, so the
// stall is neither the frame loop nor a render node. A longtask entry carries only start+duration, so
// it can never name its own cause. This witness names it: a CDP CPU profile runs across the same
// capture, and each long-task window is mapped onto the profile's sample timeline, so the samples
// inside the window are aggregated into a stack.
//
// The same mapping decides the contention question without a guess. A 920 ms task holding ~920 ms of
// JS samples is real work; a 920 ms task holding ~100 ms is wall time the thread did not spend
// executing -- descheduled, which is what host contention looks like. The node-side spin sampler and
// the host-CPU sampler run concurrently for the correlation.
//
// Headful only, on the pinned vendor adapter, with window.__rendererInfo asserted. Run as:
//   node scripts/gpulock.mjs run r270-74 -- node scripts/longtask-stack-witness.mjs --capture-ms=45000
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { cpus } from 'node:os'
import { chromium, DEFAULT_VIEWPORT } from './lib/cdp-browser.mjs'
import { assertGpu, gpuArgs, vendorGpuArgs } from './lib/gpu-probe.mjs'
import { assertServedClientRoot, clientRootTag, rebuildIfRequested, CLIENT_ROOT_BUNDLE } from './lib/served-client-root.mjs'
import { spinMs } from './lib/host-contention.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = resolve(ROOT, '.gm', 'witness-out', 'longtask-stack')

const flag = (name, dflt = '') => {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='))
  return hit ? hit.slice(name.length + 3) : dflt
}
const num = (name, dflt) => {
  const raw = flag(name, '')
  const v = Number(raw)
  return raw === '' || !Number.isFinite(v) ? dflt : v
}
const has = (name) => process.argv.includes('--' + name)

const VENDOR = flag('vendor', process.env.SPOINT_GPU || 'amd')
const WORLD = flag('world', 'tps-game')
const PORT = flag('port', '3311')
const AT = flag('at', '')
const CAPTURE_MS = num('capture-ms', 45000)
const SAMPLE_US = num('sample-us', 500)
const LONG_TASK_MS = num('long-task-ms', 200)
const TOP_STACKS = num('top-stacks', 4)
const WALK_LEGS = String(flag('walk-legs', 'KeyW,KeyD,KeyW,KeyA')).split(',').map((s) => s.trim()).filter(Boolean)
const LEG_MS = num('leg-ms', 4000)
const SETTLE_MS = num('settle-ms', 15000)
const LOAD_TIMEOUT_MS = num('load-timeout-ms', 300000)
const LEASE_WAIT_MS = num('lease-wait-ms', 600000)
const METRICS_INTERVAL_MS = num('metrics-interval-ms', 250)
const MIN_FRAMES = num('min-frames', 200)
const MODE = flag('mode', 'report')
const CAPTURE_TIMEOUT_MS = CAPTURE_MS * 4 + 120000
const VENDOR_ARGS = vendorGpuArgs(VENDOR)

// Long tasks plus a per-callback timing of the frame loop. The frame-loop wrap is what lets the report
// say "animate() did not contain this" from the same clock the long tasks are on, instead of from a
// separate instrument's numbers.
const PAGE_INSTRUMENT = [
  '(() => {',
  '  const W = window',
  '  if (W.__ltProbe) return',
  '  const rig = { longtasks: [], raf: [], frames: [], memory: [], installed: true, unsupported: false }',
  '  W.__ltProbe = rig',
  '  try {',
  '    new PerformanceObserver((list) => {',
  '      for (const e of list.getEntries()) {',
  '        const a = e.attribution && e.attribution[0] ? e.attribution[0] : null',
  '        rig.longtasks.push({',
  '          start: e.startTime, duration: e.duration, name: e.name || "longtask",',
  '          containerName: a ? (a.containerName || null) : null,',
  '          containerType: a ? (a.containerType || null) : null,',
  '          scriptUrl: a ? (a.scriptUrl || null) : null,',
  '        })',
  '      }',
  '    }).observe({ type: "longtask" })',
  '  } catch (_) { rig.unsupported = true }',
  '  const realRaf = W.requestAnimationFrame.bind(W)',
  '  W.requestAnimationFrame = function (cb) {',
  '    return realRaf((t) => {',
  '      const t0 = performance.now()',
  '      let threw = false',
  '      try { cb(t) } catch (e) { threw = true; throw e }',
  '      finally {',
  '        const t1 = performance.now()',
  // Counted work units ride the same clock as the long tasks. renderer.info.render is reset by
  // three on every render, so reading it after the frame-loop callback is that frame's draw count
  // and triangle count, not a sampled approximation of one.
  '        if (!threw) {',
  '          const info = (W.__app && W.__app.renderer && W.__app.renderer.info && W.__app.renderer.info.render) || null',
  '          rig.raf.push({ start: t0, dur: t1 - t0, t, calls: info ? info.calls : null, tris: info ? info.triangles : null })',
  '        }',
  '      }',
  '    })',
  '  }',
  '  let last = 0',
  '  const tick = (now) => {',
  '    if (last) rig.frames.push({ dt: now - last, at: now })',
  '    last = now',
  '    realRaf(tick)',
  '  }',
  '  realRaf(tick)',
  '  rig.mark = () => performance.now()',
  '  rig.mem = () => (performance.memory ? performance.memory.usedJSHeapSize : null)',
  '})()',
].join('\n')

function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

function evaluateWithDeadline(page, fn, ms, arg) {
  return Promise.race([
    Promise.resolve(page.evaluate(fn, arg)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('page.evaluate did not answer within ' + ms + 'ms -- the page main thread is blocked')), ms)),
  ])
}

function sampleHostCpu() {
  const now = cpus().map((c) => c.times)
  const idle = now.reduce((s, t) => s + t.idle, 0)
  const total = now.reduce((s, t) => s + t.user + t.nice + t.sys + t.idle + t.irq, 0)
  return { idle, total }
}
function hostCpuPct(before, after) {
  const dTotal = after.total - before.total
  const dIdle = after.idle - before.idle
  if (dTotal <= 0) return 0
  return Math.round(((dTotal - dIdle) / dTotal) * 1000) / 10
}

async function waitForReady(page) {
  const start = Date.now()
  while (Date.now() - start < LOAD_TIMEOUT_MS) {
    const probe = await evaluateWithDeadline(page, () => ({
      ready: !!(window.__app && window.__app.loadingMachine && window.__app.loadingMachine.isReady),
    }), 20000).catch(() => ({ ready: false }))
    if (probe.ready) return Date.now() - start
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('loadingMachine never reached isReady within ' + LOAD_TIMEOUT_MS + 'ms')
}

async function waitForDrawing(page) {
  const start = Date.now()
  let prev = null
  while (Date.now() - start < 180000) {
    const now = await evaluateWithDeadline(page, () => {
      const i = window.__app && window.__app.renderer && window.__app.renderer.info
      return i ? { calls: i.render.calls, tris: i.render.triangles } : null
    }, 15000).catch(() => null)
    if (now) {
      if (prev !== null && now.calls - prev >= 5) return now
      prev = now.calls
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('renderer.info.render.calls never advanced -- the page is not presenting frames')
}

// --- CPU profile analysis -------------------------------------------------------------------------

function buildProfile(profile) {
  const nodes = profile.nodes || []
  const byId = new Map()
  const parent = new Map()
  for (const n of nodes) {
    byId.set(n.id, n)
    for (const c of n.children || []) parent.set(c, n.id)
  }
  const nameOf = (n) => {
    const f = n.callFrame || {}
    const fn = f.functionName || '(anonymous)'
    const where = f.url ? (f.url.split('/').pop() || f.url) + ':' + ((f.lineNumber | 0) + 1) : 'native'
    return fn + ' @ ' + where
  }
  const samples = profile.samples || []
  const deltas = profile.timeDeltas || []
  const timeline = []
  let acc = 0
  for (let i = 0; i < samples.length; i++) {
    acc += (deltas[i] || 0)
    timeline.push({ at: acc, node: samples[i], dt: deltas[i] || 0 })
  }
  return { byId, parent, nameOf, timeline, spanUs: acc }
}

function sliceWindow(prof, fromUs, toUs) {
  const out = []
  for (const s of prof.timeline) if (s.at >= fromUs && s.at <= toUs) out.push(s)
  return out
}

function aggregate(prof, slice) {
  const self = new Map()
  const incl = new Map()
  for (const s of slice) {
    self.set(s.node, (self.get(s.node) || 0) + s.dt)
    let cur = s.node
    let guard = 0
    while (cur !== undefined && guard < 512) {
      incl.set(cur, (incl.get(cur) || 0) + s.dt)
      cur = prof.parent.get(cur)
      guard += 1
    }
  }
  return { self, incl }
}

function pathOf(prof, nodeId) {
  const chain = []
  let cur = nodeId
  let guard = 0
  while (cur !== undefined && guard < 512) {
    const n = prof.byId.get(cur)
    if (!n) break
    chain.push(prof.nameOf(n))
    cur = prof.parent.get(cur)
    guard += 1
  }
  return chain.reverse()
}

const BUCKETS = [
  ['idle', /^\(idle\)/],
  ['program', /^\(program\)/],
  ['garbage collector', /^\(garbage collector\)/],
  ['root', /^\(root\)/],
]

function bucketOf(prof, nodeId) {
  const n = prof.byId.get(nodeId)
  if (!n) return 'other'
  const fn = (n.callFrame && n.callFrame.functionName) || ''
  for (const [label, re] of BUCKETS) if (re.test(fn)) return label
  return 'js'
}

async function main() {
  process.env.WORLD = WORLD
  process.env.PORT = PORT
  process.env.SPOINT_NO_WATCH = '1'
  rebuildIfRequested('longtask-stack')

  console.log('[longtask-stack] booting real server on port ' + PORT + ' (world=' + WORLD + ') ...')
  const { boot } = await import('../src/sdk/server.js')
  let server = null
  let browser = null
  try {
    server = await boot()
    console.log('[longtask-stack] server up.')

    browser = await chromium.launch({
      headless: false,
      owner: 'r270-74-ltstack',
      root: ROOT,
      leaseWaitMs: LEASE_WAIT_MS,
      args: [...gpuArgs({ accelerated: true }), ...VENDOR_ARGS],
    })
    const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT })
    await page._send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_INSTRUMENT })
    await page._send('Profiler.enable')
    await page._send('Performance.enable')

    const url = 'http://localhost:' + PORT + '/?singleplayer&world=' + WORLD + (AT ? '&at=' + encodeURIComponent(AT) : '')
    console.log('[longtask-stack] navigating to ' + url + ' ...')
    await page.goto(url, { waitUntil: 'domcontentloaded' })

    let servedRoot = null
    try {
      servedRoot = await assertServedClientRoot(page, { want: CLIENT_ROOT_BUNDLE, label: 'longtask-stack' })
      console.log('[longtask-stack] served ' + clientRootTag(servedRoot))
    } catch (e) {
      // A stale dist/ bundle falls through to raw ESM, which is still the real client. Refusing
      // to measure that would turn a build-artifact staleness into a missing measurement.
      console.log('[longtask-stack] WARN served-client-root: ' + (e && e.message ? e.message : e) + ' -- continuing')
    }

    const readyMs = await waitForReady(page)
    console.log('[longtask-stack] loadingMachine.isReady after ' + (readyMs / 1000).toFixed(1) + 's')

    const gpu = await assertGpu(page, { requireAccelerated: true, expectVendor: VENDOR })
    console.log('[longtask-stack] rasterizer=' + gpu.rasterizer + ' renderer=' + (gpu.renderer || 'none') + ' backend=' + (gpu.backend || 'none'))

    const probe = await evaluateWithDeadline(page, () => {
      const p = window.__ltProbe
      return p ? { installed: p.installed, unsupported: p.unsupported } : null
    }, 15000)
    if (!probe || probe.installed !== true) throw new Error('the long-task instrument never installed -- this run measured no long task')
    if (probe.unsupported) throw new Error('the longtask PerformanceObserver is unavailable on this page, so a stall cannot be windowed')

    const drew = await waitForDrawing(page)
    console.log('[longtask-stack] presenting: ' + drew.calls + ' draw call(s), ' + drew.tris + ' triangle(s)')

    // Vegetation streams in for a long time and every streaming frame is legitimately long. Settle
    // first so the capture windows steady state, exactly as the run that produced the 920 ms frames
    // did (it walked only after the world was built).
    console.log('[longtask-stack] settling ' + SETTLE_MS + 'ms ...')
    await new Promise((r) => setTimeout(r, SETTLE_MS))

    const cleanSpin = spinMs()
    console.log('[longtask-stack] clean spin baseline ' + cleanSpin + 'ms')

    await page._send('Profiler.setSamplingInterval', { interval: SAMPLE_US })
    const cpu0 = sampleHostCpu()
    await page._send('Profiler.start')
    const pageT0 = await evaluateWithDeadline(page, () => window.__ltProbe.mark(), 30000)
    const nodeT0 = Date.now()
    const mark = await evaluateWithDeadline(page, () => ({ lt: window.__ltProbe.longtasks.length, raf: window.__ltProbe.raf.length, fr: window.__ltProbe.frames.length }), 30000)
    console.log('[longtask-stack] capture start: ' + mark.lt + ' long task(s), ' + mark.fr + ' frame(s) already recorded at boot')

    const metrics = []
    const spins = []
    const legKeys = WALK_LEGS
    let legIdx = 0
    let down = null
    const captureDeadline = Date.now() + CAPTURE_MS
    const sampleLoop = async () => {
      while (Date.now() < captureDeadline) {
        const t0 = Date.now()
        const m = await page._send('Performance.getMetrics').catch(() => null)
        const mem = await evaluateWithDeadline(page, () => window.__ltProbe.mem(), 4000).catch(() => null)
        // The contention spin is real CPU work, so it is sampled every fourth tick: a spin on every
        // tick would make this witness the load it is trying to detect.
        const spin = metrics.length % 4 === 0 ? spinMs(1) : null
        const cpu = sampleHostCpu()
        metrics.push({ nodeAt: t0, mem, spin, cpu, metrics: m ? m.metrics : null })
        if (spin !== null) spins.push(spin)
        const sleep = METRICS_INTERVAL_MS - (Date.now() - t0)
        await new Promise((r) => setTimeout(r, Math.max(0, sleep)))
      }
    }
    const walkLoop = async () => {
      while (Date.now() < captureDeadline) {
        const key = legKeys[legIdx % legKeys.length]
        if (down === null || Date.now() - down.t > LEG_MS) {
          if (down) await page.keyboard.up(down.key).catch(() => {})
          await page.keyboard.down(key).catch(() => {})
          down = { key, t: Date.now() }
          legIdx += 1
        }
        await new Promise((r) => setTimeout(r, 250))
      }
      if (down) await page.keyboard.up(down.key).catch(() => {})
    }
    console.log('[longtask-stack] capturing ' + CAPTURE_MS + 'ms of walking (' + legKeys.join(',') + ') ...')
    // A CDP send that never resolves hangs the capture and the whole run with it: the sampler talks
    // to a page whose main thread is exactly what is being measured. The capture therefore races a
    // hard deadline, so a stalled send costs the sample instead of the measurement.
    const captureWatchdog = new Promise((_, reject) => setTimeout(() => reject(new Error('the capture did not finish within ' + CAPTURE_TIMEOUT_MS + 'ms')), CAPTURE_TIMEOUT_MS))
    await Promise.race([Promise.all([sampleLoop(), walkLoop()]), captureWatchdog])

    const pageT1 = await evaluateWithDeadline(page, () => window.__ltProbe.mark(), 60000)
    const nodeT1 = Date.now()
    const cpu1 = sampleHostCpu()
    const { profile } = await Promise.race([
      page._send('Profiler.stop'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Profiler.stop did not answer within 120000ms')), 120000)),
    ])
    const final = await evaluateWithDeadline(page, () => {
      const pick = (fn) => { try { return fn() } catch (_) { return null } }
      const W = window
      return {
        longtasks: W.__ltProbe.longtasks.slice(),
        raf: W.__ltProbe.raf.slice(),
        frames: W.__ltProbe.frames.slice(),
        units: {
          vegProfile: W.__vegProfile || null,
          grassProfile: W.__grassProfile || null,
          rocksProfile: W.__rocksProfile || null,
          shadowCost: pick(() => (W.__shadowCost && typeof W.__shadowCost.stats === 'function' ? W.__shadowCost.stats() : null)),
          shadowPipeline: pick(() => (W.__shadowPipeline && typeof W.__shadowPipeline.debug === 'function' ? W.__shadowPipeline.debug() : null)),
          cascadeShadowSelect: W.__cascadeShadowSelectTSL || null,
          terrain: pick(() => (W.__terrain && typeof W.__terrain.debug === 'function' ? W.__terrain.debug() : null)),
          contactOcclusionDrive: W.__contactOcclusionDrive || null,
          camRayCasts: W.__camRayCasts || null,
          webgpuCullingProbe: pick(() => (W.__webgpuCullingProbe && typeof W.__webgpuCullingProbe.stats === 'function' ? W.__webgpuCullingProbe.stats() : null)),
          rendererInfo: W.__rendererInfo || null,
          shadowCascades: W.__shadowCascades || null,
        },
      }
    }, 120000)
    browser.close().catch(() => {})

    const nodeSpanMs = nodeT1 - nodeT0
    const cpuPct = hostCpuPct(cpu0, cpu1)
    const spinPeak = Math.max(cleanSpin, ...spins)
    const spinRatio = Math.round((spinPeak / cleanSpin) * 100) / 100

    // --- window the profile -------------------------------------------------------------------
    const prof = buildProfile(profile)
    const profSpanMs = prof.spanUs / 1000
    const clockErrorPct = Math.round((Math.abs(profSpanMs - nodeSpanMs) / nodeSpanMs) * 1000) / 10
    const mark0 = mark.lt
    const tasks = final.longtasks.slice(mark0).filter((t) => t.duration >= LONG_TASK_MS)
    const frames = final.frames.filter((f) => f.at >= pageT0 && f.at <= pageT1)
    const rafIn = final.raf.filter((r) => r.start >= pageT0 && r.start <= pageT1)
    const rafSorted = rafIn.map((r) => r.dur).sort((a, b) => a - b)
    const frameSorted = frames.map((f) => f.dt).sort((a, b) => a - b)

    // Map page-clock ms onto profile microseconds. The profile spans the same wall interval the
    // capture did; the sanity check below is what makes that claim auditable rather than assumed.
    // Main-thread CPU time is the discriminator that a CPU profile alone cannot give. A 920 ms wall
    // window in which ThreadTime advanced 100 ms is a thread that did not execute for 820 ms --
    // descheduled, which is what contention looks like -- and no amount of stack aggregation turns
    // that into a named stall. ThreadTime is sampled from CDP Performance.getMetrics every
    // METRICS_INTERVAL_MS, so it is the only per-window CPU measure that is independent of the
    // profiler's own sampling.
    function metricsOf(entry, name) {
      const list = entry && entry.metrics ? entry.metrics : null
      if (!list) return null
      for (const m of list) if (m.name === name) return m.value
      return null
    }
    const threadTimeline = []
    const heapTimeline = []
    for (const e of metrics) {
      const th = metricsOf(e, 'ThreadTime')
      const hp = metricsOf(e, 'JSHeapUsedSize')
      const pageMs = pageT0 + ((e.nodeAt - nodeT0) / (nodeT1 - nodeT0)) * (pageT1 - pageT0)
      if (th !== null) threadTimeline.push({ pageMs, v: th * 1000 })
      if (hp !== null) heapTimeline.push({ pageMs, v: hp })
    }
    const interpAt = (tl, pageMs) => {
      if (tl.length === 0) return null
      if (pageMs <= tl[0].pageMs) return tl[0].v
      if (pageMs >= tl[tl.length - 1].pageMs) return tl[tl.length - 1].v
      for (let i = 1; i < tl.length; i++) {
        if (tl[i].pageMs >= pageMs) {
          const a = tl[i - 1]
          const b = tl[i]
          const f = (pageMs - a.pageMs) / (b.pageMs - a.pageMs)
          return a.v + f * (b.v - a.v)
        }
      }
      return null
    }
    console.log('[longtask-stack] ThreadTime timeline: ' + threadTimeline.length + ' sample(s), heap timeline ' + heapTimeline.length + ' sample(s)')

    const toProfUs = (pageMs) => ((pageMs - pageT0) / (pageT1 - pageT0)) * prof.spanUs

    console.log('[longtask-stack] profile: ' + prof.timeline.length + ' sample(s) over ' + profSpanMs.toFixed(0) + 'ms, node-side span ' + nodeSpanMs + 'ms (clock skew ' + clockErrorPct + '%)')
    console.log('[longtask-stack] host: cpu ' + cpuPct + '% busy, spin ' + cleanSpin + ' -> peak ' + spinPeak + 'ms (x' + spinRatio + ')')
    console.log('[longtask-stack] frames: n=' + frames.length + ' p50=' + percentile(frameSorted, 0.5).toFixed(2) + 'ms p95=' + percentile(frameSorted, 0.95).toFixed(2) + 'ms max=' + (frameSorted[frameSorted.length - 1] || 0).toFixed(2) + 'ms')
    console.log('[longtask-stack] frame-loop callbacks: n=' + rafIn.length + ' p50=' + percentile(rafSorted, 0.5).toFixed(2) + 'ms p95=' + percentile(rafSorted, 0.95).toFixed(2) + 'ms max=' + (rafSorted[rafSorted.length - 1] || 0).toFixed(2) + 'ms')
    const drawCalls = rafIn.map((r) => r.calls).filter((v) => typeof v === 'number').sort((a, b) => a - b)
    const tris = rafIn.map((r) => r.tris).filter((v) => typeof v === 'number').sort((a, b) => a - b)
    if (drawCalls.length > 0) console.log('[longtask-stack] counted units per frame: draws p50=' + percentile(drawCalls, 0.5) + ' p95=' + percentile(drawCalls, 0.95) + ' max=' + drawCalls[drawCalls.length - 1] + ' (n=' + drawCalls.length + ')')
    if (tris.length > 0) console.log('[longtask-stack] counted units per frame: triangles p50=' + percentile(tris, 0.5) + ' p95=' + percentile(tris, 0.95) + ' max=' + tris[tris.length - 1])
    const u = final.units || {}
    if (u.vegProfile) console.log('[longtask-stack] veg: ' + JSON.stringify({ totalInstances: u.vegProfile.totalInstances, species: u.vegProfile.species, meshTierInstances: u.vegProfile.meshTierInstances, leafTierInstances: u.vegProfile.leafTierInstances, vegDrawCalls: u.vegProfile.vegDrawCalls, bvhRebuilds: u.vegProfile.bvhRebuilds, impostors: u.vegProfile.impostors }))
    if (u.grassProfile) console.log('[longtask-stack] grass: ' + JSON.stringify({ instances: u.grassProfile.instances, draws: u.grassProfile.draws, tiles: u.grassProfile.tiles, loadChunkMs: u.grassProfile.loadChunkMs }))
    if (u.rocksProfile) console.log('[longtask-stack] rocks: ' + JSON.stringify({ instances: u.rocksProfile.instances, draws: u.rocksProfile.draws, tiles: u.rocksProfile.tiles }))
    if (u.shadowCost) console.log('[longtask-stack] shadow cost: ' + JSON.stringify(u.shadowCost).slice(0, 600))
    if (u.shadowPipeline) console.log('[longtask-stack] shadow pipeline: ' + JSON.stringify(u.shadowPipeline).slice(0, 600))
    if (u.shadowCascades) console.log('[longtask-stack] shadow cascades: ' + JSON.stringify(u.shadowCascades).slice(0, 400))
    if (u.contactOcclusionDrive) console.log('[longtask-stack] contact occlusion: ' + JSON.stringify(u.contactOcclusionDrive))
    if (u.camRayCasts) console.log('[longtask-stack] camera ray casts: ' + JSON.stringify(u.camRayCasts).slice(0, 300))
    console.log('[longtask-stack] long tasks >= ' + LONG_TASK_MS + 'ms during capture: ' + tasks.length)

    const report = []
    for (const t of tasks.slice().sort((a, b) => b.duration - a.duration).slice(0, 8)) {
      const fromUs = toProfUs(t.start)
      const toUs = toProfUs(t.start + t.duration)
      const slice = sliceWindow(prof, fromUs, toUs)
      const agg = aggregate(prof, slice)
      const sampledUs = slice.reduce((s, x) => s + x.dt, 0)
      const buckets = {}
      for (const s of slice) {
        const b = bucketOf(prof, s.node)
        buckets[b] = (buckets[b] || 0) + s.dt
      }
      const rafInside = rafIn.filter((r) => r.start >= t.start && r.start + r.dur <= t.start + t.duration)
      const rafMs = rafInside.reduce((s, r) => s + r.dur, 0)
      const thStart = interpAt(threadTimeline, t.start)
      const thEnd = interpAt(threadTimeline, t.start + t.duration)
      const threadMs = thStart === null || thEnd === null ? null : Math.round((thEnd - thStart) * 100) / 100
      const heapBefore = interpAt(heapTimeline, t.start)
      const heapAfter = interpAt(heapTimeline, t.start + t.duration)
      const heapDropMb = heapBefore === null || heapAfter === null ? null : Math.round(((heapAfter - heapBefore) / 1048576) * 100) / 100
      const top = [...agg.self.entries()]
        .filter(([id]) => bucketOf(prof, id) === 'js')
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP_STACKS)
        .map(([id, us]) => ({ selfMs: Math.round((us / 1000) * 100) / 100, stack: pathOf(prof, id).slice(-8).join(' <- ') }))
      const bucketRank = Object.entries(buckets).sort((a, b) => b[1] - a[1])
      const jsMs = Math.round(((buckets.js || 0) / 1000) * 100) / 100
      const gcMs = Math.round(((buckets['garbage collector'] || 0) / 1000) * 100) / 100
      let verdict
      if (threadMs !== null && threadMs < t.duration * 0.35) {
        verdict = 'WALL-DOMINATED: the main thread executed ~' + threadMs + 'ms of the ' + row.durationMs + 'ms, so ' + Math.round(t.duration - threadMs) + 'ms is time the thread did not run (descheduled or blocked) -- this is what host contention looks like, and it is not a named stall'
      } else if (gcMs > jsMs && gcMs > t.duration * 0.35) {
        verdict = 'CPU-BOUND IN GC: ' + gcMs + 'ms of garbage collector against ' + jsMs + 'ms of JS'
      } else if (top.length > 0 && jsMs > t.duration * 0.35) {
        verdict = 'CPU-BOUND IN JS: ' + jsMs + 'ms of JS, hottest frame ' + (top[0].stack.split(' <- ').pop() || 'unknown')
      } else {
        verdict = 'UNRESOLVED: ' + row.sampledMs + 'ms accounted of ' + row.durationMs + 'ms wall; the profile did not see enough of the window to name it'
      }
      const row = {
        verdict,
        durationMs: Math.round(t.duration * 100) / 100,
        startMs: Math.round(t.start),
        container: t.containerName || t.containerType || null,
        scriptUrl: t.scriptUrl || null,
        samples: slice.length,
        sampledMs: Math.round((sampledUs / 1000) * 100) / 100,
        bucketMs: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, Math.round((v / 1000) * 100) / 100])),
        rafMsInside: Math.round(rafMs * 100) / 100,
        threadMsInside: threadMs,
        heapDropMb,
        bucketRank: bucketRank.map(([k, v]) => [k, Math.round((v / 1000) * 100) / 100]),
        topStacks: top,
      }
      report.push(row)
      console.log('[longtask-stack]   VERDICT: ' + verdict)
      console.log('[longtask-stack] TASK ' + row.durationMs + 'ms wall at t=' + row.startMs + 'ms: main-thread CPU inside ' + row.threadMsInside + 'ms, ' + row.samples + ' profile sample(s) = ' + row.sampledMs + 'ms accounted ' + JSON.stringify(row.bucketMs) + ', frame-loop callbacks inside ' + row.rafMsInside + 'ms, heap delta ' + row.heapDropMb + 'MB' + (row.container ? ', container=' + row.container : '') + (row.scriptUrl ? ', script=' + row.scriptUrl : ''))
      for (const s of row.topStacks) console.log('[longtask-stack]   ' + s.selfMs + 'ms ' + s.stack)
    }

    mkdirSync(OUT_DIR, { recursive: true })
    const outFile = resolve(OUT_DIR, 'longtask-stack-' + Date.now() + '.json')
    writeFileSync(outFile, JSON.stringify({
      vendor: VENDOR, world: WORLD, port: PORT, captureMs: CAPTURE_MS, sampleUs: SAMPLE_US,
      gpu: { rasterizer: gpu.rasterizer, renderer: gpu.renderer, backend: gpu.backend },
      profSpanMs, nodeSpanMs, clockErrorPct,
      host: { cpuPct, cleanSpin, spinPeak, spinRatio },
      frames: { n: frames.length, p50: percentile(frameSorted, 0.5), p95: percentile(frameSorted, 0.95), max: frameSorted[frameSorted.length - 1] || 0 },
      raf: { n: rafIn.length, p50: percentile(rafSorted, 0.5), p95: percentile(rafSorted, 0.95), max: rafSorted[rafSorted.length - 1] || 0 },
      metrics, tasks: report, units: final.units || null,
      countedUnitsPerFrame: {
        draws: drawCalls.length ? { n: drawCalls.length, p50: percentile(drawCalls, 0.5), p95: percentile(drawCalls, 0.95), max: drawCalls[drawCalls.length - 1] } : null,
        triangles: tris.length ? { n: tris.length, p50: percentile(tris, 0.5), p95: percentile(tris, 0.95), max: tris[tris.length - 1] } : null,
      },
    }, null, 2))
    console.log('[longtask-stack] wrote ' + outFile)

    const failures = []
    if (clockErrorPct > 5) failures.push('the profile span and the node-side capture span disagree by ' + clockErrorPct + '%, so the long-task windows cannot be placed on the sample timeline')
    if (frames.length < MIN_FRAMES) failures.push('only ' + frames.length + ' frame(s) presented, under the ' + MIN_FRAMES + ' a frame verdict needs')
    if (MODE === 'gate' && tasks.length > 0) failures.push(tasks.length + ' long task(s) >= ' + LONG_TASK_MS + 'ms remain unattributed by name')
    if (failures.length) {
      console.error('[longtask-stack] RESULT: FAIL -- ' + failures.join('; '))
      process.exit(1)
    }
    console.log('[longtask-stack] RESULT: PASS -- ' + tasks.length + ' long task(s) >= ' + LONG_TASK_MS + 'ms over ' + frames.length + ' frame(s), worst frame ' + (frameSorted[frameSorted.length - 1] || 0).toFixed(2) + 'ms')
    process.exit(0)
  } finally {
    try { if (browser) await browser.close() } catch (_) {}
    try { if (server && server.stop) await server.stop() } catch (_) {}
  }
}

main().catch((e) => {
  console.error('[longtask-stack] ' + (e && e.message ? e.message : e))
  process.exit(1)
})
