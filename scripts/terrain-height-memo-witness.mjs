#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from './lib/cdp-browser.mjs'
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

const SECONDS = flagNumber(flag, 'seconds', 45, argv)
const WARMUP_MS = flagNumber(flag, 'warmup', 10000, argv)
const WORLD = String(flag('world', 'tps-game'))
const GPU = String(flag('gpu', 'nvidia'))
const KNOB_SPEC = String(flag('knob', ''))

const MIN_FRAMES = 600
const MIN_MOVED_M = 5
const MIN_CALLS_PER_FRAME = 0.5
const MAX_MODULE_IDENTITY_FAILURES = 0
const SITE_STRIDE = 8
const MAX_SITES = 200

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

// --knob resolves against the RenderControls registry and installs through it via CDP, the same
// route scripts/perf-run.mjs uses. A knob is never carried in the page URL: nothing in client/
// reads a `knob` query param, so a URL knob is silently discarded and the run measures defaults --
// lethal here because qualityGovernor defaults TRUE and moves maxLevel/splitFactor underneath the
// measured walk.
const knobApplySrc = (knobs) => `(() => {
  const W = window
  const want = ${JSON.stringify(knobs)}
  let registry = null
  const apply = () => {
    const applied = []
    for (const k of want) {
      const ok = registry.set(k.key, k.value)
      applied.push({ key: k.key, global: '__' + k.key, type: k.type, value: k.value, setReturned: ok, readback: W['__' + k.key] })
    }
    W.__rigKnobs = applied
  }
  Object.defineProperty(W, '__renderControls', {
    configurable: true,
    get: () => registry,
    set: (v) => {
      registry = v
      if (registry && typeof registry.set === 'function') apply()
      else W.__rigKnobsError = 'window.__renderControls assigned without a set() function'
    },
  })
})()`

async function resolveKnobSpec(spec) {
  const pairs = String(spec || '').split(',').filter(Boolean)
  if (!pairs.length) return []
  const registryPath = resolve(ROOT, 'client', 'core', 'RenderControls.js')
  if (!existsSync(registryPath)) throw new Error('[terrain-memo] --knob resolves keys against the render-controls registry at ' + registryPath + '; that file is absent')
  const mod = await import(pathToFileURL(registryPath).href)
  const byKey = new Map(((mod.RenderControls && mod.RenderControls.controls) || []).map((c) => [c.key, c]))
  const knobs = []
  const rejected = []
  for (const pair of pairs) {
    const eq = pair.indexOf('=')
    const key = (eq > 0 ? pair.slice(0, eq) : pair).trim()
    const raw = eq > 0 ? pair.slice(eq + 1).trim() : ''
    const entry = byKey.get(key)
    if (!entry) { rejected.push(`"${key}" is not in the RenderControls registry (${byKey.size} keys registered)`); continue }
    if (eq < 0) { rejected.push(`"${key}" carries no =<value>`); continue }
    let value
    if (entry.type === 'boolean') {
      if (/^(true|1|on|yes)$/i.test(raw)) value = true
      else if (/^(false|0|off|no)$/i.test(raw)) value = false
      else { rejected.push(`"${key}=${raw}" is not a boolean (registry type ${entry.type}): expected true/false/1/0/on/off/yes/no`); continue }
    } else if (entry.type === 'number') {
      const n = Number(raw)
      if (raw === '' || !Number.isFinite(n)) { rejected.push(`"${key}=${raw}" is not a finite number (registry type ${entry.type})`); continue }
      if (typeof entry.min === 'number' && n < entry.min) { rejected.push(`"${key}=${raw}" is below the declared min ${entry.min}`); continue }
      if (typeof entry.max === 'number' && n > entry.max) { rejected.push(`"${key}=${raw}" is above the declared max ${entry.max}`); continue }
      value = n
    } else {
      rejected.push(`"${key}=${raw}" has registry type ${entry.type}; --knob sets boolean and number knobs only`)
      continue
    }
    knobs.push({ key, type: entry.type, value, default: entry.default })
  }
  if (rejected.length) throw new Error('[terrain-memo] --knob rejected ' + rejected.length + ' of ' + pairs.length + ' knob(s): ' + rejected.join('; '))
  return knobs
}

