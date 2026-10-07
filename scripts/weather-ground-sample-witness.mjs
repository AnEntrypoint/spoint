#!/usr/bin/env node
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from './lib/cdp-browser.mjs'
import { assertGpu } from './lib/gpu-probe.mjs'
import { vendorLaunchArgs } from './lib/witness-gpu.mjs'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

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

const SECONDS = Number(flag('seconds', '60'))
const WARMUP_MS = Number(flag('warmup', '8000'))
const WEATHER = String(flag('weather', 'rain'))
const WORLD = String(flag('world', 'tps-game'))
const GPU = String(flag('gpu', 'nvidia'))
const WALK = !ARGS.has('no-walk')
const SNOW_ACCUM = !ARGS.has('no-snow-accum')

const MIN_WINDOW_SECONDS = 5
const MIN_GROUND_HEIGHT_CALLS_PER_SEC = 1
const MIN_WEATHER_SHARE_PCT = 0.1
const MIN_WEATHER_UPDATES_PER_SEC = 1
const MIN_WEATHER_MS_PER_SEC = 0.01
const MIN_GROUND_SAMPLES_PER_SEC = 1
const MIN_SAMPLES_PER_UPDATE = 0.5
const MIN_FRAMES_PER_SEC = 5
const MIN_PLAYER_MOVED_M = 0.25
const MAX_CONSOLE_ERRS = 0

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

function armCounters() {
  const t = window.__terrain
  const w = window.__weather
  if (!t || !t.frame) return { error: 'no window.__terrain.frame' }
  if (!w) return { error: 'no window.__weather' }
  const f = t.frame
  const st = { total: 0, inWeather: 0, updates: 0, weatherMs: 0, t0: 0, gh0: 0 }
  window.__ghStats = st
  st.gh0 = (typeof w.groundSampleCount === 'number') ? w.groundSampleCount : null
  let inUpdate = false
  const orig = f.groundHeightLocal
  if (typeof orig !== 'function') return { error: 'frame.groundHeightLocal is not a function' }
  f.groundHeightLocal = function (...a) {
    st.total++
    if (inUpdate) st.inWeather++
    return orig.apply(this, a)
  }
  const origUpdate = w.update
  w.update = function (...a) {
    inUpdate = true
    st.updates++
    const at = performance.now()
    try { return origUpdate.apply(this, a) } finally { st.weatherMs += performance.now() - at; inUpdate = false }
  }
  st.t0 = performance.now()
  return {
    ok: true,
    patchOverride: typeof f._patchHeightOrNull === 'function',
    particles: w.maxParticles || null,
    type: w.getType ? w.getType() : null,
  }
}

function readCounters() {
  const st = window.__ghStats
  if (!st) return { error: 'no stats' }
  const w = window.__weather
  return {
    elapsedMs: Math.round(performance.now() - st.t0),
    total: st.total,
    inWeather: st.inWeather,
    updates: st.updates,
    weatherMs: Math.round(st.weatherMs * 100) / 100,
    particles: (w && w.maxParticles) || null,
    activeCount: (w && w.activeCount) || null,
    type: (w && w.getType) ? w.getType() : null,
    intensity: (w && w.getIntensity) ? w.getIntensity() : null,
    groundSampleCount: (w && typeof w.groundSampleCount === 'number') ? w.groundSampleCount : null,
    gh0: st.gh0,
    pos: (() => {
      const a = window.__app || {}
      const cls = (window.__client && window.__client.getLocalState) ? window.__client.getLocalState() : null
      const v = (cls && cls.position) || (a.localPlayer && a.localPlayer.position) || null
      return v ? [v[0], v[1], v[2]] : null
    })(),
  }
}

