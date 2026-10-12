#!/usr/bin/env node
// Live census of PlanetFrame.groundHeightLocal on a real client: WHO asks, how often, how much
// wall time, and how much of the work is the same point (or a near point) another caller already
// paid for. Read-only with respect to terrain: it wraps the frame's ground source and never
// changes a returned height.
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, DEFAULT_VIEWPORT } from './lib/cdp-browser.mjs'
import { assertGpu } from './lib/gpu-probe.mjs'
import { vendorLaunchArgs } from './lib/witness-gpu.mjs'
import { exitAfterQuiesce } from './lib/quiesce.mjs'
import { flagNumber } from './lib/witness-args.mjs'

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

const DEEP_SECONDS = flagNumber(flag, 'deep-seconds', 30, argv)
const CLEAN_SECONDS = flagNumber(flag, 'clean-seconds', 20, argv)
const WARMUP_MS = flagNumber(flag, 'warmup', 10000, argv)
const WORLD = String(flag('world', 'tps-game'))
const GPU = String(flag('gpu', 'nvidia'))
const STACK_STRIDE = Math.max(1, Math.round(flagNumber(flag, 'stack-stride', 4, argv)))

const MIN_FRAMES = 300
const MIN_MOVED_M = 5
const MAX_BUCKETS = 40

const failures = []
const measurements = []
function expect(name, got, predicate) {
  measurements.push(name)
  let ok = false
  try { ok = Boolean(predicate(got)) } catch { ok = false }
  if (!ok) failures.push(`${name}=${JSON.stringify(got)}`)
  return got
}
const finite = (v) => Number.isFinite(v)

