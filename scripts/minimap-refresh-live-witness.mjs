#!/usr/bin/env node
// Measures the minimap-refresh deduplication in the running client, and mutates it away.
//
// The node arm (scripts/minimap-refresh-dedup-witness.mjs) prices the carry and proves it is a byte
// copy. This arm proves the shipped HUD actually does it: the player walks, the minimap drift
// trigger fires, and window.__minimapHUD.stats counts how many terrain cells each refresh had to
// solve. Halfway through, __minimapNoCarry turns the carry off inside the same page, so the
// "before" and "after" numbers come from one boot on one machine with one GPU.
//
// Ground-source transparency: the counter is installed through frame.registerGroundSource under the
// source name already in force. Assigning frame.groundHeightLocal directly would flip
// frame.groundSource to 'substituted', which switches PlacementChart.surfaceAlongDir from one
// elevationAtDir call to a 16-iteration ground loop and manufactures most of what it measures.
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

const WORLD = String(flag('world', 'tps-game'))
const GPU = String(flag('gpu', 'nvidia'))
const MIN_REFRESHES = Math.round(flagNumber(flag, 'refreshes', 3, argv))
const PHASE_BUDGET_MS = Math.round(flagNumber(flag, 'phase-ms', 180000, argv))

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

function armGroundCounter() {
  const t = window.__terrain
  if (!t || !t.frame) return { error: 'no window.__terrain.frame' }
  const f = t.frame
  if (typeof f.registerGroundSource !== 'function') return { error: 'frame exposes no registerGroundSource' }
  const srcAtArm = f.groundSource
  const orig = f.groundHeightLocal
  if (typeof orig !== 'function') return { error: 'frame.groundHeightLocal is not a function' }
  const st = { calls: 0, ms: 0, t0: performance.now(), frames0: window.__frames || 0 }
  window.__groundStats = st
  const installed = f.registerGroundSource(srcAtArm, function (x, z, yGuess) {
    const at = performance.now()
    let h = NaN, err = null
    try { h = orig.call(this, x, z, yGuess) } catch (e) { err = e }
    st.calls++
    st.ms += performance.now() - at
    if (err) throw err
    return h
  })
  const transparent = f.groundSource === srcAtArm && typeof f.groundHeightLocal === 'function'
  return { ok: true, groundSourceAtArm: srcAtArm, installed, transparent }
}

function readPhase() {
  const st = window.__groundStats
  const mm = window.__minimapHUD
  return {
    ground: st ? { calls: st.calls, ms: Math.round(st.ms * 100) / 100, frames: (window.__frames || 0) - st.frames0 } : null,
    minimap: mm && mm.stats ? {
      refreshes: mm.stats.refreshes,
      cellsSampled: mm.stats.cellsSampled,
      cellsCarried: mm.stats.cellsCarried,
      refreshesWithCarry: mm.stats.refreshesWithCarry,
    } : null,
  }
}

