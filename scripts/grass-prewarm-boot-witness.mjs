#!/usr/bin/env node
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from './lib/cdp-browser.mjs'
import { vendorLaunchArgs } from './lib/witness-gpu.mjs'
import { witnessGpu } from './lib/gpu-probe.mjs'
import {
  assertServedClientRoot, clientRootTag, rebuildClientBundle, CLIENT_ROOT_BUNDLE, CLIENT_ROOT_RAW,
} from './lib/served-client-root.mjs'
import { unreachedReasons } from './lib/witness-reachability.mjs'

const LABEL = 'grass-prewarm-boot-witness'
const ADMITTED_GPU_MODES = new Set(['software', 'swiftshader', 'accelerated', 'nvidia', 'amd'])
const LF = String.fromCharCode(10)

function flag(name, dflt = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}

const PORT = flag('port', '3137')
const PARAMS = flag('params', 'singleplayer')
const WORLD = flag('world', 'tps-game')
const GPU_MODE = flag('gpu', 'software')
const REPS = Math.max(1, Number(flag('reps', '3')) | 0)
const TIMEOUT_MS = Number(flag('timeout', '240000'))
const MAX_PLAYABLE_MS = Number(flag('max-playable-ms', '0')) || null
const MAX_PREWARM_MS = Number(flag('max-prewarm-ms', '0')) || null
const MAX_GRASS_WAIT_MS = Number(flag('max-grass-wait-ms', '1500'))
const MIN_GRASS_INSTANCES = Number(flag('min-grass-instances', '0')) || null
const SETTLE_MS = Number(flag('settle', '0'))
const ARM = flag('arm', 'unlabelled')
const [VIEW_W, VIEW_H] = String(flag('viewport', '1280x720')).split('x').map(Number)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRATCH = resolve(flag('scratch', join(tmpdir(), 'spoint-grass-prewarm-witness')))

function finish(verdict, detail) {
  console.log(`RESULT: ${verdict} arm=${GPU_MODE} label=${ARM} -- ${String(detail).split(LF).join(' ')}`)
  process.exit(verdict === 'PASS' ? 0 : 1)
}

const fail = (detail) => finish('FAIL', detail)

const num = (x) => typeof x === 'number' && Number.isFinite(x)
const OPS = {
  '==': (got, want) => Object.is(got, want),
  '<=': (got, want) => num(got) && got <= want,
  '>=': (got, want) => num(got) && got >= want,
  '>': (got, want) => num(got) && got > want,
}
const checks = []
function expect(label, got, op, want) {
  const pass = OPS[op](got, want) === true
  checks.push({ label, got, op, want, pass })
  return pass
}

if (!ADMITTED_GPU_MODES.has(GPU_MODE)) {
  fail(`--gpu=${GPU_MODE} refused: admitted modes are software, swiftshader and accelerated`)
}

function resetScratch() {
  const insideRepo = SCRATCH.startsWith(REPO_ROOT + sep) || SCRATCH === REPO_ROOT
  const enclosesRepo = REPO_ROOT.startsWith(SCRATCH + sep)
  if (insideRepo || enclosesRepo || SCRATCH === resolve(tmpdir()) || dirname(SCRATCH) === SCRATCH) {
    fail(`--scratch=${SCRATCH} refused: scratch must be a directory outside the repo, not the temp root, not a filesystem root`)
  }
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(SCRATCH, { recursive: true })
}

const PLAYABLE_EXPR = 'window.__app && window.__app.revealedAt != null'

const PROBE_FRAMES = process.argv.includes('--frames')
const PROFILE = process.argv.includes('--profile')

const RAF_PROBE = `  const nativeRaf = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = function (cb) {
    return nativeRaf(function (t) {
      if (!rec.active) return cb(t)
      const startedAt = performance.now()
      try { return cb(t) } finally { rec.frameMs.push(performance.now() - startedAt) }
    })
  }
`

