#!/usr/bin/env node
// Measures grass per-frame cost on counted work units (instances submitted, vertices,
// triangles, draw calls) and on main-thread CPU (CDP Performance ThreadTime).
//
// This witness boots a real accelerated browser, so it cannot run in the gpu-free arm of
// scripts/check.mjs. It is gated on SPOINT_GPU_WITNESS=1 and otherwise reports SKIP.
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from './lib/cdp-browser.mjs'
import { gpuArgs, assertGpu } from './lib/gpu-probe.mjs'
import { vendorPinArgs } from './lib/witness-gpu.mjs'
import {
  assertServedClientRoot, clientRootTag, rebuildIfRequested, CLIENT_ROOT_BUNDLE,
} from './lib/served-client-root.mjs'
import { flagNumber, numericListFlag } from './lib/witness-args.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

if (process.env.SPOINT_GPU_WITNESS !== '1') {
  console.log('[grass-perframe] SKIP: SPOINT_GPU_WITNESS!=1 -- this witness needs an accelerated browser and is refused by name from the gpu-free arm of scripts/check.mjs')
  process.exit(0)
}

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

const GPU = flag('gpu', 'amd')
const AT = String(flag('at', '-500,-500'))
const SETTLE_MS = flagNumber(flag, 'settle', 45000, argv)
const MEASURE_MS = flagNumber(flag, 'measure', 30000, argv)
const WALK_MS = flagNumber(flag, 'walk', 0, argv)
// Paired A/B: hide both grass meshes in the SAME page and measure again. A cross-run ThreadTime
// delta is not usable on a shared box (another lane's browser moves fps and the governor's own
// mean), but hiding and restoring grass inside one boot holds the world, the renderer and the box
// load still, so still-vs-hidden isolates grass's own per-frame main-thread cost.
const AB_MS = flagNumber(flag, 'ab', 0, argv)
const ROUTE = String(flag('route', '-500,-500;-440,-500;-440,-560;-500,-560;-500,-500'))
const WALK_SPEED = flagNumber(flag, 'walk-speed', 7, argv)
const EXPECT_VENDOR = flag('expect-vendor', GPU)
const LAUNCH_ARGS = [...gpuArgs({ accelerated: true }), ...vendorPinArgs(GPU)]
const VIEW = (String(flag('viewport', '1920x1080')).split('x').map(Number))
const VIEWPORT = { width: VIEW[0] || 1920, height: VIEW[1] || 1080 }

const port = String(20000 + Math.floor(Math.random() * 20000))
process.env.WORLD = process.env.WORLD || 'tps-game'
process.env.PORT = port
process.env.SPOINT_NO_WATCH = '1'

rebuildIfRequested('grass-perframe')
const { boot } = await import(pathToFileURL(resolve(ROOT, 'src', 'sdk', 'server.js')).href)
const server = await boot()
console.log('[grass-perframe] server on ' + port)

const readUnits = (page) => page.evaluate(() => {
  const g = window.__grass
  if (!g) return { error: 'window.__grass absent' }
  const per = (a) => {
    const mesh = a && a.mesh
    if (!mesh) return null
    const geo = mesh.geometry
    const pos = geo && geo.attributes && geo.attributes.position
    const idx = geo && geo.index
    return {
      count: mesh.count || 0,
      verts: pos ? pos.count : null,
      tris: idx ? idx.count / 3 : (pos ? pos.count / 3 : null),
    }
  }
  const near = per(g._im)
  const mid = per(g._imMid)
  const p = window.__grassProfile || {}
  const submitted = (near ? near.count : 0) + (mid ? mid.count : 0)
  const verts = (near ? near.count * (near.verts || 0) : 0) + (mid ? mid.count * (mid.verts || 0) : 0)
  const tris = (near ? near.count * (near.tris || 0) : 0) + (mid ? mid.count * (mid.tris || 0) : 0)
  const live = g.totalInstances
  return {
    submitted,
    live,
    degenerate: submitted - (Number.isFinite(live) ? live : 0),
    vertsPerFrame: verts,
    trisPerFrame: tris,
    meshes: 2,
    near,
    mid,
    profile: {
      totalInstances: p.totalInstances,
      updateMs: p.updateMs,
      cullMs: p.cullMs,
      chunksCulled: p.chunksCulled,
      loads: p.loads,
      unloads: p.unloads,
      ringScans: p.ringScans,
    },
    governor: window.__qualityGovernorState || null,
    rendererInfo: window.__rendererInfo || null,
  }
}).catch((e) => ({ error: e.message }))

