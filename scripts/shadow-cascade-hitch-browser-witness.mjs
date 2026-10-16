#!/usr/bin/env node
// PERF-shadow-cascade-redraw-hitch-1013, browser arm.
//
// What a cascade redraw costs per frame, measured on the real client: the same world, the same walk
// and the same instrument with 1 cascade and with 3, so the difference between the two arms is the
// cost of the far cascades and nothing else.
//
// Two instruments, both admissible: rAF-to-rAF wall with the frame rate limit and GPU vsync disabled
// (frame-time-gate.mjs keeps those flags behind SPOINT_UNLOCK_RAF; perf-run.mjs never sets them, so a
// perf-run median is a multiple of the refresh period), and main-thread CPU cost, which is not
// vsync-quantized and is what resolves a difference the wall clock can only show in whole frames.
// No per-pass GPU figure is quoted: docs/measurement-figures.md s0 invalidated every one of them.
//
// The adapter is pinned with --use-adapter-luid and window.__rendererInfo is asserted, because Chrome
// reports accelerated while ignoring an LUID it cannot resolve.
//
// Registered behind SPOINT_GPU_WITNESS, never in the gpu-free arm: it boots a real browser.
//   node scripts/gpulock.mjs run <owner> -- node scripts/shadow-cascade-hitch-browser-witness.mjs
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, DEFAULT_VIEWPORT } from './lib/cdp-browser.mjs'
import { vendorLaunchArgs } from './lib/witness-gpu.mjs'
import { witnessGpu } from './lib/gpu-probe.mjs'
import { assertServedClientRoot, rebuildIfRequested, CLIENT_ROOT_BUNDLE } from './lib/served-client-root.mjs'

const LABEL = 'shadow-cascade-hitch'
const LF = String.fromCharCode(10)
const flag = (name, dflt = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const PORT = flag('port', '3291')
const WORLD = flag('world', 'tps-game')
const GPU_MODE = flag('gpu', 'accelerated')
const SETTLE_MS = Number(flag('settle', '4000'))
const MEASURE_MS = Number(flag('measure', '15000'))
const LEG_MS = Number(flag('leg', '5000'))
const TIMEOUT_MS = Number(flag('timeout', '240000'))
const WALK_TIMEOUT_MS = Number(flag('walk-timeout', '180000'))
const ARMS = String(flag('arms', '1,3')).split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= 3)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRATCH = resolve(flag('scratch', join(tmpdir(), 'spoint-shadow-cascade-hitch')))
const UNLOCKED_RAF_ARGS = process.env.SPOINT_UNLOCK_RAF === '0' ? [] : ['--disable-frame-rate-limit', '--disable-gpu-vsync']

const checks = []
function expect(label, got, ok) { checks.push({ label, got, ok: ok === true }); return ok === true }
const jsonLine = (o) => JSON.stringify(o)

const PLAYABLE_EXPR = `!!(window.__app && window.__app.revealedAt != null && (() => {
  const c = window.__client && window.__client.getLocalState ? window.__client.getLocalState() : null
  return c && c.position && Number.isFinite(c.position[0]) && Number.isFinite(c.position[1])
})())`

const SAMPLE_SRC = `(() => {
  const W = window
  if (W.__scRig) return { ok: false, reason: 'already installed' }
  const rig = { wall: [], cpu: [], redraws: [], perCascade: null }
  W.__scRig = rig
  let counts = null
  const bind = () => {
    const pipe = W.__shadowPipeline
    if (!pipe) return false
    const lights = pipe.lights || []
    counts = lights.map(() => 0)
    lights.forEach((l, i) => {
      const sh = l && l.shadow
      if (!sh) return
      let v = sh.needsUpdate
      Object.defineProperty(sh, 'needsUpdate', {
        configurable: true,
        get() { return v },
        set(nv) { if (nv && !v) counts[i]++; v = nv },
      })
    })
    rig.perCascade = counts
    return true
  }
  bind()
  let last = -1
  let primed = false
  function tick(ts) {
    if (!counts && !bind()) { requestAnimationFrame(tick); return }
    const dt = last < 0 ? 0 : ts - last
    last = ts
    if (primed && dt > 0) {
      rig.wall.push(dt)
      rig.cpu.push(W.__perf ? W.__perf.lastMs : -1)
      rig.redraws.push(counts.reduce((a, b) => a + b, 0))
    }
    primed = true
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  rig.reset = () => { rig.wall.length = 0; rig.cpu.length = 0; rig.redraws.length = 0 }
  return { ok: true, cascades: counts ? counts.length : 0 }
})()`