async function main() {
  const port = String(20000 + Math.floor(Math.random() * 20000))
  process.env.WORLD = process.env.WORLD || WORLD
  process.env.PORT = port
  process.env.SPOINT_NO_WATCH = '1'
  const { boot } = await import(pathToFileURL(resolve(ROOT, 'src', 'sdk', 'server.js')).href)
  const server = await boot()
  console.log(`[weather-gh] server up on ${port} world=${process.env.WORLD}`)

  const browser = await chromium.launch({ headless: true, args: [...vendorLaunchArgs(GPU)] })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    page.on('pageerror', (e) => console.log('[weather-gh] pageerror: ' + String((e && e.message) || e).slice(0, 300)))
    let consoleErrs = 0
    const consoleTally = {}
    page.on('console', (m) => {
      const txt = String((m && (m.text || m.message)) || m)
      if (m && (m.type === 'error' || m.type === 'warning') || /error|failed/i.test(txt)) {
        consoleErrs++
        const k = txt.slice(0, 120)
        consoleTally[k] = (consoleTally[k] || 0) + 1
      }
    })
    const url = `http://127.0.0.1:${port}/?multiplayer&world=${WORLD}&v=${Date.now()}`
    console.log('[weather-gh] navigating ' + url)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })

    const bootStart = Date.now()
    let lastLog = 0
    let ready = false
    while (Date.now() - bootStart < 180000) {
      const r = await page.evaluate(() => ({
        terrain: !!window.__terrain,
        weather: !!window.__weather,
        revealedAt: (window.__app && window.__app.revealedAt) || 0,
        connected: !!(window.__client && window.__client.connected),
      })).catch(() => null)
      if (r && r.terrain && r.weather && r.revealedAt && r.connected) { ready = true; break }
      if (Date.now() - lastLog > 15000) {
        lastLog = Date.now()
        console.log(`[weather-gh] boot t+${Math.round((Date.now() - bootStart) / 1000)}s ${JSON.stringify(r)}`)
      }
      await new Promise((r2) => setTimeout(r2, 1000))
    }
    if (!ready) throw new Error('page never reached terrain+weather+revealedAt')
    console.log(`[weather-gh] boot ok in ${Math.round((Date.now() - bootStart) / 1000)}s`)

    const gpu = await assertGpu(page, { requireAccelerated: true, expectVendor: GPU === 'igpu' ? 'intel' : GPU })
    console.log(`[weather-gh] gpu=${GPU} accelerated=${gpu.accelerated} rasterizer=${gpu.rasterizer} renderer=${gpu.renderer || 'none'}`)
    if (gpu.accelerated !== true) throw new Error('gpu arm not accelerated: ' + JSON.stringify(gpu))
    if (GPU === 'nvidia' && !/nvidia/i.test(String(gpu.renderer || ''))) throw new Error('requested nvidia but renderer is ' + gpu.renderer)

    await page.evaluate(({ wt, accum }) => {
      window.__weatherType = wt
      window.__weatherIntensity = 1
      window.__snowAccumulation = accum
      return true
    }, { wt: WEATHER, accum: SNOW_ACCUM })
    await page.evaluate(() => { window.__ghDeviation = null; return true }).catch(() => {})
    await page.evaluate(() => {
      window.__frames = 0
      const tick = () => { window.__frames++; requestAnimationFrame(tick) }
      requestAnimationFrame(tick)
      return true
    }).catch(() => {})
    console.log(`[weather-gh] forcing weather type=${WEATHER} intensity=1`)

    if (WALK) await page.keyboard.down('KeyW').catch(() => {})
    await new Promise((r) => setTimeout(r, WARMUP_MS))

    const posArm = await page.evaluate(() => {
      const a = window.__app || {}
      const cls = (window.__client && window.__client.getLocalState) ? window.__client.getLocalState() : null
      const v = (cls && cls.position) || (a.localPlayer && a.localPlayer.position) || null
      return v ? [v[0], v[1], v[2]] : null
    }).catch(() => null)
    const framesArm = await page.evaluate(() => window.__frames || 0).catch(() => 0)
    const armed = await page.evaluate(armCounters)
    console.log('[weather-gh] armed: ' + JSON.stringify(armed))
    if (!armed || !armed.ok) throw new Error('arm failed: ' + JSON.stringify(armed))
    expect('armedType', armed.type, (v) => v === WEATHER)

    await page._send('Profiler.enable').catch(() => {})
    await page._send('Profiler.setSamplingInterval', { interval: 1000 }).catch(() => {})
    await page._send('Profiler.start').catch(() => {})

    await new Promise((r) => setTimeout(r, SECONDS * 1000))

    let profile = null
    try {
      const stopped = await Promise.race([
        page._send('Profiler.stop'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Profiler.stop exceeded 60s')), 60000)),
      ])
      profile = stopped.profile
    } catch (e) { console.log('[weather-gh] profile unavailable: ' + e.message) }

    const read = await page.evaluate(readCounters)
    const dev = await page.evaluate(() => window.__ghDeviation || null).catch(() => null)
    const framesEnd = await page.evaluate(() => window.__frames || 0).catch(() => 0)
    console.log('[weather-gh] raw: ' + JSON.stringify(read))
    if (read.error) throw new Error('read failed: ' + read.error)
    if (WALK) await page.keyboard.up('KeyW').catch(() => {})

    const secs = (read.elapsedMs || 1) / 1000
    const per = (n) => Math.round((n / secs) * 100) / 100
    const context = {
      weather: WEATHER, gpu: GPU, renderer: gpu.renderer, world: WORLD, walk: WALK,
      gpuAccelerated: gpu.accelerated, gpuRasterizer: gpu.rasterizer,
      snowAccum: SNOW_ACCUM,
      ghDeviation: dev,
      consoleTop: Object.entries(consoleTally).sort((a, b) => b[1] - a[1]).slice(0, 6),
      posArm: posArm, posEnd: read.pos,
    }
    const report = {
      windowSeconds: expect('windowSeconds', Math.round(secs * 100) / 100, (v) => v >= MIN_WINDOW_SECONDS),
      groundHeightLocal_callsPerSec_total: expect('groundHeightLocal_callsPerSec_total', per(read.total), (v) => v >= MIN_GROUND_HEIGHT_CALLS_PER_SEC),
      groundHeightLocal_callsPerSec_weather: expect('groundHeightLocal_callsPerSec_weather', per(read.inWeather), (v) => v > 0),
      groundHeightLocal_callsPerSec_other: expect('groundHeightLocal_callsPerSec_other', per(read.total - read.inWeather), finite),
      weatherSharePct: expect('weatherSharePct', read.total ? Math.round((read.inWeather / read.total) * 10000) / 100 : null, (v) => v !== null && v >= MIN_WEATHER_SHARE_PCT),
      weatherUpdate_callsPerSec: expect('weatherUpdate_callsPerSec', per(read.updates), (v) => v >= MIN_WEATHER_UPDATES_PER_SEC),
      weatherUpdate_msPerSec: expect('weatherUpdate_msPerSec', Math.round((read.weatherMs / secs) * 100) / 100, (v) => v >= MIN_WEATHER_MS_PER_SEC),
      weather_groundSampleCount_total: expect('weather_groundSampleCount_total', read.groundSampleCount, (v) => Number.isFinite(v) && v > 0),
      weather_groundSampleCount_start: expect('weather_groundSampleCount_start', read.gh0, (v) => Number.isFinite(v) && v >= 0),
      weather_groundSamplesPerSec: expect('weather_groundSamplesPerSec', (read.groundSampleCount != null && read.gh0 != null) ? Math.round(((read.groundSampleCount - read.gh0) / secs) * 100) / 100 : null, (v) => Number.isFinite(v) && v >= MIN_GROUND_SAMPLES_PER_SEC),
      framesPerSec: expect('framesPerSec', Math.round(((framesEnd - framesArm) / secs) * 100) / 100, (v) => v >= MIN_FRAMES_PER_SEC),
      samplesPerUpdate: expect('samplesPerUpdate', read.updates ? Math.round(((read.groundSampleCount - read.gh0) / read.updates) * 100) / 100 : null, (v) => Number.isFinite(v) && v >= MIN_SAMPLES_PER_UPDATE),
      consoleErrs: expect('consoleErrs', consoleErrs, (v) => Number.isFinite(v) && v <= MAX_CONSOLE_ERRS),
      playerMovedM: expect('playerMovedM', (posArm && read.pos) ? Math.round(Math.hypot(read.pos[0] - posArm[0], read.pos[1] - posArm[1], read.pos[2] - posArm[2]) * 100) / 100 : null, WALK ? (v) => Number.isFinite(v) && v >= MIN_PLAYER_MOVED_M : (v) => Number.isFinite(v) && v >= 0),
      particles: expect('particles', read.particles, (v) => Number.isFinite(v) && v > 0),
      activeCount: expect('activeCount', read.activeCount, (v) => Number.isFinite(v) && v > 0),
      type: expect('type', read.type, (v) => v === WEATHER),
      intensity: expect('intensity', read.intensity, (v) => Number.isFinite(v) && v > 0),
    }
    report.profileCaptured = expect('profileCaptured', profile !== null, (v) => v === true)
    if (profile) {
      const byId = new Map()
      for (const n of profile.nodes) byId.set(n.id, n)
      const self = new Map()
      let totalUs = 0
      const samples = profile.samples || [], deltas = profile.timeDeltas || []
      for (let i = 0; i < samples.length; i++) {
        totalUs += deltas[i] || 0
        const n = byId.get(samples[i])
        if (!n) continue
        const cf = n.callFrame || {}
        const key = (cf.functionName || '(anon)') + ' @ ' + String(cf.url || '').split('/').pop() + ':' + (cf.lineNumber != null ? cf.lineNumber + 1 : '?')
        self.set(key, (self.get(key) || 0) + (deltas[i] || 0))
      }
      const rows = [...self.entries()].map(([k, us]) => ({ key: k, msPerSec: Math.round((us / 1000 / secs) * 1000) / 1000, pct: Math.round((us / totalUs) * 10000) / 100 }))
      rows.sort((a, b) => b.msPerSec - a.msPerSec)
      const groundRows = rows.filter((r) => /groundHeightLocal|heightFn|_patchHeightOrNull|node|heightAt|Weather|_respawn|_groundHeight|solveSurfaceY/.test(r.key))
      report.profileSamples = expect('profileSamples', samples.length, (v) => v > 0)
      report.profileTotalMsPerSec = expect('profileTotalMsPerSec', Math.round((totalUs / 1000 / secs) * 100) / 100, (v) => v > 0)
      report.profileGroundRowsMsPerSec = expect('profileGroundRowsMsPerSec', Math.round(groundRows.reduce((a, r) => a + r.msPerSec, 0) * 1000) / 1000, (v) => v > 0)
      context.topSelfMsPerSec = rows.slice(0, 12)
      context.groundRowsMsPerSec = groundRows.slice(0, 12)
    }
    console.log('[weather-gh] context ' + JSON.stringify(context, null, 2))
    console.log('[weather-gh] measurements ' + JSON.stringify(report, null, 2))
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
  console.error('[weather-gh] threw: ' + String((e && e.stack) || e))
  failures.push('arm threw before it could decide: ' + String((e && e.message) || e))
  for (const f of failures) console.log(`FAIL: ${f}`)
  console.log(`RESULT: FAIL (${failures.length} of ${Math.max(measurements.length, failures.length)} measurement(s))`)
  exitAfterQuiesce(1)
})