// The instrument is installed through registerGroundSource under the source name already in force.
// Assigning frame.groundHeightLocal directly looks equivalent and is not: the setter names an
// unnamed install 'substituted', and PlacementChart.surfaceAlongDir branches on
// groundSource === 'cpu-solve' to take ONE elevationAtDir call instead of the 16-iteration ground
// loop. A direct assignment therefore flips every placement solve onto the expensive path and the
// witness measures traffic it manufactured itself (measured: 74% of the asks, and a sampler cost
// 5-60x the real one). `transparent` is the guard that keeps it from coming back.
function armCounters() {
  const t = window.__terrain
  if (!t || !t.frame) return { error: 'no window.__terrain.frame' }
  const f = t.frame
  const orig = f.groundHeightLocal
  if (typeof orig !== 'function') return { error: 'frame.groundHeightLocal is not a function' }
  if (typeof f.registerGroundSource !== 'function') return { error: 'frame exposes no registerGroundSource' }
  const srcAtArm = f.groundSource
  const st = { calls: 0, ms: 0, t0: 0, frames0: window.__frames || 0, idealHits: 0, sites: {}, siteSamples: 0 }
  const seenKeys = new Set()
  st.seenKeys = seenKeys
  window.__memoStats = st
  const installed = f.registerGroundSource(srcAtArm, function (...a) {
    st.calls++
    const at = performance.now()
    let h = NaN, err = null
    try { h = orig.apply(this, a) } catch (e) { err = e }
    st.ms += performance.now() - at
    if (!err) {
      const k = a[0] + ':' + a[1]
      if (seenKeys.has(k)) st.idealHits++
      else seenKeys.add(k)
      // Sampled across the whole measured walk, not just its first moments: a cap on the sample
      // count fills the bucket map during warmup and reports the warmup's caller mix as the
      // steady-state one.
      if ((st.calls % SITE_STRIDE) === 0) {
        st.siteSamples++
        const site = String((new Error().stack || '').split(String.fromCharCode(10)).slice(2, 5).join(' <- ')).replace(/https?:\/\/[^/]+\//g, '/')
        if (!(site in st.sites) && Object.keys(st.sites).length >= MAX_SITES) site = '<folded>'
        st.sites[site] = (st.sites[site] || 0) + 1
      }
    }
    if (err) throw err
    return h
  })
  const transparent = f.groundSource === srcAtArm && typeof f.groundHeightLocal === 'function'
  st.t0 = performance.now()
  return { ok: true, groundSourceAtArm: srcAtArm, installed, transparent }
}

async function armModule() {
  const f = window.__terrain.frame
  const mod = await import('/src/terrain/PlanetFrame.js')
  if (typeof mod.groundMemoStats !== 'function') return { error: 'PlanetFrame exports no groundMemoStats' }
  const cpu = f.cpuGroundHeightLocal
  if (typeof cpu !== 'function') return { error: 'frame.cpuGroundHeightLocal is not a function' }
  mod.resetGroundMemoStats()
  mod.resetSurfaceSolveStats()
  const px = 1234.5 + Math.random(), pz = -987.25 + Math.random()
  let threw = false
  try { cpu.call(f, px, pz) } catch (e) { threw = true }
  const memo = mod.groundMemoStats()
  const solve = mod.surfaceSolveStats()
  return {
    ok: true,
    moduleShared: memo.misses >= 1 && solve.solves >= (threw ? 0 : 1),
    probeMisses: memo.misses,
    probeSolves: solve.solves,
  }
}

function readCounters() {
  const st = window.__memoStats
  if (!st) return { error: 'no stats' }
  return {
    elapsedMs: Math.round(performance.now() - st.t0),
    calls: st.calls,
    ms: Math.round(st.ms * 100) / 100,
    idealHits: st.idealHits,
    siteSamples: st.siteSamples,
    topSites: Object.entries(st.sites).sort((a, b) => b[1] - a[1]).slice(0, 8),
    frames0: st.frames0,
    frames: window.__frames || 0,
    groundSource: (window.__terrain && window.__terrain.frame) ? window.__terrain.frame.groundSource : null,
    chartEpoch: (window.__terrain && window.__terrain.frame) ? window.__terrain.frame.chartEpoch : null,
    pos: (() => {
      const cls = (window.__client && window.__client.getLocalState) ? window.__client.getLocalState() : null
      const a = window.__app || {}
      const v = (cls && cls.position) || (a.localPlayer && a.localPlayer.position) || null
      return v ? [v[0], v[1], v[2]] : null
    })(),
  }
}

async function readModule() {
  const mod = await import('/src/terrain/PlanetFrame.js')
  return { memo: mod.groundMemoStats(), solve: mod.surfaceSolveStats() }
}

async function main() {
  const KNOBS = await resolveKnobSpec(KNOB_SPEC)
  if (KNOBS.length) console.log('[terrain-memo] knobs resolved: ' + KNOBS.map((k) => '__' + k.key + '=' + JSON.stringify(k.value) + ' [' + k.type + ', default ' + JSON.stringify(k.default) + ']').join('  '))
  const port = String(20000 + Math.floor(Math.random() * 20000))
  process.env.WORLD = process.env.WORLD || WORLD
  process.env.PORT = port
  process.env.SPOINT_NO_WATCH = '1'
  const { boot } = await import(pathToFileURL(resolve(ROOT, 'src', 'sdk', 'server.js')).href)
  const server = await boot()
  console.log(`[terrain-memo] server up on ${port} world=${process.env.WORLD}`)

  const browser = await chromium.launch({ args: [...vendorLaunchArgs(GPU)] })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    page.on('pageerror', (e) => console.log('[terrain-memo] pageerror: ' + String((e && e.message) || e).slice(0, 300)))
    if (KNOBS.length) await page._send('Page.addScriptToEvaluateOnNewDocument', { source: knobApplySrc(KNOBS) })
    const url = `http://127.0.0.1:${port}/?multiplayer&world=${WORLD}&v=${Date.now()}`
    console.log('[terrain-memo] navigating ' + url)
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
      if (Date.now() - lastLog > 15000) { lastLog = Date.now(); console.log(`[terrain-memo] boot t+${Math.round((Date.now() - bootStart) / 1000)}s ${JSON.stringify(r)}`) }
      await new Promise((r2) => setTimeout(r2, 1000))
    }
    if (!ready) throw new Error('page never reached terrain+revealedAt')
    console.log(`[terrain-memo] boot ok in ${Math.round((Date.now() - bootStart) / 1000)}s`)

    const gpu = await assertGpu(page, { requireAccelerated: true, expectVendor: GPU })
    console.log(`[terrain-memo] gpu=${GPU} accelerated=${gpu.accelerated} rasterizer=${gpu.rasterizer} renderer=${gpu.renderer || 'none'}`)
    if (gpu.accelerated !== true) throw new Error('gpu arm not accelerated: ' + JSON.stringify(gpu))

    let knobApplied = []
    if (KNOBS.length) {
      const knobState = await page.evaluate(() => ({ knobs: window.__rigKnobs || null, error: window.__rigKnobsError || null })).catch((e) => ({ error: String((e && e.message) || e) }))
      if (!Array.isArray(knobState.knobs)) throw new Error('[terrain-memo] --knob never applied in the page: ' + JSON.stringify(knobState))
      knobApplied = knobState.knobs
      const notLanded = knobApplied.filter((k) => k.setReturned !== true || k.readback !== k.value)
      if (notLanded.length) throw new Error('[terrain-memo] --knob values did not land through RenderControls.set: ' + JSON.stringify(notLanded))
      console.log('[terrain-memo] knobs applied: ' + knobApplied.map((k) => k.global + '=' + JSON.stringify(k.readback)).join('  '))
    }

    const armed = await page.evaluate(armCounters)
    console.log('[terrain-memo] armed: ' + JSON.stringify(armed))
    if (!armed || !armed.ok) throw new Error('arm failed: ' + JSON.stringify(armed))
    expect('instrumentTransparent', armed.transparent, (v) => v === true)
    expect('groundSourceAtArm', armed.groundSourceAtArm, (v) => typeof v === 'string' && v.length > 0)
    const moduleArm = await page.evaluate(armModule)
    console.log('[terrain-memo] module: ' + JSON.stringify(moduleArm))
    if (!moduleArm || !moduleArm.ok) throw new Error('module arm failed: ' + JSON.stringify(moduleArm))
    expect('moduleShared', moduleArm.moduleShared, (v) => v === true)

    await page.evaluate(() => {
      window.__frames = 0
      const tick = () => { window.__frames++; requestAnimationFrame(tick) }
      requestAnimationFrame(tick)
      return true
    })

    const posStart = await page.evaluate(() => {
      const cls = (window.__client && window.__client.getLocalState) ? window.__client.getLocalState() : null
      const v = cls && cls.position
      return v ? [v[0], v[1], v[2]] : null
    })
    await page.keyboard.down('KeyW').catch(() => {})
    await new Promise((r) => setTimeout(r, WARMUP_MS))

    // Everything the report divides by calls has to restart with it: leaving idealHits or the
    // bucket map counting across the boundary reports the warmup's dedup headroom and caller mix
    // against the measured walk's call count.
    await page.evaluate(() => {
      const st = window.__memoStats
      st.frames0 = window.__frames || 0
      st.calls = 0
      st.ms = 0
      st.idealHits = 0
      st.siteSamples = 0
      st.sites = {}
      if (st.seenKeys) st.seenKeys.clear()
      st.t0 = performance.now()
      return true
    })
    const modReset = await page.evaluate(async () => {
      const mod = await import('/src/terrain/PlanetFrame.js')
      mod.resetGroundMemoStats()
      mod.resetSurfaceSolveStats()
      return true
    })
    if (modReset !== true) throw new Error('module reset failed')

    const walkStart = Date.now()
    let turn = 0
    while (Date.now() - walkStart < SECONDS * 1000) {
      await new Promise((r) => setTimeout(r, 2500))
      const key = (turn++ % 2 === 0) ? 'KeyA' : 'KeyD'
      await page.keyboard.down(key).catch(() => {})
      await new Promise((r) => setTimeout(r, 400))
      await page.keyboard.up(key).catch(() => {})
    }
    await page.keyboard.up('KeyW').catch(() => {})

    const read = await page.evaluate(readCounters)
    const mod = await page.evaluate(readModule)
    console.log('[terrain-memo] raw: ' + JSON.stringify(read) + ' module: ' + JSON.stringify(mod))
    if (read.error) throw new Error('read failed: ' + read.error)

    const frames = Math.max(0, read.frames - read.frames0)
    const secs = (read.elapsedMs || 1) / 1000
    const total = mod.memo.hits + mod.memo.misses
    const per = (n) => Math.round((n / frames) * 10000) / 10000
    const moved = (posStart && read.pos) ? Math.round(Math.hypot(read.pos[0] - posStart[0], read.pos[1] - posStart[1], read.pos[2] - posStart[2]) * 100) / 100 : null

    const report = {
      groundSource: expect('groundSource', read.groundSource, (v) => typeof v === 'string' && v.length > 0),
      chartEpoch: expect('chartEpoch', read.chartEpoch, (v) => Number.isFinite(v) && v >= 0),
      frames: expect('frames', frames, (v) => v >= MIN_FRAMES),
      playerMovedM: expect('playerMovedM', moved, (v) => Number.isFinite(v) && v >= MIN_MOVED_M),
      groundHeightLocal_callsPerFrame: expect('groundHeightLocal_callsPerFrame', per(read.calls), (v) => v >= MIN_CALLS_PER_FRAME),
      groundHeightLocal_msPerFrame: expect('groundHeightLocal_msPerFrame', Math.round((read.ms / frames) * 10000) / 10000, finite),
      memo_samples: expect('memo_samples', total, (v) => v > 0),
      memo_hitRatePct: expect('memo_hitRatePct', total ? Math.round((mod.memo.hits / total) * 10000) / 100 : null, (v) => Number.isFinite(v) && v >= 0 && v <= 100),
      memo_idealHitRatePct: expect('memo_idealHitRatePct', read.calls ? Math.round((read.idealHits / read.calls) * 10000) / 100 : null, (v) => Number.isFinite(v) && v >= 0 && v <= 100),
      msPerFrame_totalWall: expect('msPerFrame_totalWall', Math.round((secs * 1000 / frames) * 10000) / 10000, finite),
      memo_hits: expect('memo_hits', mod.memo.hits, (v) => v >= 0),
      memo_misses: expect('memo_misses', mod.memo.misses, (v) => v > 0),
      memo_evictions: expect('memo_evictions', mod.memo.evictions, finite),
      memo_epochStale: expect('memo_epochStale', mod.memo.epochStale, (v) => Number.isFinite(v) && v === 0),
      memo_cellCollisions: expect('memo_cellCollisions', mod.memo.cellCollisions, finite),
      solve_solvesPerFrame: expect('solve_solvesPerFrame', per(mod.solve.solves), finite),
      solve_evaluationsPerFrame: expect('solve_evaluationsPerFrame', per(mod.solve.evaluations), finite),
      solve_evalsPerSolve: expect('solve_evalsPerSolve', mod.solve.solves ? Math.round((mod.solve.evaluations / mod.solve.solves) * 100) / 100 : null, (v) => Number.isFinite(v) && v > 0 && v <= 64),
      msPerMiss_us: expect('msPerMiss_us', mod.memo.misses ? Math.round((read.ms / mod.memo.misses) * 1000 * 100) / 100 : null, finite),
    }
    console.log('[terrain-memo] measurements ' + JSON.stringify(report, null, 2))
    if (knobApplied.length) console.log('[terrain-memo] knobs in force throughout the measured walk: ' + knobApplied.map((k) => k.key + '=' + JSON.stringify(k.readback)).join('  '))
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
  console.error('[terrain-memo] threw: ' + String((e && e.stack) || e))
  failures.push('arm threw before it could decide: ' + String((e && e.message) || e))
  for (const f of failures) console.log(`FAIL: ${f}`)
  console.log(`RESULT: FAIL (${failures.length} of ${Math.max(measurements.length, failures.length)} measurement(s))`)
  exitAfterQuiesce(1)
})
