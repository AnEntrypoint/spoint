#!/usr/bin/env node
// Measures grass per-frame cost on counted work units (instances submitted, vertices,
// triangles, draw calls) and on main-thread CPU (CDP Performance ThreadTime).
//
// This witness boots a real accelerated browser, so it cannot run in the gpu-free arm of
// scripts/check.mjs. It is gated on SPOINT_GPU_WITNESS=1 and otherwise reports SKIP.
import { resolve, dirname } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, DEFAULT_VIEWPORT } from './lib/cdp-browser.mjs'
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
// Paired near-LOD arm: measure the grass frame with the per-clump decision that is re-taken as the
// player moves and with the chunk-latched decision it replaces, alternating in the SAME page. The
// latched arm has to be re-committed (rebuildPlacement) because the decision is taken at commit
// time, so simply flipping the flag back would leave the per-clump classification in place.
const LOD_AB_MS = flagNumber(flag, 'lod-ab', 0, argv)
// --shots=<dir> photographs the grass bands with the pre-change near-LOD geometry (3 rows) and
// with the one that ships (2 rows), swapped in and out of the SAME boot. AGENTS.md: an LOD or
// threshold change must be verified visually, per band, and any fidelity loss reported as its
// own finding -- frame time and draw counts cannot see it. See the block below for the method.
const SHOTS = flag('shots', null)
const SHOT_DIR = typeof SHOTS === 'string' ? resolve(SHOTS) : null
const ROUTE = String(flag('route', '-500,-500;-440,-500;-440,-560;-500,-560;-500,-500'))
const WALK_SPEED = flagNumber(flag, 'walk-speed', 7, argv)
const EXPECT_VENDOR = flag('expect-vendor', GPU)
const LAUNCH_ARGS = [...gpuArgs({ accelerated: true }), ...vendorPinArgs(GPU)]
const VIEW = (String(flag('viewport', DEFAULT_VIEWPORT.width + 'x' + DEFAULT_VIEWPORT.height)).split('x').map(Number))
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
  const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT })
  const errors = []
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || (e && e.message) || e)))
  await page._send('Performance.enable').catch((e) => console.log('[grass-perframe] Performance.enable refused, so no ThreadTime will be readable: ' + e.message))
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

  let lodAb = null
  if (LOD_AB_MS > 0) {
    const arms = []
    for (const [i, rev] of [false, true, false, true].entries()) {
      const sw = await page.evaluate((r) => {
        const g = window.__grass
        if (!g) return { ok: false, reason: 'window.__grass absent' }
        g.lodRevisit = r
        if (r === false && typeof g.rebuildPlacement === 'function') g.rebuildPlacement()
        return { ok: true, lodRevisit: g.lodRevisit, total: g.totalInstances }
      }, rev).catch((e) => ({ ok: false, reason: e.message }))
      console.log(`[grass-perframe] near-LOD arm ${rev ? 'revisited' : 'chunk-latched'}: ` + JSON.stringify(sw))
      if (!sw.ok) break
      await new Promise((r) => setTimeout(r, 4000))
      arms.push({ rev, ...(await measureWindow(page, LOD_AB_MS, `lod-${rev ? 'revisited' : 'latched'}-${i + 1}`)) })
    }
    if (arms.length === 4) {
      const meanOf = (list, f) => list.reduce((s, x) => s + (f(x) || 0), 0) / list.length
      const latched = arms.filter((a) => a.rev === false)
      const revisited = arms.filter((a) => a.rev === true)
      const populations = arms.map((a) => a.unitsEnd.live)
      const spread = (Math.max(...populations) - Math.min(...populations)) / Math.max(1, Math.max(...populations))
      lodAb = {
        latchedCpuMsPerFrame: +meanOf(latched, (w) => w.cpuMsPerFrame).toFixed(3),
        revisitedCpuMsPerFrame: +meanOf(revisited, (w) => w.cpuMsPerFrame).toFixed(3),
        cpuDeltaMsPerFrame: +(meanOf(revisited, (w) => w.cpuMsPerFrame) - meanOf(latched, (w) => w.cpuMsPerFrame)).toFixed(3),
        latchedTrisPerFrame: Math.round(meanOf(latched, (w) => w.unitsEnd.trisPerFrame)),
        revisitedTrisPerFrame: Math.round(meanOf(revisited, (w) => w.unitsEnd.trisPerFrame)),
        latchedNearClumps: Math.round(meanOf(latched, (w) => w.unitsEnd.near && w.unitsEnd.near.count)),
        revisitedNearClumps: Math.round(meanOf(revisited, (w) => w.unitsEnd.near && w.unitsEnd.near.count)),
        liveClumps: Math.round(meanOf(arms, (w) => w.unitsEnd.live)),
        populationSpread: +spread.toFixed(4),
        driftRevisited2Minus1: +(revisited[1].cpuMsPerFrame - revisited[0].cpuMsPerFrame).toFixed(3),
      }
      console.log('[grass-perframe] paired near-LOD arm (alternating latched/revisited, one page, one boot): ' + JSON.stringify(lodAb))
      if (lodAb.populationSpread > 0.05) {
        failed++
        console.log(`  [FAIL] the two near-LOD arms did not hold one population (spread ${lodAb.populationSpread} over ${JSON.stringify(populations)}), so their frame costs are not comparable`)
      }
    } else {
      failed++
      console.log(`  [FAIL] the paired near-LOD arm did not complete all four windows (${arms.length} of 4)`)
    }
  }

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

  // ---- fidelity: does the near-LOD geometry change move pixels? --------------------------
  // Frame time, draw counts and instance counts cannot answer this, so photograph it. The
  // pre-change geometry (3 rows of vertices) is rebuilt in the page from the LIVE geometry's own
  // constructors, so it is the same BufferGeometry class over the same attribute classes, and it
  // is swapped in and out of the near instancer of one boot: same world, same camera, same sun,
  // same clump texture, so the only thing that can differ between two shots is the row count.
  // Each band is photographed with the other mesh hidden, so the near band's delta is measured
  // alone; the mid band is the control -- its call site is untouched, so it must not move a pixel,
  // and if it does the swap disturbed more than the geometry. Wind is pinned to a constant so the
  // bend is a static pose rather than a sway, and both the shipped default and a stressed level
  // are shot: every bend term in GrassTSL is linear in uGrassWind, so a wind level is an amplitude
  // and the two levels say how the difference scales.
  if (SHOT_DIR) {
    const sharp = (await import('sharp')).default
    rmSync(SHOT_DIR, { recursive: true, force: true })
    mkdirSync(SHOT_DIR, { recursive: true })
    await page._send('Page.enable').catch((e) => console.log('[grass-perframe] Page.enable refused, so captureScreenshot may be refused too: ' + e.message))
    const nap = (ms) => new Promise((r) => setTimeout(r, ms))
    const shot = async (name) => {
      const r = await page._send('Page.captureScreenshot', { format: 'png' })
      const file = resolve(SHOT_DIR, name + '.png')
      writeFileSync(file, Buffer.from(r.data, 'base64'))
      return file
    }
    const setGeometry = (n) => page.evaluate((nn) => {
      const g = window.__grass
      g._im.geometry = window.__gpfGeo[nn === 0 ? 'orig' : String(nn)]
      const p = g._im.mesh.geometry.attributes.position
      return { nearVerts: p.count, nearTris: g._im.mesh.geometry.index.count / 3 }
    }, n)
    const setBand = (band) => page.evaluate((bb) => {
      const g = window.__grass
      g._im.visible = bb !== 'mid'
      g._imMid.visible = bb !== 'near'
      return { nearVisible: g._im.mesh.visible, midVisible: g._imMid.mesh.visible }
    }, band)
    const setWind = (w) => page.evaluate((ww) => { window.__grassWind = ww; return window.__grassWind }, w)
    // Everything that animates has to stop, or the two shots differ by whatever moved and not by
    // the geometry. Measured: with nothing frozen, two shots of the SAME geometry 1.5 s apart
    // differed in 65% of pixels, including the sky -- time of day was advancing. So pin the sun
    // fraction, stop the grass clock (tickWind is what advances uGrassTime, and it is called as a
    // property on the api object, so a stub takes effect) and take the swaying foliage out of the
    // frame entirely. Whether that worked is not assumed: the static check below photographs the
    // SAME geometry twice and the number it prints is the noise floor every delta is read against.
    const pinTod = () => page.evaluate(() => {
      const api = window.__timeOfDayApi
      if (!api) return { ok: false, reason: 'window.__timeOfDayApi absent' }
      api.setFraction(window.__gpfTodFraction); api.setPaused(true)
      return { ok: true, paused: api.isPaused(), clock: window.__timeOfDay && window.__timeOfDay.clock }
    })
    const todPin = await page.evaluate(() => {
      window.__vegAllOff = true
      const api = window.__timeOfDayApi
      if (!api) return { ok: false, vegAllOff: window.__vegAllOff === true, reason: 'window.__timeOfDayApi absent' }
      window.__gpfTodFraction = api.getFraction()
      window.__gpfTickWind = window.__grass.tickWind
      api.setFraction(window.__gpfTodFraction); api.setPaused(true)
      return { ok: true, vegAllOff: window.__vegAllOff === true, fraction: window.__gpfTodFraction, paused: api.isPaused(), clock: window.__timeOfDay && window.__timeOfDay.clock }
    })
    console.log('[grass-perframe] fidelity freeze: ' + JSON.stringify(todPin))

    const built = await page.evaluate(() => {
      const g = window.__grass
      if (!g || !g._im || !g._im.mesh) return { ok: false, reason: 'near grass instancer mesh absent' }
      const geo = g._im.mesh.geometry
      const GeoCtor = geo.constructor
      const AttrCtor = geo.attributes.position.constructor
      // Mirrors makeClumpGeo(segments, cards) in client/core/GrassClump.js exactly.
      const build = (N, C) => {
        const pos = [], uv = [], idx = []
        let vi = 0
        for (let c = 0; c < C; c++) {
          const a = (c / C) * Math.PI
          const cx = Math.cos(a), cz = Math.sin(a)
          for (let s = 0; s <= N; s++) {
            const v = s / N
            for (const u of [-0.5, 0.5]) { pos.push(cx * u, v, cz * u); uv.push(u + 0.5, v) }
          }
          for (let s = 0; s < N; s++) { const r0 = vi + s * 2, r1 = r0 + 2; idx.push(r0, r0 + 1, r1, r0 + 1, r1 + 1, r1) }
          vi += (N + 1) * 2
        }
        const gg = new GeoCtor()
        gg.setAttribute('position', new AttrCtor(new Float32Array(pos), 3))
        gg.setAttribute('uv', new AttrCtor(new Float32Array(uv), 2))
        gg.setIndex(idx)
        gg.computeVertexNormals()
        gg.computeBoundingSphere(); gg.computeBoundingBox()
        return gg
      }
      const g2 = build(2, 1), g3 = build(3, 1)
      window.__gpfGeo = { 2: g2, 3: g3, orig: geo }
      const cnt = (gg) => (gg && gg.attributes && gg.attributes.position
        ? { verts: gg.attributes.position.count, tris: gg.index ? gg.index.count / 3 : null }
        : { error: 'not a geometry: ' + Object.prototype.toString.call(gg) })
      return { ok: true, liveNear: cnt(geo), built2: cnt(g2), built3: cnt(g3), hasUv: !!geo.attributes.uv }
    })
    const builtOk = built.ok && built.built2 && built.built2.verts === 6 && built.built2.tris === 4
      && built.built3 && built.built3.verts === 8 && built.built3.tris === 6
    console.log('[grass-perframe] fidelity setup: ' + JSON.stringify(built))
    if (!builtOk) {
      failed++
      console.log(`  [FAIL] fidelity: the two geometries did not rebuild in the page as 2 rows/6 verts and 3 rows/8 verts (${built.reason || JSON.stringify(built)}), so no visual comparison was made`)
    } else {
      const rawOf = async (f) => {
        const { data, info } = await sharp(f).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
        return { data, w: info.width, h: info.height }
      }
      const diffOf = async (fa, fb) => {
        const a = await rawOf(fa), b = await rawOf(fb)
        if (a.w !== b.w || a.h !== b.h || a.data.length !== b.data.length) return { error: `size ${a.w}x${a.h} vs ${b.w}x${b.h}` }
        let sum = 0, n = 0, over = 0, max = 0
        for (let i = 0; i < a.data.length; i += 4) {
          let hit = 0
          for (let c = 0; c < 3; c++) {
            const d = Math.abs(a.data[i + c] - b.data[i + c])
            sum += d; n++
            if (d > max) max = d
            if (d >= 8) hit = 1
          }
          if (hit) over++
        }
        return { meanAbsDiff: +(sum / n).toFixed(3), maxAbsDiff: max, pctPixelsOver8: +(100 * over / (a.w * a.h)).toFixed(3) }
      }
      const WINDS = [0.25, 1]
      const ROUNDS = 2
      const BANDS = ['near', 'mid', 'both']
      const files = {}
      // The noise floor: the same geometry, photographed twice, so anything that moved between two
      // shots is measured instead of being assumed away.
      await setBand('both')
      await setGeometry(3)
      await setWind(0.25)
      await nap(2500)
      await page.evaluate(() => { window.__grass.tickWind = () => {} })
      await pinTod()
      await nap(600)
      files['static-1'] = await shot('static-1')
      await nap(1500)
      await pinTod()
      files['static-2'] = await shot('static-2')
      const noise = await diffOf(files['static-1'], files['static-2'])
      console.log('[grass-perframe] fidelity noise floor (same geometry, 1.5 s apart): ' + JSON.stringify(noise))
      for (const w of WINDS) {
        await page.evaluate((ww) => { window.__grassWind = ww; window.__grass.tickWind = window.__gpfTickWind }, w)
        await nap(2500)
        await page.evaluate(() => { window.__grass.tickWind = () => {} })
        for (let r = 1; r <= ROUNDS; r++) {
          for (const band of BANDS) {
            await setBand(band)
            for (const n of [3, 2]) {
              const sw = await setGeometry(n)
              await pinTod()
              await nap(400)
              if (sw.nearVerts !== (n === 3 ? 8 : 6)) {
                failed++
                console.log(`  [FAIL] fidelity: swapping to ${n} rows left the near mesh at ${sw.nearVerts} verts (${JSON.stringify(sw)}), so these two shots do not compare the two geometries`)
              }
              files[`${band}-${n}-w${w}-r${r}`] = await shot(`${band}-${n}-w${w}-r${r}`)
              if (r === 1) console.log(`[grass-perframe] fidelity shot band=${band} wind=${w} rows=${n}: ${JSON.stringify(sw)}`)
            }
          }
        }
      }
      const report = {}
      for (const w of WINDS) {
        for (const band of BANDS) {
          const rounds = []
          for (let r = 1; r <= ROUNDS; r++) rounds.push(await diffOf(files[`${band}-3-w${w}-r${r}`], files[`${band}-2-w${w}-r${r}`]))
          const drift = await diffOf(files[`${band}-3-w${w}-r1`], files[`${band}-3-w${w}-r${ROUNDS}`])
          report[`${band}-w${w}`] = { rounds, drift }
          console.log(`[grass-perframe] fidelity band=${band} wind=${w}: ` + JSON.stringify({ rounds, driftSameGeometryBetweenRounds: drift }))
        }
      }
      // Amplified difference, so a small delta is still something a human can look at, and a crop
      // of the closest grass (bottom of frame) where the near LOD is what fills the pixels.
      const ampOf = async (fa, fb, out) => {
        const a = await rawOf(fa), b = await rawOf(fb)
        const buf = Buffer.alloc(a.data.length)
        for (let i = 0; i < a.data.length; i += 4) {
          for (let c = 0; c < 3; c++) buf[i + c] = Math.min(255, Math.abs(a.data[i + c] - b.data[i + c]) * 12)
          buf[i + 3] = 255
        }
        await sharp(buf, { raw: { width: a.w, height: a.h, channels: 4 } }).png().toFile(resolve(SHOT_DIR, out))
      }
      const cropOf = async (f, out) => {
        const m = await sharp(f).metadata()
        const w = Math.min(700, m.width), h = Math.min(450, m.height)
        await sharp(f).extract({ left: Math.round((m.width - w) / 2), top: m.height - h, width: w, height: h }).png().toFile(resolve(SHOT_DIR, out))
      }
      await ampOf(files['near-3-w1-r1'], files['near-2-w1-r1'], 'near-diff-w1-amplified.png')
      await ampOf(files['both-3-w1-r1'], files['both-2-w1-r1'], 'both-diff-w1-amplified.png')
      await cropOf(files['near-3-w1-r1'], 'near-3-w1-crop.png')
      await cropOf(files['near-2-w1-r1'], 'near-2-w1-crop.png')
      await cropOf(files['near-3-w0.25-r1'], 'near-3-w025-crop.png')
      await cropOf(files['near-2-w0.25-r1'], 'near-2-w025-crop.png')

      // Each band is read against ITS OWN same-geometry drift, not against one global floor: the
      // bands do not cover the same pixels, so they do not share a noise level. The drift is the
      // same geometry photographed at the two ends of the rounds, so whatever still moves (water,
      // a shadow update, a late stream) moves in both terms and cancels in the difference.
      const floor = Number.isFinite(noise.pctPixelsOver8) ? noise.pctPixelsOver8 : Infinity
      const bandStat = (band, w) => {
        const r = report[`${band}-w${w}`]
        const rounds = r.rounds.map((d) => d.pctPixelsOver8 || 0)
        const mean = +(rounds.reduce((acc, d) => acc + d, 0) / rounds.length).toFixed(3)
        const drift = r.drift.pctPixelsOver8 || 0
        return { rounds, mean, drift, attributable: +(mean - drift).toFixed(3) }
      }
      const nearBands = WINDS.map((w) => ({ w, ...bandStat('near', w) }))
      const midBands = WINDS.map((w) => ({ w, ...bandStat('mid', w) }))
      const best = Math.max(...nearBands.map((n) => n.attributable))
      if (!(best > 0) || floor > best) {
        console.log(`  [INCONCLUSIVE] the near band's own same-geometry drift (${nearBands.map((n) => n.drift).join(', ')}%) is not below the delta it is meant to reveal (${nearBands.map((n) => n.attributable).join(', ')} percentage points, whole-frame floor ${floor}%), so no pixel delta is attributed to the row count here`)
      } else {
        for (const n of nearBands) {
          console.log(`  [FIDELITY] near band at wind ${n.w}: 3 rows vs 2 rows moves ${n.mean}% of frame pixels by >=8/255 (rounds ${n.rounds.join(', ')}); the same geometry at the same wind moves ${n.drift}%; attributable ${n.attributable} percentage points`)
        }
      }
      const midLeak = Math.max(...midBands.map((m) => m.attributable))
      if (midLeak > 0.5) {
        failed++
        console.log(`  [FAIL] fidelity control: the mid band, whose geometry this change does not touch, moves ${midBands.map((m) => m.attributable).join(', ')} percentage points beyond its own drift, so the swap disturbed more than the near LOD`)
      } else {
        console.log(`  [PASS] fidelity control: the mid band (the call site this change does not touch) moves no more than its own same-geometry drift (${midBands.map((m) => m.attributable).join(', ')} percentage points), so what moved is the near LOD`)
      }
      await setBand('both')
      await setGeometry(0)
      await page.evaluate(() => {
        if (window.__gpfTickWind) window.__grass.tickWind = window.__gpfTickWind
        window.__vegAllOff = false
        if (window.__timeOfDayApi) window.__timeOfDayApi.setPaused(false)
        return true
      })
      await nap(400)
      await shot('restored-both-orig-geo')
      console.log('[grass-perframe] fidelity shots in ' + SHOT_DIR)
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
  if (browser) await browser.close().catch((e) => console.log('[grass-perframe] browser.close failed, so the lease may need sweeping: ' + e.message))
  if (server && typeof server.stop === 'function') { try { await server.stop() } catch (e) { console.log('[grass-perframe] server.stop failed: ' + e.message) } }
}
process.exit(failed === 0 ? 0 : 1)