// The census runs in the page. `deep` costs a stack capture every STACK_STRIDE calls plus six
// quantised-key set lookups per call; `clean` costs two performance.now() reads per call and
// nothing else, so the wall-time number the fix is judged against comes from the clean window.
const CENSUS_SRC = `(() => {
  const W = window
  const t = W.__terrain
  if (!t || !t.frame) return { error: 'no window.__terrain.frame' }
  const f = t.frame
  const orig = f.groundHeightLocal
  if (typeof orig !== 'function') return { error: 'frame.groundHeightLocal is not a function' }
  // The instrument must be invisible to everything that branches on the frame's ground source.
  // Assigning frame.groundHeightLocal runs its setter, which installs the wrapper under the name
  // 'substituted'; PlacementChart.surfaceAlongDir branches on groundSource === 'cpu-solve' and
  // takes a 16-iteration ground loop otherwise, so that assignment manufactures most of the
  // traffic it then measures. Install under the name the frame already reports instead.
  const srcAtArm = f.groundSource
  const sourcesAtArm = Array.isArray(f.groundSources) ? f.groundSources.slice() : null
  const QUANTA = [0, 0.001, 0.01, 0.05, 0.25, 1]
  const SPREAD_Q = [0.05, 0.25, 1]
  const STRIDE = ${STACK_STRIDE}
  const st = {
    calls: 0, ms: 0, t0: 0, frames0: 0,
    perFrame: [], _lastFrameCalls: 0,
    stackSamples: 0, buckets: {},
    quanta: {}, spread: {},
    immediateRepeat: 0, crossCallerExactDup: 0,
    lastX: NaN, lastZ: NaN,
    deep: true,
  }
  for (const q of QUANTA) st.quanta[q] = { asked: 0, distinct: 0, set: new Set(), owner: new Map() }
  for (const q of SPREAD_Q) st.spread[q] = { map: new Map(), maxAbsDiffM: 0, pairs: 0, capped: false }
  W.__census = st

  const bucketOf = (stack) => {
    const lines = String(stack || '').split('\\n').slice(2, 9)
    const kept = []
    for (const l of lines) {
      const s = l.trim().replace(/https?:\\/\\/[^/]+\\//g, '/').replace(/^at\\s+/, '')
      if (!s) continue
      const sp = s.indexOf(' ')
      if (sp > 0) kept.push(s.slice(0, sp))
      else kept.push(s.slice(0, 60))
    }
    return kept.join(' <- ').slice(0, 240) || 'unknown'
  }

  f.groundHeightLocal = function (x, z, yGuess) {
    const at = performance.now()
    let h = NaN
    let err = null
    try { h = orig.call(this, x, z, yGuess) } catch (e) { err = e }
    const dt = performance.now() - at
    st.calls++
    st.ms += dt
    if (st.deep && !err) {
      if (x === st.lastX && z === st.lastZ) st.immediateRepeat++
      st.lastX = x; st.lastZ = z
      let site = null
      if ((st.calls % STRIDE) === 0) {
        st.stackSamples++
        site = bucketOf(new Error().stack)
        if (!(site in st.buckets) && Object.keys(st.buckets).length >= ${MAX_BUCKETS}) site = '<folded>'
        st.buckets[site] = (st.buckets[site] || 0) + 1
      }
      for (const q of QUANTA) {
        const rec = st.quanta[q]
        rec.asked++
        const k = q === 0 ? (x + ':' + z) : (Math.round(x / q) + ':' + Math.round(z / q))
        if (rec.set.has(k)) {
          if (q === 0 && site !== null) {
            const first = rec.owner.get(k)
            if (first !== undefined && first !== site) st.crossCallerExactDup++
          }
        } else {
          rec.set.add(k); rec.distinct++; rec.owner.set(k, site === null ? bucketKey : site)
        }
      }
      for (const q of SPREAD_Q) {
        const rec = st.spread[q]
        const k = Math.round(x / q) + ':' + Math.round(z / q)
        const prev = rec.map.get(k)
        if (prev === undefined) {
          if (rec.map.size < 400000) rec.map.set(k, h)
          else rec.capped = true
        } else {
          rec.pairs++
          const d = Math.abs(h - prev)
          if (d > rec.maxAbsDiffM) rec.maxAbsDiffM = d
        }
      }
    }
    if (err) throw err
    return h
  }
  let bucketKey = 'unsampled'
  const installedName = f.registerGroundSource(srcAtArm, f.groundHeightLocal)
  const transparent = f.groundSource === srcAtArm && typeof f.groundHeightLocal === 'function'
  st.t0 = performance.now()
  return { ok: true, quanta: QUANTA, stride: STRIDE, groundSourceAtArm: srcAtArm, sourcesAtArm, installedName, transparent }
})()`