const REPORT_SRC = `(() => {
  const rig = window.__scRig
  if (!rig) return { error: 'no __scRig' }
  const pct = (arr, p) => { const a = arr.filter((v) => Number.isFinite(v) && v > 0).sort((x, y) => x - y); return a.length ? +a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(3) : null }
  const dist = (arr) => ({ n: arr.length, p50: pct(arr, 0.5), p95: pct(arr, 0.95), p99: pct(arr, 0.99), max: arr.length ? +Math.max.apply(null, arr).toFixed(3) : null })
  return {
    frames: rig.wall.length,
    wall: dist(rig.wall),
    cpu: dist(rig.cpu.filter((v) => v >= 0)),
    redrawsPerFrame: dist(rig.redraws),
    perCascade: rig.perCascade ? rig.perCascade.slice() : null,
  }
})()`

function finish(verdict, detail) {
  console.log(`RESULT: ${verdict} arm=${GPU_MODE} label=${LABEL} -- ${String(detail).split(LF).join(' ')}`)
  process.exit(verdict === 'PASS' ? 0 : 1)
}
const fail = (d) => finish('FAIL', d)

async function browserArm() {
  process.env.WORLD = process.env.WORLD || WORLD
  process.env.PORT = PORT
  process.env.SPOINT_NO_WATCH = '1'
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(SCRATCH, { recursive: true })
  rebuildIfRequested(LABEL)
  const { boot } = await import(pathToFileURL(resolve(REPO_ROOT, 'src', 'sdk', 'server.js')).href)
  const server = await boot({ storageDir: join(SCRATCH, 'data') })
  const base = `http://127.0.0.1:${PORT}`
  let browser = null
  const results = []
  let gpuName = null
  try {
    browser = await chromium.launch({ args: vendorLaunchArgs(GPU_MODE, UNLOCKED_RAF_ARGS) })
    for (const cascades of ARMS) {
      const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT })
      const pageErrors = []
      page.on('pageerror', (e) => pageErrors.push(String(e)))
      await page._send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { window.__shadowCascades = ${cascades} })()` })
      await page.goto(`${base}/?singleplayer&dprOff=true`, { waitUntil: 'domcontentloaded' })
      const root = await assertServedClientRoot(page, { want: CLIENT_ROOT_BUNDLE, label: LABEL }).catch((e) => e)
      if (root instanceof Error) fail(root.message)
      const gpu = await witnessGpu(page, GPU_MODE)
      gpuName = gpu.renderer || gpu.adapter || null
      const rendererInfo = await page.evaluate(`(() => window.__rendererInfo ? { renderer: window.__rendererInfo.renderer, vendor: window.__rendererInfo.vendor } : null })()`)
      expect(`cascades=${cascades}: window.__rendererInfo names the adapter, so the LUID pin landed`, !!rendererInfo, !!rendererInfo)
      const t0 = Date.now()
      let playable = false
      while (Date.now() - t0 < TIMEOUT_MS) {
        const st = await page.evaluate(`({ playable: !!(${PLAYABLE_EXPR}) })`).catch(() => ({}))
        if (st.playable) { playable = true; break }
        await new Promise((r) => setTimeout(r, 250))
      }
      if (!playable) fail(`cascades=${cascades}: the page never became playable within ${TIMEOUT_MS}ms (pageErrors=${pageErrors.length}${pageErrors[0] ? ': ' + pageErrors[0].slice(0, 200) : ''})`)
      const pinned = await page.evaluate(`(() => {
        const rc = window.__renderControls
        if (!rc) return { error: 'no __renderControls' }
        rc.set('qualityGovernor', false); rc.set('dprOff', true)
        return { governor: rc.get('qualityGovernor'), dprOff: rc.get('dprOff') }
      })()`)
      if (!pinned || pinned.error) fail(`cascades=${cascades}: could not pin the render controls: ${JSON.stringify(pinned)}`)
      expect(`cascades=${cascades}: the measuring arm pins qualityGovernor off`, pinned.governor, pinned.governor === false)
      expect(`cascades=${cascades}: the measuring arm pins dprOff on, so no pixel doubling is in play`, pinned.dprOff, pinned.dprOff === true)
      const live = await page.evaluate(`(() => {
        const p = window.__shadowPipeline
        return { cascadeCount: p ? p.cascadeCount : null, shadowCostProbe: typeof window.__shadowCost }
      })()`)
      expect(`cascades=${cascades}: the boot-time cascade count is the arm's`, live.cascadeCount, live.cascadeCount === cascades)
      console.log(`[${LABEL}] arm cascades=${cascades} ${jsonLine({ gpu: gpuName, rendererInfo, ...live })}`)
      await new Promise((r) => setTimeout(r, SETTLE_MS))
      const installed = await page.evaluate(SAMPLE_SRC)
      if (!installed || !installed.ok) fail(`cascades=${cascades}: the sampler never installed: ${JSON.stringify(installed)}`)
      expect(`cascades=${cascades}: the sampler bound to every cascade light`, installed.cascades, installed.cascades === cascades)
      await page.evaluate(`window.__scRig.reset()`)
      const legs = ['KeyW', 'KeyW', 'KeyW', 'KeyD', 'KeyW', 'KeyA']
      let li = 0, held = null, legAt = Date.now()
      const track = []
      const tWalk = Date.now()
      while (Date.now() - tWalk < MEASURE_MS && Date.now() - tWalk < WALK_TIMEOUT_MS) {
        const code = legs[li % legs.length]
        if (code !== held) {
          if (held) await page.keyboard.up(held).catch(() => {})
          await page.keyboard.down(code).catch(() => {})
          held = code; legAt = Date.now()
        }
        if (Date.now() - legAt >= LEG_MS) { li++; legAt = Date.now() }
        await new Promise((r) => setTimeout(r, 400))
        const p = await page.evaluate(`(() => { const c = window.__client && window.__client.getLocalState ? window.__client.getLocalState() : null; return c && c.position ? [c.position[0], c.position[1], c.position[2]] : null })()`).catch(() => null)
        if (p) track.push(p)
      }
      if (held) await page.keyboard.up(held).catch(() => {})
      let travelled = 0
      for (let i = 1; i < track.length; i++) travelled += Math.hypot(track[i][0] - track[i - 1][0], track[i][1] - track[i - 1][1], track[i][2] - track[i - 1][2])
      const report = await page.evaluate(REPORT_SRC)
      if (!report || report.error) fail(`cascades=${cascades}: the report failed: ${JSON.stringify(report)}`)
      expect(`cascades=${cascades}: the instrument counted frames`, report.frames, report.frames > 200)
      expect(`cascades=${cascades}: the player actually travelled`, travelled, travelled > 15)
      expect(`cascades=${cascades}: no uncaught page errors during the walk`, pageErrors.length, pageErrors.length === 0)
      console.log(`[${LABEL}] cascades=${cascades} travelled ${travelled.toFixed(1)}m over ${report.frames} frame(s)`)
      console.log(`[${LABEL}] cascades=${cascades} wall(rAF delta, vsync unlocked) ${jsonLine(report.wall)}`)
      console.log(`[${LABEL}] cascades=${cascades} cpu(main-thread frame cost) ${jsonLine(report.cpu)}`)
      console.log(`[${LABEL}] cascades=${cascades} cascade redraw(s)/frame ${jsonLine(report.redrawsPerFrame)} total per cascade ${jsonLine(report.perCascade)}`)
      results.push({ cascades, travelled: +travelled.toFixed(1), ...report })
      await page.close().catch(() => {})
    }
    await browser.close().catch(() => {})
    browser = null
    server.stop()
    const byC = Object.fromEntries(results.map((r) => [r.cascades, r]))
    const pair = ARMS.length >= 2 ? `${ARMS[0]} vs ${ARMS[ARMS.length - 1]}` : `${ARMS[0]}`
    const a = byC[ARMS[0]]
    const b = byC[ARMS[ARMS.length - 1]]
    if (a && b) {
      console.log(`[${LABEL}] A/B ${pair}: wall p95 ${a.wall.p95} -> ${b.wall.p95} ms, worst frame ${a.wall.max} -> ${b.wall.max} ms; cpu p95 ${a.cpu.p95} -> ${b.cpu.p95} ms, worst frame ${a.cpu.max} -> ${b.cpu.max} ms; redraw(s)/frame p95 ${a.redrawsPerFrame.p95} -> ${b.redrawsPerFrame.p95}, worst ${a.redrawsPerFrame.max} -> ${b.redrawsPerFrame.max}`)
    }
    const failed = checks.filter((c) => !c.ok)
    for (const c of failed) console.log(`[${LABEL}] FAILED ${c.label}: got ${JSON.stringify(c.got)}`)
    console.log(`[${LABEL}] checks ${checks.length - failed.length}/${checks.length} passed`)
    finish(failed.length === 0 ? 'PASS' : 'FAIL', failed.length === 0
      ? results.map((r) => `cascades=${r.cascades} wall p95=${r.wall.p95}ms max=${r.wall.max}ms cpu p95=${r.cpu.p95}ms max=${r.cpu.max}ms redraws/frame p95=${r.redrawsPerFrame.p95} max=${r.redrawsPerFrame.max} over ${r.frames} frame(s) of ${r.travelled}m`).join('; ')
      : `${failed.length} check(s) failed`)
  } catch (e) {
    if (browser) await browser.close().catch(() => {})
    server.stop()
    throw e
  }
}

browserArm().catch((e) => fail(`${e && e.stack ? e.stack : e}`))