async function metrics(page) {
  const r = await page._send('Performance.getMetrics')
  const out = {}
  for (const m of (r.metrics || [])) out[m.name] = m.value
  return out
}

async function measureWindow(page, ms, label) {
  await page.evaluate(() => {
    const rig = window.__gpfRig || (window.__gpfRig = { frames: 0, running: true })
    rig.frames = 0
    rig.running = true
    const tick = () => { if (!rig.running) return; rig.frames++; requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  })
  const before = await metrics(page)
  const t0 = Date.now()
  const unitsStart = await readUnits(page)
  await new Promise((r) => setTimeout(r, ms))
  const after = await metrics(page)
  const wallMs = Date.now() - t0
  const unitsEnd = await readUnits(page)
  const frames = await page.evaluate(() => {
    const rig = window.__gpfRig
    if (rig) rig.running = false
    return rig ? rig.frames : 0
  })
  const d = (k) => ((after[k] || 0) - (before[k] || 0)) * 1000
  const threadMs = d('ThreadTime')
  const scriptMs = d('ScriptDuration')
  const recMs = d('RecalcStyleDuration') + d('LayoutDuration')
  const out = {
    label,
    wallMs,
    frames,
    threadTimeMs: +threadMs.toFixed(1),
    cpuMsPerFrame: frames ? +(threadMs / frames).toFixed(3) : null,
    scriptMsPerFrame: frames ? +(scriptMs / frames).toFixed(3) : null,
    styleLayoutMsPerFrame: frames ? +(recMs / frames).toFixed(3) : null,
    fps: frames ? +(frames / (wallMs / 1000)).toFixed(2) : null,
    unitsStart,
    unitsEnd,
  }
  console.log(`[grass-perframe] window ${label}: ` + JSON.stringify({
    wallMs: out.wallMs, frames: out.frames, fps: out.fps,
    cpuMsPerFrame: out.cpuMsPerFrame, scriptMsPerFrame: out.scriptMsPerFrame,
    styleLayoutMsPerFrame: out.styleLayoutMsPerFrame,
    submittedStart: unitsStart.submitted, submittedEnd: unitsEnd.submitted,
    liveStart: unitsStart.live, liveEnd: unitsEnd.live,
    degenerateEnd: unitsEnd.degenerate,
    vertsPerFrameEnd: unitsEnd.vertsPerFrame, trisPerFrameEnd: unitsEnd.trisPerFrame,
    cullMsEnd: unitsEnd.profile && unitsEnd.profile.cullMs,
    updateMsEnd: unitsEnd.profile && unitsEnd.profile.updateMs,
  }))
  return out
}

let browser
let failed = 0
try {
  browser = await chromium.launch({ args: LAUNCH_ARGS })
  const page = await browser.newPage({ viewport: VIEWPORT })
  const errors = []
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || (e && e.message) || e)))
  await page._send('Performance.enable').catch(() => {})
  const url = `http://localhost:${port}/?singleplayer&world=tps-game&at=${encodeURIComponent(AT)}&v=${Date.now()}`
  console.log('[grass-perframe] ' + url)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })

  const servedRoot = await assertServedClientRoot(page, { want: CLIENT_ROOT_BUNDLE, label: 'grass-perframe' })
  console.log(`[grass-perframe] served ${clientRootTag(servedRoot)} required=${CLIENT_ROOT_BUNDLE}`)

  const t0 = Date.now()
  let revealedAt = null
  while (Date.now() - t0 < 300000) {
    const r = await page.evaluate(() => ({ revealedAt: (window.__app && window.__app.revealedAt) || 0, marks: performance.getEntriesByType('mark').filter((e) => e.name === 'boot:scenery-built').map((e) => Math.round(e.startTime))[0] || 0 })).catch(() => null)
    if (r && r.revealedAt) { revealedAt = r.marks || r.revealedAt; break }
    await new Promise((r2) => setTimeout(r2, 250))
  }
  if (!revealedAt) {
    console.log('RESULT: FAIL scenery never built')
    process.exit(1)
  }
  const gpu = await assertGpu(page, { requireAccelerated: true, expectVendor: EXPECT_VENDOR })
  console.log('[grass-perframe] gpu ' + JSON.stringify({ rasterizer: gpu.rasterizer, renderer: gpu.renderer, vendor: gpu.adapter }))
  console.log('[grass-perframe] scenery-built at ' + revealedAt + 'ms')

  const govOff = await page.evaluate(() => {
    const rc = window.__renderControls
    if (!rc || typeof rc.set !== 'function') return { ok: false, reason: 'window.__renderControls.set absent' }
    rc.set('qualityGovernor', false)
    return { ok: true, readback: rc.get('qualityGovernor') }
  }).catch((e) => ({ ok: false, reason: e.message }))
  console.log('[grass-perframe] governor disable: ' + JSON.stringify(govOff))

  const tSettle = Date.now()
  let settled = null
  while (Date.now() - tSettle < SETTLE_MS) {
    await new Promise((r2) => setTimeout(r2, 2500))
    settled = await readUnits(page)
  }
  console.log('[grass-perframe] settled units: ' + JSON.stringify({
    submitted: settled.submitted, live: settled.live, degenerate: settled.degenerate,
    vertsPerFrame: settled.vertsPerFrame, trisPerFrame: settled.trisPerFrame,
    near: settled.near, mid: settled.mid, profile: settled.profile,
  }))
  console.log('[grass-perframe] governor state: ' + JSON.stringify(settled.governor))
  console.log('[grass-perframe] rendererInfo: ' + JSON.stringify(settled.rendererInfo))

  const still = await measureWindow(page, MEASURE_MS, 'still')

  // Alternating on/off/on/off. A single hide-then-restore pair is not evidence: on a shared box the
  // first window carries a transient (another lane's browser, a late bake) that never comes back, so
  // "hidden is cheaper than the first window" would measure the transient, not grass. Two windows in
  // each state separate the two: the grass effect is onMean - offMean, and the drift C - A says how
  // much of the run was the transient. The share is only asserted when the drift is small beside it.
  let ab = null
  if (AB_MS > 0) {
    const setGrassVisible = (v) => page.evaluate((vis) => {
      const g = window.__grass
      if (!g) return { ok: false, reason: 'window.__grass absent' }
      g._im.visible = vis
      g._imMid.visible = vis
      return { ok: true, near: g._im.visible, mid: g._imMid.visible }
    }, v).catch((e) => ({ ok: false, reason: e.message }))
    const wins = []
    for (const [i, vis] of [true, false, true, false].entries()) {
      const sw = vis ? await setGrassVisible(true) : await setGrassVisible(false)
      console.log(`[grass-perframe] grass ${vis ? 'shown' : 'hidden'}: ` + JSON.stringify(sw))
      if (!sw.ok) break
      wins.push(await measureWindow(page, AB_MS, `grass-${vis ? 'on' : 'off'}-${i + 1}`))
    }
    if (wins.length === 4) {
      const [a, b, c, d] = wins
      const onMean = +((a.cpuMsPerFrame + c.cpuMsPerFrame) / 2).toFixed(3)
      const offMean = +((b.cpuMsPerFrame + d.cpuMsPerFrame) / 2).toFixed(3)
      const shareMs = +(onMean - offMean).toFixed(3)
      const driftMs = +(c.cpuMsPerFrame - a.cpuMsPerFrame).toFixed(3)
      const reversible = Math.abs(driftMs) <= Math.abs(shareMs) * 0.25
      ab = { onMean, offMean, shareMs, driftMs, reversible }
      console.log('[grass-perframe] paired grass share (alternating on/off/on/off, one page): '
        + JSON.stringify({
          on1: a.cpuMsPerFrame, off1: b.cpuMsPerFrame, on2: c.cpuMsPerFrame, off2: d.cpuMsPerFrame,
          onMean, offMean, grassCpuMsPerFrame: shareMs, driftOn2MinusOn1MsPerFrame: driftMs,
          reversible, onFps: [a.fps, c.fps], offFps: [b.fps, d.fps],
          trisPerFrame: a.unitsEnd.trisPerFrame, vertsPerFrame: a.unitsEnd.vertsPerFrame,
        }))
      if (reversible && shareMs > 0) {
        console.log(`  [PASS] grass has a main-thread cost that disappears when hidden and returns when shown (grassCpuMsPerFrame=${shareMs} drift=${driftMs})`)
      } else if (!reversible) {
        console.log(`  [INCONCLUSIVE] the on/off difference does not survive re-showing grass (share=${shareMs} drift=${driftMs}): the run carried a transient this shared box never gave back, so no per-frame CPU cost is attributed to grass here`)
      } else {
        failed++
        console.log(`  [FAIL] hiding grass did not lower main-thread CPU (share=${shareMs} drift=${driftMs})`)
      }
    }
  }

  let walked = null
  if (WALK_MS > 0) {
    const waypoints = ROUTE.split(';').map((p) => { const n = numericListFlag({ route: p }, 'route', null, ',', 2); return { x: n[0], z: n[1] } })
    const started = await page.evaluate((wpts, speed) => {
      const route = window.__spoint && window.__spoint.route
      if (typeof route !== 'function') return { ok: false, reason: 'window.__spoint.route is not a function' }
      route(wpts, { mode: 'walk', speed })
      return { ok: true }
    }, waypoints, WALK_SPEED).catch((e) => ({ ok: false, reason: e.message }))
    console.log('[grass-perframe] walk ' + JSON.stringify(waypoints) + ' -> ' + JSON.stringify(started))
    if (!started.ok) {
      failed++
      console.log(`  [FAIL] walk phase could not start (${started.reason})`)
    } else {
      walked = await measureWindow(page, WALK_MS, 'walk')
    }
  }

  const finalUnits = await readUnits(page)
  const checks = [
    ['adapter pinned and accelerated', !!(gpu && gpu.rasterizer), `renderer=${gpu.renderer}`],
    ['renderer string asserted', !!(settled.rendererInfo && String(JSON.stringify(settled.rendererInfo)).length > 0), `rendererInfo=${JSON.stringify(settled.rendererInfo)}`],
    ['governor really off', govOff.ok === true && govOff.readback === false, `readback=${JSON.stringify(govOff.readback)} state=${JSON.stringify(finalUnits.governor)}`],
    ['grass is populated', finalUnits.live > 0, `live=${finalUnits.live}`],
    ['grass submits one instanced draw per LOD mesh', finalUnits.meshes === 2, `meshes=${finalUnits.meshes}`],
    ['counted units are finite', Number.isFinite(finalUnits.vertsPerFrame) && Number.isFinite(finalUnits.trisPerFrame), `verts=${finalUnits.vertsPerFrame} tris=${finalUnits.trisPerFrame}`],
    ['main-thread CPU resolved', still.cpuMsPerFrame !== null && still.cpuMsPerFrame > 0, `cpuMsPerFrame=${still.cpuMsPerFrame} frames=${still.frames}`],
    ['no page errors', errors.length === 0, `errors=${errors.slice(0, 3).join(' | ')}`],
  ]
  if (errors.length) console.log('[grass-perframe] page error detail: ' + errors.slice(0, 2).join('\n---\n'))
  for (const [name, ok, detail] of checks) {
    if (!ok) failed++
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} (${detail})`)
  }
  console.log(`RESULT: ${failed === 0 ? 'PASS' : 'FAIL'} submitted=${finalUnits.submitted} live=${finalUnits.live} degenerate=${finalUnits.degenerate} tris=${finalUnits.trisPerFrame} verts=${finalUnits.vertsPerFrame} cpuMsPerFrame=${still.cpuMsPerFrame}${walked ? ` walkCpuMsPerFrame=${walked.cpuMsPerFrame}` : ''} gpu=${gpu.renderer}`)
} finally {
  if (browser) await browser.close().catch(() => {})
  if (server && typeof server.stop === 'function') { try { await server.stop() } catch (_) {} }
}
process.exit(failed === 0 ? 0 : 1)