const PROBE_INIT = `(() => {
  const rec = { active: false, yieldLatencyMs: [], frameMs: [], snaps: {}, longtasks: [] }
  window.__prewarmProbe = rec
${PROBE_FRAMES ? RAF_PROBE : ''}  const nativeSetTimeout = window.setTimeout
  window.setTimeout = function (fn, delay, ...rest) {
    if (rec.active && (delay === 0 || delay === undefined)) {
      const scheduledAt = performance.now()
      return nativeSetTimeout.call(window, function () {
        rec.yieldLatencyMs.push(performance.now() - scheduledAt)
        return fn.apply(this, arguments)
      }, 0, ...rest)
    }
    return nativeSetTimeout.call(window, fn, delay, ...rest)
  }
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) rec.longtasks.push({ start: e.startTime, duration: e.duration })
    }).observe({ type: 'longtask', buffered: true })
  } catch (_) {}
  const snapshot = () => {
    const g = window.__grass, v = window.__veg, r = window.__rocks
    const s = g && g.streamState ? g.streamState() : null
    return {
      grass: g ? { loads: g.profile.loads, expected: s.expected, loaded: s.loaded, missing: s.missing, deferred: s.deferred, instances: g.totalInstances } : null,
      veg: v ? { loads: v.profile.loads, instances: v.totalInstances } : null,
      rocks: r ? { loads: r.profile.loads, instances: r.totalInstances } : null,
    }
  }
  const nativeMark = performance.mark.bind(performance)
  performance.mark = function (name, options) {
    if (name === 'boot:foliage-built') { rec.snaps.built = snapshot(); rec.active = true }
    if (name === 'boot:foliage-prewarmed') { rec.snaps.prewarmed = snapshot(); rec.active = false }
    return nativeMark(name, options)
  }
})()`

const PROBE = `(() => {
  const marks = {}
  for (const m of performance.getEntriesByType('mark')) marks[m.name] = m.startTime
  const snap = (api) => api ? { totalInstances: api.totalInstances, profile: { ...api.profile } } : null
  return {
    revealedAt: (window.__app && window.__app.revealedAt) || null,
    marks,
    grass: snap(window.__grass),
    rocks: snap(window.__rocks),
    veg: snap(window.__veg),
    probe: window.__prewarmProbe || null,
  }
})()`

const SERVED_ENTRY = `(async () => {
  const res = await fetch('/app.js', { cache: 'no-store' })
  const text = await res.text()
  return { status: res.status, bytes: text.length, hasPrewarmWorkMs: text.includes('prewarmWorkMs'), hasYieldFrame: text.includes('_yieldFrame') }
})()`

function median(xs) {
  const s = xs.filter(Number.isFinite).slice().sort((a, b) => a - b)
  if (!s.length) return null
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function percentile(xs, p) {
  const s = xs.filter(Number.isFinite).slice().sort((a, b) => a - b)
  if (!s.length) return null
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

const round = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : NaN)
const jsonLine = (v) => JSON.stringify(v, (_, x) => (typeof x === 'number' && !Number.isFinite(x) ? String(x) : x))

function summarizeProfile(profile) {
  const nodeById = new Map(profile.nodes.map(n => [n.id, n.callFrame]))
  const byFn = new Map(), byFile = new Map()
  let totalMs = 0
  for (let i = 0; i < profile.samples.length; i++) {
    const dtMs = (profile.timeDeltas[i] || 0) / 1000
    const cf = nodeById.get(profile.samples[i]) || {}
    const fnKey = `${cf.functionName || '(anonymous)'} ${cf.url || '(native)'}:${(cf.lineNumber ?? -1) + 1}`
    const fileKey = cf.url || '(native)'
    byFn.set(fnKey, (byFn.get(fnKey) || 0) + dtMs)
    byFile.set(fileKey, (byFile.get(fileKey) || 0) + dtMs)
    totalMs += dtMs
  }
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, round(v)])
  return { sampledMs: round(totalMs), topFunctions: top(byFn, 18), topFiles: top(byFile, 12) }
}