function beginFrameCounter() {
  const st = window.__census
  window.__frames = 0
  st._lastFrameCalls = st.calls
  st.perFrame.length = 0
  const tick = () => {
    window.__frames++
    st.perFrame.push(st.calls - st._lastFrameCalls)
    st._lastFrameCalls = st.calls
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  return true
}

function resetWindow(deep) {
  const st = window.__census
  st.calls = 0
  st.ms = 0
  st.t0 = performance.now()
  st.deep = !!deep
  st.frames0 = window.__frames || 0
  st.perFrame.length = 0
  st._lastFrameCalls = st.calls
  return true
}

function readPredEngine() {
  const c = window.__client
  if (!c) return { error: 'no window.__client' }
  let pe = null
  try { if (typeof c.getPredEngine === 'function') pe = c.getPredEngine() } catch (e) { pe = null }
  if (!pe) {
    const mh = c._msgHandler || c.msgHandler || null
    try { if (mh && typeof mh.getPredEngine === 'function') pe = mh.getPredEngine() } catch (e) { pe = null }
  }
  if (!pe) return { error: 'no prediction engine reachable from window.__client' }
  return {
    ok: true,
    stats: JSON.parse(JSON.stringify(pe.stats || {})),
    inputHistoryLength: pe.inputHistory ? pe.inputHistory.length : null,
    inputHistoryCapacity: pe.inputHistory ? pe.inputHistory.capacity : null,
    tickRate: pe.tickRate,
    dilation: pe.dilation,
    leadSteps: typeof pe.predictionLeadSteps === 'function' ? pe.predictionLeadSteps() : null,
    hasServerState: !!pe._hasServerState,
    groundSourceInstalled: pe._surface ? true : false,
    surfaceOn: pe._surface ? pe._surface.onSurface : null,
    standOffset: pe._surface ? pe._surface.standOffset : null,
  }
}

function readWindow(deep) {
  const st = window.__census
  if (!st) return { error: 'no census' }
  const frames = Math.max(0, (window.__frames || 0) - st.frames0)
  const pf = st.perFrame.slice().sort((a, b) => a - b)
  const q = (p) => (pf.length ? pf[Math.min(pf.length - 1, Math.floor(pf.length * p))] : 0)
  const buckets = Object.entries(st.buckets).sort((a, b) => b[1] - a[1]).slice(0, 10)
  const quanta = {}
  for (const k of Object.keys(st.quanta)) {
    const rec = st.quanta[k]
    quanta[k] = { asked: rec.asked, distinct: rec.distinct, dedupablePct: rec.asked ? Math.round((1 - rec.distinct / rec.asked) * 10000) / 100 : null }
  }
  return {
    elapsedMs: Math.round(performance.now() - st.t0),
    calls: st.calls,
    ms: Math.round(st.ms * 100) / 100,
    frames,
    callsPerFrame_p50: q(0.5),
    callsPerFrame_p95: q(0.95),
    callsPerFrame_max: pf.length ? pf[pf.length - 1] : 0,
    stackSamples: st.stackSamples,
    buckets,
    quanta,
    spread: (() => {
      const out = {}
      for (const k of Object.keys(st.spread)) {
        const rec = st.spread[k]
        out[k] = { pairs: rec.pairs, maxAbsDiffM: Math.round(rec.maxAbsDiffM * 1000000) / 1000000, capped: rec.capped }
      }
      return out
    })(),
    immediateRepeat: st.immediateRepeat,
    crossCallerExactDup: st.crossCallerExactDup,
    deep: !!deep,
    groundSource: (window.__terrain && window.__terrain.frame) ? window.__terrain.frame.groundSource : null,
    chartEpoch: (window.__terrain && window.__terrain.frame) ? window.__terrain.frame.chartEpoch : null,
    rendererInfo: window.__rendererInfo || null,
  }
}

async function readModule() {
  const mod = await import('/src/terrain/PlanetFrame.js')
  mod.resetGroundMemoStats()
  mod.resetSurfaceSolveStats()
  return { armed: true }
}

async function readModuleStats() {
  const mod = await import('/src/terrain/PlanetFrame.js')
  return { memo: mod.groundMemoStats(), solve: mod.surfaceSolveStats() }
}

async function main() {
  const port = String(20000 + Math.floor(Math.random() * 20000))
  process.env.WORLD = process.env.WORLD || WORLD
  process.env.PORT = port
  process.env.SPOINT_NO_WATCH = '1'
  const { boot } = await import(pathToFileURL(resolve(ROOT, 'src', 'sdk', 'server.js')).href)
  const server = await boot()
  console.log(`[ground-census] server up on ${port} world=${process.env.WORLD}`)

  const browser = await chromium.launch({ headless: false, args: [...vendorLaunchArgs(GPU)] })
  try {
    const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT })
    page.on('pageerror', (e) => console.log('[ground-census] pageerror: ' + String((e && e.message) || e).slice(0, 300)))
    const url = `http://127.0.0.1:${port}/?multiplayer&world=${WORLD}&v=${Date.now()}`
    console.log('[ground-census] navigating ' + url)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })

    const bootStart = Date.now()
    let ready = false
    let lastLog = 0
    while (Date.now() - bootStart < 180000) {
      const r = await page.evaluate(() => ({
        terrain: !!(window.__terrain && window.__terrain.frame),
        revealedAt: (window.__app && window.__app.revealedAt) || 0,
        connected: !!(window.__client && window.__client.connected),
      })).catch(() => null)
      if (r && r.terrain && r.revealedAt && r.connected) { ready = true; break }
      if (Date.now() - lastLog > 15000) { lastLog = Date.now(); console.log(`[ground-census] boot t+${Math.round((Date.now() - bootStart) / 1000)}s ${JSON.stringify(r)}`) }
      await new Promise((r2) => setTimeout(r2, 1000))
    }
    if (!ready) throw new Error('page never reached terrain+revealedAt')
    console.log(`[ground-census] boot ok in ${Math.round((Date.now() - bootStart) / 1000)}s`)

    const gpu = await assertGpu(page, { requireAccelerated: true, expectVendor: GPU })
    console.log(`[ground-census] gpu=${GPU} accelerated=${gpu.accelerated} rasterizer=${gpu.rasterizer} renderer=${gpu.renderer || 'none'}`)
    if (gpu.accelerated !== true) throw new Error('gpu arm not accelerated: ' + JSON.stringify(gpu))
    const ri = await page.evaluate(() => window.__rendererInfo || null)
    console.log('[ground-census] window.__rendererInfo=' + JSON.stringify(ri))
    if (!ri) throw new Error('window.__rendererInfo absent: the adapter this arm ran on is unproven')

    const armed = await page.evaluate(CENSUS_SRC)
    console.log('[ground-census] armed: ' + JSON.stringify(armed))
    if (!armed || !armed.ok) throw new Error('arm failed: ' + JSON.stringify(armed))
    if (armed.transparent !== true) throw new Error('the instrument changed the frame ground source (' + armed.groundSourceAtArm + ' -> ' + armed.installedName + '); this census would then be measuring its own artifact')
    expect('instrumentTransparent', armed.transparent, (v) => v === true)
    await page.evaluate(beginFrameCounter)
    await page.evaluate(readModule)

    const posStart = await page.evaluate(() => {
      const cls = (window.__client && window.__client.getLocalState) ? window.__client.getLocalState() : null
      const v = cls && cls.position
      return v ? [v[0], v[1], v[2]] : null
    })
    await page.keyboard.down('KeyW').catch(() => {})
    await new Promise((r) => setTimeout(r, WARMUP_MS))

    // Deep window: attribution + dedup geometry. Stack and set work is on, so its own ms is
    // inflated and is never reported as the cost of the sampler.
    await page.evaluate(resetWindow, true)
    let walkStart = Date.now()
    let turn = 0
    while (Date.now() - walkStart < DEEP_SECONDS * 1000) {
      await new Promise((r) => setTimeout(r, 2500))
      const key = (turn++ % 2 === 0) ? 'KeyA' : 'KeyD'
      await page.keyboard.down(key).catch(() => {})
      await new Promise((r) => setTimeout(r, 400))
      await page.keyboard.up(key).catch(() => {})
    }
    const deep = await page.evaluate(readWindow, true)
    const pred = await page.evaluate(readPredEngine)
    const modDeep = await page.evaluate(readModuleStats)
    console.log('[ground-census] deep: ' + JSON.stringify(deep, null, 2))
    console.log('[ground-census] predEngine: ' + JSON.stringify(pred))
    console.log('[ground-census] module(deep): ' + JSON.stringify(modDeep))
    if (deep.error) throw new Error('deep read failed: ' + deep.error)

    // Clean window: only the two performance.now() reads per call, so ms/frame is the number
    // before/after is judged on.
    await page.evaluate(resetWindow, false)
    walkStart = Date.now()
    turn = 0
    while (Date.now() - walkStart < CLEAN_SECONDS * 1000) {
      await new Promise((r) => setTimeout(r, 2500))
      const key = (turn++ % 2 === 0) ? 'KeyA' : 'KeyD'
      await page.keyboard.down(key).catch(() => {})
      await new Promise((r) => setTimeout(r, 400))
      await page.keyboard.up(key).catch(() => {})
    }
    await page.keyboard.up('KeyW').catch(() => {})
    const clean = await page.evaluate(readWindow, false)
    const modClean = await page.evaluate(readModuleStats)
    console.log('[ground-census] clean: ' + JSON.stringify(clean, null, 2))
    console.log('[ground-census] module(clean): ' + JSON.stringify(modClean))
    if (clean.error) throw new Error('clean read failed: ' + clean.error)

    const posEnd = await page.evaluate(() => {
      const cls = (window.__client && window.__client.getLocalState) ? window.__client.getLocalState() : null
      const v = cls && cls.position
      return v ? [v[0], v[1], v[2]] : null
    })
    const moved = (posStart && posEnd) ? Math.round(Math.hypot(posEnd[0] - posStart[0], posEnd[1] - posStart[1], posEnd[2] - posStart[2]) * 100) / 100 : null
    const per = (n, f) => Math.round((n / f) * 10000) / 10000
    const memo = modClean.memo
    const totalMemo = memo.hits + memo.misses

    const report = {
      gpuArm: expect('gpuArm', gpu.accelerated === true, (v) => v === true),
      rendererInfoPinned: expect('rendererInfoPinned', ri ? String(ri.renderer || ri.vendor || 'set') : null, (v) => typeof v === 'string' && v.length > 0),
      groundSource: expect('groundSource', clean.groundSource, (v) => typeof v === 'string' && v.length > 0),
      chartEpoch: expect('chartEpoch', clean.chartEpoch, (v) => Number.isFinite(v) && v >= 0),
      playerMovedM: expect('playerMovedM', moved, (v) => Number.isFinite(v) && v >= MIN_MOVED_M),
      deep_frames: expect('deep_frames', deep.frames, (v) => v >= MIN_FRAMES),
      clean_frames: expect('clean_frames', clean.frames, (v) => v >= MIN_FRAMES),
      clean_callsPerFrame: expect('clean_callsPerFrame', per(clean.calls, clean.frames), (v) => finite(v) && v > 0),
      clean_callsPerFrame_p50: expect('clean_callsPerFrame_p50', clean.callsPerFrame_p50, (v) => Number.isFinite(v) && v >= 0),
      clean_callsPerFrame_p95: expect('clean_callsPerFrame_p95', clean.callsPerFrame_p95, (v) => Number.isFinite(v) && v > 0),
      clean_callsPerFrame_max: expect('clean_callsPerFrame_max', clean.callsPerFrame_max, (v) => Number.isFinite(v) && v > 0),
      clean_msPerFrame: expect('clean_msPerFrame', Math.round((clean.ms / clean.frames) * 10000) / 10000, (v) => finite(v) && v > 0),
      clean_usPerCall: expect('clean_usPerCall', Math.round((clean.ms * 1000 / clean.calls) * 100) / 100, (v) => finite(v) && v > 0),
      memo_hitRatePct: expect('memo_hitRatePct', totalMemo ? Math.round((memo.hits / totalMemo) * 10000) / 100 : null, (v) => Number.isFinite(v) && v >= 0 && v <= 100),
      memo_epochStale: expect('memo_epochStale', memo.epochStale, (v) => Number.isFinite(v)),
      memo_evictions: expect('memo_evictions', memo.evictions, (v) => Number.isFinite(v)),
      memo_cellCollisions: expect('memo_cellCollisions', memo.cellCollisions, (v) => Number.isFinite(v)),
      solve_evalsPerSolve: expect('solve_evalsPerSolve', modClean.solve.solves ? Math.round((modClean.solve.evaluations / modClean.solve.solves) * 100) / 100 : null, (v) => Number.isFinite(v) && v > 0 && v <= 64),
      dedupablePct_exact: expect('dedupablePct_exact', deep.quanta['0'].dedupablePct, (v) => Number.isFinite(v) && v >= 0 && v <= 100),
      dedupablePct_1mm: expect('dedupablePct_1mm', deep.quanta['0.001'].dedupablePct, (v) => Number.isFinite(v) && v >= 0 && v <= 100),
      dedupablePct_1cm: expect('dedupablePct_1cm', deep.quanta['0.01'].dedupablePct, (v) => Number.isFinite(v) && v >= 0 && v <= 100),
      dedupablePct_5cm: expect('dedupablePct_5cm', deep.quanta['0.05'].dedupablePct, (v) => Number.isFinite(v) && v >= 0 && v <= 100),
      dedupablePct_25cm: expect('dedupablePct_25cm', deep.quanta['0.25'].dedupablePct, (v) => Number.isFinite(v) && v >= 0 && v <= 100),
      dedupablePct_1m: expect('dedupablePct_1m', deep.quanta['1'].dedupablePct, (v) => Number.isFinite(v) && v >= 0 && v <= 100),
      immediateRepeatPct: expect('immediateRepeatPct', Math.round((deep.immediateRepeat / deep.calls) * 10000) / 100, (v) => Number.isFinite(v) && v >= 0 && v <= 100),
      spread_5cm_maxAbsDiffM: expect('spread_5cm_maxAbsDiffM', deep.spread['0.05'].maxAbsDiffM, (v) => Number.isFinite(v) && v >= 0),
      spread_25cm_maxAbsDiffM: expect('spread_25cm_maxAbsDiffM', deep.spread['0.25'].maxAbsDiffM, (v) => Number.isFinite(v) && v >= 0),
      spread_1m_maxAbsDiffM: expect('spread_1m_maxAbsDiffM', deep.spread['1'].maxAbsDiffM, (v) => Number.isFinite(v) && v >= 0),
      crossCallerExactDupPct: expect('crossCallerExactDupPct', Math.round((deep.crossCallerExactDup / deep.calls) * 10000) / 100, (v) => Number.isFinite(v) && v >= 0 && v <= 100),
      stackSamples: expect('stackSamples', deep.stackSamples, (v) => Number.isFinite(v) && v > 0),
      topCallerSharePct: expect('topCallerSharePct', deep.buckets.length ? Math.round((deep.buckets[0][1] / deep.stackSamples) * 10000) / 100 : null, (v) => Number.isFinite(v) && v > 0 && v <= 100),
      predEngine_inputHistoryLength: expect('predEngine_inputHistoryLength', pred.inputHistoryLength, (v) => v === null || (Number.isFinite(v) && v >= 0)),
      predEngine_acks: expect('predEngine_acks', pred.stats ? pred.stats.acks : null, (v) => v === null || (Number.isFinite(v) && v >= 0)),
      predEngine_corrections: expect('predEngine_corrections', pred.stats ? pred.stats.corrections : null, (v) => v === null || (Number.isFinite(v) && v >= 0)),
    }
    console.log('[ground-census] measurements ' + JSON.stringify(report, null, 2))
    console.log('[ground-census] top callers (of ' + deep.stackSamples + ' sampled stacks):')
    for (const [b, n] of deep.buckets) console.log('  ' + String(n).padStart(6) + '  ' + b)
    for (const f of failures) console.log(`FAIL: ${f}`)
    if (failures.length) console.log(`RESULT: FAIL (${failures.length} of ${measurements.length} measurement(s))`)
    else console.log('RESULT: PASS')
    process.exitCode = failures.length ? 1 : 0
  } finally {
    const cpid = browser.pid
    await browser.close().catch(() => {})
    if (cpid) { try { process.kill(cpid, 'SIGKILL') } catch (e) {} }
    try { server.stop() } catch (e) {}
  }
  await exitAfterQuiesce(process.exitCode ?? 0)
}

main().catch((e) => {
  console.error('[ground-census] threw: ' + String((e && e.stack) || e))
  failures.push('arm threw before it could decide: ' + String((e && e.message) || e))
  for (const f of failures) console.log(`FAIL: ${f}`)
  console.log(`RESULT: FAIL (${failures.length} of ${Math.max(measurements.length, failures.length)} measurement(s))`)
  exitAfterQuiesce(1)
})