async function main() {
  const port = String(20000 + Math.floor(Math.random() * 20000))
  process.env.WORLD = process.env.WORLD || WORLD
  process.env.PORT = port
  process.env.SPOINT_NO_WATCH = '1'
  const { boot } = await import(pathToFileURL(resolve(ROOT, 'src', 'sdk', 'server.js')).href)
  const server = await boot()
  console.log(`[minimap-live] server up on ${port} world=${process.env.WORLD}`)

  const browser = await chromium.launch({ args: [...vendorLaunchArgs(GPU)] })
  try {
    const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT })
    page.on('pageerror', (e) => console.log('[minimap-live] pageerror: ' + String((e && e.message) || e).slice(0, 300)))
    const url = `http://127.0.0.1:${port}/?multiplayer&world=${WORLD}&v=${Date.now()}`
    console.log('[minimap-live] navigating ' + url)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })

    const bootStart = Date.now()
    let ready = false
    let lastLog = 0
    while (Date.now() - bootStart < 180000) {
      const r = await page.evaluate(() => ({
        terrain: !!(window.__terrain && window.__terrain.frame),
        revealedAt: (window.__app && window.__app.revealedAt) || 0,
        connected: !!(window.__client && window.__client.connected),
        minimap: !!(window.__minimapHUD && window.__minimapHUD.stats),
      })).catch(() => null)
      if (r && r.terrain && r.revealedAt && r.connected && r.minimap) { ready = true; break }
      if (Date.now() - lastLog > 15000) { lastLog = Date.now(); console.log(`[minimap-live] boot t+${Math.round((Date.now() - bootStart) / 1000)}s ${JSON.stringify(r)}`) }
      await new Promise((r2) => setTimeout(r2, 1000))
    }
    if (!ready) throw new Error('page never reached terrain+revealedAt+connected+minimap')
    console.log(`[minimap-live] boot ok in ${Math.round((Date.now() - bootStart) / 1000)}s`)

    const gpu = await assertGpu(page, { requireAccelerated: true, expectVendor: GPU })
    console.log(`[minimap-live] gpu=${GPU} accelerated=${gpu.accelerated} rasterizer=${gpu.rasterizer} renderer=${gpu.renderer || 'none'}`)
    if (gpu.accelerated !== true) throw new Error('gpu arm not accelerated: ' + JSON.stringify(gpu))

    const armed = await page.evaluate(armGroundCounter)
    console.log('[minimap-live] armed: ' + JSON.stringify(armed))
    if (!armed || !armed.ok) throw new Error('arm failed: ' + JSON.stringify(armed))
    expect('instrumentTransparent', armed.transparent, (v) => v === true)
    expect('groundSourceAtArm', armed.groundSourceAtArm, (v) => typeof v === 'string' && v.length > 0)

    await page.evaluate(() => {
      window.__frames = 0
      const tick = () => { window.__frames++; requestAnimationFrame(tick) }
      requestAnimationFrame(tick)
      const s = window.__groundStats
      s.frames0 = window.__frames
      return true
    })

    const posStart = await page.evaluate(() => {
      const cls = (window.__client && window.__client.getLocalState) ? window.__client.getLocalState() : null
      const v = cls && cls.position
      return v ? [v[0], v[1], v[2]] : null
    })

    // Walk until the minimap has finished MIN_REFRESHES refreshes with the carry in force.
    await page.keyboard.down('KeyW').catch(() => {})
    const phase = async (label, wantRefreshes) => {
      const s0 = await page.evaluate(readPhase)
      const start = Date.now()
      let turn = 0
      let last = s0.minimap ? s0.minimap.refreshes : 0
      while (Date.now() - start < PHASE_BUDGET_MS) {
        await new Promise((r) => setTimeout(r, 2000))
        const key = (turn++ % 2 === 0) ? 'KeyA' : 'KeyD'
        await page.keyboard.down(key).catch(() => {})
        await new Promise((r) => setTimeout(r, 400))
        await page.keyboard.up(key).catch(() => {})
        const s = await page.evaluate(readPhase)
        if (!s.minimap) continue
        if (s.minimap.refreshes - last >= wantRefreshes) { await page.keyboard.up(key).catch(() => {}); return { s0, s1: s } }
      }
      await page.keyboard.up('KeyW').catch(() => {})
      const s = await page.evaluate(readPhase)
      return { s0, s1: s }
    }

    const withCarry = await phase('carry', MIN_REFRESHES)
    console.log('[minimap-live] carry on: ' + JSON.stringify(withCarry.s1))
    await page.evaluate(() => { window.__minimapNoCarry = true; return true })
    const noCarry = await phase('nocarry', MIN_REFRESHES)
    console.log('[minimap-live] carry off: ' + JSON.stringify(noCarry.s1))
    await page.keyboard.up('KeyW').catch(() => {})

    const posEnd = await page.evaluate(() => {
      const cls = (window.__client && window.__client.getLocalState) ? window.__client.getLocalState() : null
      const v = cls && cls.position
      return v ? [v[0], v[1], v[2]] : null
    })
    const moved = (posStart && posEnd) ? Math.round(Math.hypot(posEnd[0] - posStart[0], posEnd[1] - posStart[1], posEnd[2] - posStart[2]) * 100) / 100 : null

    const d = (a, b, k) => (a && b ? b[k] - a[k] : null)
    const per = (n, r) => (r > 0 ? Math.round((n / r) * 100) / 100 : null)

    const carryRefreshes = d(withCarry.s0.minimap, withCarry.s1.minimap, 'refreshes')
    const carrySampled = d(withCarry.s0.minimap, withCarry.s1.minimap, 'cellsSampled')
    const carryCarried = d(withCarry.s0.minimap, withCarry.s1.minimap, 'cellsCarried')
    const carryWithCarry = d(withCarry.s0.minimap, withCarry.s1.minimap, 'refreshesWithCarry')
    const nocarryRefreshes = d(noCarry.s0.minimap, noCarry.s1.minimap, 'refreshes')
    const nocarrySampled = d(noCarry.s0.minimap, noCarry.s1.minimap, 'cellsSampled')
    const nocarryCarried = d(noCarry.s0.minimap, noCarry.s1.minimap, 'cellsCarried')

    const carryCalls = d(withCarry.s0.ground, withCarry.s1.ground, 'calls')
    const carryFrames = d(withCarry.s0.ground, withCarry.s1.ground, 'frames')
    const carryMs = d(withCarry.s0.ground, withCarry.s1.ground, 'ms')
    const nocarryCalls = d(noCarry.s0.ground, noCarry.s1.ground, 'calls')
    const nocarryFrames = d(noCarry.s0.ground, noCarry.s1.ground, 'frames')
    const nocarryMs = d(noCarry.s0.ground, noCarry.s1.ground, 'ms')

    const report = {
      playerMovedM: expect('playerMovedM', moved, (v) => finite(v) && v >= 5),
      carry_refreshes: expect('carry_refreshes', carryRefreshes, (v) => Number.isFinite(v) && v >= 1),
      carry_cellsSampledPerRefresh: expect('carry_cellsSampledPerRefresh', per(carrySampled, carryRefreshes), (v) => finite(v) && v > 0),
      carry_cellsCarriedPerRefresh: expect('carry_cellsCarriedPerRefresh', per(carryCarried, carryRefreshes), (v) => finite(v) && v > 0),
      carry_refreshesWithCarry: expect('carry_refreshesWithCarry', carryWithCarry, (v) => Number.isFinite(v) && v >= 1),
      nocarry_refreshes: expect('nocarry_refreshes', nocarryRefreshes, (v) => Number.isFinite(v) && v >= 1),
      nocarry_cellsSampledPerRefresh: expect('nocarry_cellsSampledPerRefresh', per(nocarrySampled, nocarryRefreshes), (v) => finite(v) && v > 0),
      nocarry_cellsCarried: expect('nocarry_cellsCarried', nocarryCarried, (v) => Number.isFinite(v) && v === 0),
      sampledPerRefresh_reductionPct: expect('sampledPerRefresh_reductionPct', Math.round((1 - per(carrySampled, carryRefreshes) / per(nocarrySampled, nocarryRefreshes)) * 10000) / 100, (v) => finite(v) && v >= 50),
      carry_groundCallsPerFrame: expect('carry_groundCallsPerFrame', per(carryCalls, carryFrames), (v) => finite(v) && v >= 0),
      nocarry_groundCallsPerFrame: expect('nocarry_groundCallsPerFrame', per(nocarryCalls, nocarryFrames), (v) => finite(v) && v >= 0),
      carry_groundMsPerFrame: expect('carry_groundMsPerFrame', per(carryMs, carryFrames) === null ? null : Math.round(per(carryMs, carryFrames) * 10000) / 10000, finite),
      nocarry_groundMsPerFrame: expect('nocarry_groundMsPerFrame', per(nocarryMs, nocarryFrames) === null ? null : Math.round(per(nocarryMs, nocarryFrames) * 10000) / 10000, finite),
    }
    console.log('[minimap-live] measurements ' + JSON.stringify(report, null, 2))
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
  console.error('[minimap-live] threw: ' + String((e && e.stack) || e))
  console.log('RESULT: FAIL (1 of 1 measurement(s))')
  exitAfterQuiesce(1)
})