function summarizeRep(run) {
  const m = run.marks
  const built = m['boot:foliage-built'], prewarmed = m['boot:foliage-prewarmed']
  const window_ = Number.isFinite(built) && Number.isFinite(prewarmed) ? prewarmed - built : null
  const lat = run.probe?.yieldLatencyMs || []
  const longIn = (run.probe?.longtasks || []).filter(t => Number.isFinite(built) && t.start >= built && t.start <= prewarmed)
  const vp = run.veg?.profile || {}, rp = run.rocks?.profile || {}, gp = run.grass?.profile || {}
  const snaps = run.probe?.snaps || {}
  return {
    playableMs: round(run.revealedAt),
    prewarmStageMs: round(window_),
    grass: {
      chunks: gp.prewarmChunks, workMs: round(gp.prewarmWorkMs), prewarmMs: round(gp.prewarmMs),
      waitMs: round((gp.prewarmMs ?? NaN) - (gp.prewarmWorkMs ?? NaN)),
      atBuilt: snaps.built?.grass ?? null, atPrewarmed: snaps.prewarmed?.grass ?? null,
    },
    rocks: {
      chunks: rp.prewarmChunks, workMs: round(rp.prewarmWorkMs), prewarmMs: round(rp.prewarmMs),
      waitMs: round((rp.prewarmMs ?? NaN) - (rp.prewarmWorkMs ?? NaN)),
    },
    veg: {
      chunks: vp.prewarmChunks, deferred: vp.prewarmDeferred, workMs: round(vp.prewarmWorkMs),
      yieldMs: round(vp.prewarmYieldMs), bvhAndOverheadMs: round((vp.prewarmMs ?? NaN) - (vp.prewarmWorkMs ?? NaN) - (vp.prewarmYieldMs ?? NaN)),
      prewarmMs: round(vp.prewarmMs),
    },
    yieldLatency: {
      n: lat.length, sumMs: round(lat.reduce((a, b) => a + b, 0)),
      medianMs: round(median(lat)), p90Ms: round(percentile(lat, 90)), maxMs: round(lat.length ? Math.max(...lat) : null),
    },
    frameCallbacksInWindow: {
      n: (run.probe?.frameMs || []).length, sumMs: round((run.probe?.frameMs || []).reduce((a, b) => a + b, 0)),
      medianMs: round(median(run.probe?.frameMs || [])), maxMs: round((run.probe?.frameMs || []).length ? Math.max(...run.probe.frameMs) : null),
    },
    longtasksInWindow: { n: longIn.length, sumMs: round(longIn.reduce((a, t) => a + t.duration, 0)), maxMs: round(longIn.length ? Math.max(...longIn.map(t => t.duration)) : null) },
    pageErrors: run.pageErrors.length,
  }
}

async function main() {
  process.env.WORLD = process.env.WORLD || WORLD
  process.env.PORT = PORT
  process.env.SPOINT_NO_WATCH = '1'

  if (process.argv.includes('--rebuild-bundle')) {
    console.log(`[${LABEL}] --rebuild-bundle: running scripts/bundle-client.mjs before boot ...`)
    rebuildClientBundle()
  }
  resetScratch()
  process.env.SPOINT_STATIC_CACHE_DIR = join(SCRATCH, 'static')
  console.log(`[${LABEL}] booting real server on port ${PORT} (world=${process.env.WORLD}, scratch=${SCRATCH}) ...`)
  const { boot } = await import('../src/sdk/server.js')
  const { STATIC_CACHE_DIR } = await import('../src/sdk/StaticCache.js')
  if (STATIC_CACHE_DIR !== join(SCRATCH, 'static')) fail(`static cache resolved to ${STATIC_CACHE_DIR}, not the scratch dir: the witness would write into the repo`)
  const server = await boot({ storageDir: join(SCRATCH, 'data') })
  const base = `http://127.0.0.1:${PORT}`
  console.log(`[${LABEL}] server up at ${base}`)

  const runs = []
  let servedRoot = null
  let servedEntry = null
  let gpuName = null
  let browser = null
  try {
    browser = await chromium.launch({ headless: true, args: vendorLaunchArgs(GPU_MODE) })
    const want = process.argv.includes('--require-raw-esm') ? CLIENT_ROOT_RAW : CLIENT_ROOT_BUNDLE

    for (let i = 0; i < REPS; i++) {
      const page = await browser.newPage({ viewport: { width: VIEW_W, height: VIEW_H } })
      const pageErrors = []
      const consoleErrors = []
      page.on('pageerror', e => pageErrors.push(String(e)))
      page.on('Runtime.consoleAPICalled', p => {
        if (p?.type === 'error' || p?.type === 'warning') consoleErrors.push(`[${p.type}] ${(p.args || []).map(a => a?.description || String(a?.value ?? '')).join(' ')}`.slice(0, 300))
      })
      await page._send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE_INIT })
      await page.goto(`${base}/?${PARAMS}`, { waitUntil: 'domcontentloaded' })

      const root = await assertServedClientRoot(page, { want, label: LABEL }).catch(e => e)
      if (root instanceof Error) fail(root.message)
      servedRoot = root
      servedEntry = await page.evaluate(SERVED_ENTRY).catch(e => ({ status: 0, error: e.message }))
      const gpu = await witnessGpu(page, GPU_MODE)
      gpuName = gpu.renderer || gpu.adapter || null

      if (PROFILE) await page._send('Profiler.enable')
      const t0 = Date.now()
      let reached = false
      let profiling = false
      let cpuProfile = null
      while (Date.now() - t0 < TIMEOUT_MS) {
        const st = await page.evaluate(`({
          built: performance.getEntriesByName('boot:foliage-built').length > 0,
          prewarmed: performance.getEntriesByName('boot:foliage-prewarmed').length > 0,
          playable: !!(${PLAYABLE_EXPR}),
        })`).catch(() => ({}))
        if (PROFILE && st.built && !profiling && !cpuProfile) {
          await page._send('Profiler.setSamplingInterval', { interval: 1000 })
          await page._send('Profiler.start')
          profiling = true
        }
        if (PROFILE && profiling && st.prewarmed) {
          cpuProfile = (await page._send('Profiler.stop')).profile
          profiling = false
        }
        reached = st.prewarmed && st.playable && (!PROFILE || !!cpuProfile)
        if (reached) break
        await new Promise(r => setTimeout(r, 200))
      }
      if (!reached) fail(`rep ${i}: the foliage prewarm never finished within ${TIMEOUT_MS}ms (pageErrors=${pageErrors.length}${pageErrors[0] ? ': ' + pageErrors[0].slice(0, 200) : ''}; console=${consoleErrors.slice(-3).join(' | ')})`)
      if (SETTLE_MS > 0) await page.waitForTimeout(SETTLE_MS)

      const probe = await page.evaluate(PROBE)
      const run = { ...probe, pageErrors, consoleErrors, cpu: cpuProfile ? summarizeProfile(cpuProfile) : null }
      if (run.cpu) console.log(`[${LABEL}] rep ${i} cpu ${jsonLine(run.cpu)}`)
      runs.push(run)
      console.log(`[${LABEL}] rep ${i}: ${jsonLine(summarizeRep(run))}`)
      console.log(`[${LABEL}] rep ${i} marks=${JSON.stringify(Object.keys(probe.marks))} snaps=${JSON.stringify(Object.keys(probe.probe?.snaps || {}))} veg=${!!probe.veg} rocks=${!!probe.rocks} grass=${!!probe.grass}`)
      for (const c of consoleErrors.slice(0, 12)) console.log(`[${LABEL}] rep ${i} console ${c}`)
      await page.close().catch(() => {})
    }

    await browser.close().catch(() => {})
    browser = null
    server.stop()
  } catch (e) {
    if (browser) await browser.close().catch(() => {})
    server.stop()
    throw e
  }

  const summaries = runs.map(summarizeRep)
  const out = {
    arm: ARM,
    gpuMode: GPU_MODE,
    adapter: gpuName,
    clientRoot: servedRoot ? clientRootTag(servedRoot) : null,
    servedEntry,
    reps: runs.length,
    playableMedianMs: round(median(summaries.map(s => s.playableMs))),
    prewarmStageMedianMs: round(median(summaries.map(s => s.prewarmStageMs))),
    grassChunks: summaries.map(s => s.grass.chunks),
    grassWorkMs: summaries.map(s => s.grass.workMs),
    grassPrewarmMs: summaries.map(s => s.grass.prewarmMs),
    grassWaitMs: summaries.map(s => s.grass.waitMs),
    grassMissingAtBuilt: summaries.map(s => s.grass.atBuilt?.missing ?? null),
    grassExpectedAtBuilt: summaries.map(s => s.grass.atBuilt?.expected ?? null),
    grassLoadedAtBuilt: summaries.map(s => s.grass.atBuilt?.loaded ?? null),
    grassDeferredAtBuilt: summaries.map(s => s.grass.atBuilt?.deferred ?? null),
    grassLoadsDuringPrewarm: summaries.map(s => (s.grass.atPrewarmed && s.grass.atBuilt) ? s.grass.atPrewarmed.loads - s.grass.atBuilt.loads : null),
    grassInstances: summaries.map(s => s.grass.atPrewarmed?.instances ?? null),
    rocksChunks: summaries.map(s => s.rocks.chunks),
    rocksWorkMs: summaries.map(s => s.rocks.workMs),
    rocksWaitMs: summaries.map(s => s.rocks.waitMs),
    vegChunks: summaries.map(s => s.veg.chunks),
    vegDeferred: summaries.map(s => s.veg.deferred),
    vegWorkMs: summaries.map(s => s.veg.workMs),
    vegYieldMs: summaries.map(s => s.veg.yieldMs),
    vegBvhAndOverheadMs: summaries.map(s => s.veg.bvhAndOverheadMs),
    vegPrewarmMs: summaries.map(s => s.veg.prewarmMs),
    yieldLatencyMedianMs: summaries.map(s => s.yieldLatency.medianMs),
    yieldLatencyP90Ms: summaries.map(s => s.yieldLatency.p90Ms),
    yieldLatencyN: summaries.map(s => s.yieldLatency.n),
    yieldLatencySumMs: summaries.map(s => s.yieldLatency.sumMs),
    longtasksInWindow: summaries.map(s => s.longtasksInWindow),
    playableMs: summaries.map(s => s.playableMs),
  }
  console.log(`[${LABEL}] measurements ${jsonLine(out)}`)

  runs.forEach((run, i) => {
    const snaps = run.probe?.snaps || {}
    const atBuilt = snaps.built?.grass, atPrewarmed = snaps.prewarmed?.grass
    const gp = run.grass?.profile || {}, rp = run.rocks?.profile || {}, vp = run.veg?.profile || {}
    expect(`rep${i} boot marks and playable count reached`, unreachedReasons({ marks: Object.keys(run.marks), requiredMarks: ['boot:foliage-built', 'boot:foliage-prewarmed'], counts: { revealedAt: run.revealedAt }, requiredCounts: ['revealedAt'] }).length, '==', 0)
    expect(`rep${i} grass ring expected count at boot`, atBuilt?.expected, '>', 0)
    expect(`rep${i} grass ring missing at boot`, atBuilt?.missing, '==', 0)
    expect(`rep${i} grass ring missing after prewarm`, atPrewarmed?.missing, '==', 0)
    expect(`rep${i} grass loads during prewarm`, atPrewarmed?.loads - atBuilt?.loads, '==', 0)
    const grassPending = atBuilt?.loaded < atBuilt?.expected
    expect(`rep${i} grass prewarm chunks (${grassPending ? 'grass pending at boot' : 'grass already resident at boot'})`, gp.prewarmChunks, grassPending ? '>' : '==', 0)
    expect(`rep${i} grass prewarm workMs (${grassPending ? 'grass pending at boot' : 'grass already resident at boot'})`, gp.prewarmWorkMs, grassPending ? '>' : '==', 0)
    expect(`rep${i} grass budget reports prewarmMs`, Number.isFinite(gp.prewarmMs), '==', true)
    expect(`rep${i} grass wait inside its budget ms`, gp.prewarmMs - gp.prewarmWorkMs, '<=', MAX_GRASS_WAIT_MS)
    expect(`rep${i} rocks prewarm chunks`, rp.prewarmChunks, '>', 0)
    expect(`rep${i} rocks prewarm workMs`, rp.prewarmWorkMs, '>', 0)
    expect(`rep${i} veg prewarm chunks`, vp.prewarmChunks, '>', 0)
    expect(`rep${i} veg prewarm workMs`, vp.prewarmWorkMs, '>', 0)
    expect(`rep${i} veg prewarm yieldMs reported`, Number.isFinite(vp.prewarmYieldMs), '==', true)
    expect(`rep${i} zero-delay yields observed in prewarm window`, run.probe?.yieldLatencyMs?.length, '>', 0)
    expect(`rep${i} uncaught page errors`, run.pageErrors.length, '==', 0)
  })
  if (MAX_PLAYABLE_MS !== null) expect('median boot-to-playable ms', out.playableMedianMs, '<=', MAX_PLAYABLE_MS)
  if (MAX_PREWARM_MS !== null) expect('median prewarm stage ms', out.prewarmStageMedianMs, '<=', MAX_PREWARM_MS)
  if (MIN_GRASS_INSTANCES !== null) expect('min grass instances after prewarm', Math.min(...out.grassInstances.map(v => v ?? NaN)), '>=', MIN_GRASS_INSTANCES)

  for (const c of checks) console.log(`[${LABEL}] ${c.pass ? 'check PASS' : 'check FAIL'} ${c.label}: got ${jsonLine(c.got)} expected ${c.op} ${jsonLine(c.want)}`)
  const failed = checks.filter(c => !c.pass)
  if (failed.length) finish('FAIL', `${failed.length} of ${checks.length} check(s) failed: ${failed.map(c => `${c.label} got ${jsonLine(c.got)} expected ${c.op} ${jsonLine(c.want)}`).join('; ')}`)
  finish('PASS', `${checks.length} of ${checks.length} checks passed reps=${out.reps} playableMedianMs=${out.playableMedianMs} prewarmStageMedianMs=${out.prewarmStageMedianMs} grassChunks=${jsonLine(out.grassChunks)} grassLoadsDuringPrewarm=${jsonLine(out.grassLoadsDuringPrewarm)}`)
}

main().catch(e => {
  console.error(e && e.stack ? e.stack : e)
  finish('FAIL', `run threw: ${e && e.message ? e.message : e}`)
})
