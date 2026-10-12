#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT_DIR = resolve(ROOT, 'data', 'perf-run')
const SHOT_DIR = resolve(OUT_DIR, 'nearfield-shots')

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

const LABEL = flag('label', 'nearfield-density-' + Date.now())
const TIERS = String(flag('tiers', 'boot,14,13,11,9,7')).split(',').map((s) => s.trim()).filter(Boolean)
const SHOT_TIERS = new Set(String(flag('shot-tiers', 'boot,7')).split(',').map((s) => s.trim()))
const SETTLE_MS = Number(flag('settle-ms', 2500))
const SAMPLE_MS = Number(flag('sample-ms', 4000))
const GPU = String(flag('gpu', 'amd'))
const EXPECT_VENDOR = String(flag('expect-vendor', GPU))
const WORLD = String(flag('world', 'tps-game'))
const [VIEW_W, VIEW_H] = String(flag('viewport', '1920x1080')).split('x').map(Number)
const BASE_KNOBS = String(flag('knob', 'qualityGovernorOff=true'))
const LEASE_WAIT_MS = Number(flag('lease-wait-ms', 240000))
const SPLIT_PROBE = flag('split-probe', null)
const LOAD_MS = Number(flag('load-ms', 0))
const LOAD_BURN_MS = Number(flag('load-burn-ms', 38))
const SHOTS = !ARGS.has('no-shots')
// writeQuads is the only writer of the drawn-quad payload and quadsFor skips it while the camera
// holds still, so a read taken with the player idle is the payload the last camera move produced.
// REFRESH reads that stale number too, then drops the quad cache and reads the payload the tier
// that is actually live produces; both are reported, and the verdict uses the refreshed one.
const REFRESH = String(flag('refresh', '1')) !== '0'
const REFRESH_SETTLE_MS = Number(flag('refresh-settle-ms', 900))
const PIN = String(flag('pin', '0')) !== '0'
const SHOT_TIERS_ALL = ARGS.has('shot-all-tiers')
if (SHOT_TIERS_ALL) for (const t of TIERS) SHOT_TIERS.add(t)

const KNOBS = BASE_KNOBS.split(',').filter(Boolean).map((p) => {
  const eq = p.indexOf('=')
  const key = (eq > 0 ? p.slice(0, eq) : p).trim()
  const raw = eq > 0 ? p.slice(eq + 1).trim() : ''
  const value = /^(true|false)$/.test(raw) ? raw === 'true' : Number(raw)
  return { key, value }
})

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// The cube-sphere face map is w = R*tan((u/R)*(pi/4)) per axis followed by a radial projection, so
// its induced metric depends only on (u, v, R) and never on which of the six faces a quad sits on:
// the drawn-quad payload alone gives the real on-sphere vertex spacing.
const METRIC_SRC = `
  const K = (Math.PI / 4) / R
  const sec2 = (th) => 1 / (Math.cos(th) * Math.cos(th))
  const dSdu = (u, v) => {
    const thu = u * K, thv = v * K
    const tu = Math.tan(thu)
    return (Math.PI / 4) * sec2(thu) * (1 / Math.cos(thv)) / (tu * tu + sec2(thv))
  }
  const dSdv = (u, v) => dSdu(v, u)
  const spanU = (ox, oy, l) => { let s = 0; const n = 16, h = l / n, v = oy + l * 0.5; for (let i = 0; i < n; i++) s += dSdu(ox + (i + 0.5) * h, v) * h; return s }
  const spanV = (ox, oy, l) => { let s = 0; const n = 16, h = l / n, u = ox + l * 0.5; for (let i = 0; i < n; i++) s += dSdv(u, oy + (i + 0.5) * h) * h; return s }
`

const measureExpr = (radiusFallback) => `(async () => {
  const W = window
  const t = W.__terrain
  const p = t && t.planet
  if (!p || typeof p.drawnQuads !== 'function') return { error: 'planet.drawnQuads unavailable' }
  const q = p.drawnQuads()
  if (!q || !q.offsets) return { error: 'no drawn quad payload' }
  const R = Number.isFinite(q.radius) && q.radius > 0 ? q.radius : ${radiusFallback}
  const g = q.gridSize | 0
  if (!(g >= 1)) return { error: 'gridSize ' + q.gridSize }
  ${METRIC_SRC}
  const count = Math.min(q.count | 0, (q.offsets.length / 4) | 0)
  let deepest = -1
  const rows = []
  for (let n = 0; n < count; n++) {
    const face = q.faces ? (q.faces[n] | 0) : 0
    const ox = q.offsets[n * 4], oy = q.offsets[n * 4 + 1], l = q.offsets[n * 4 + 2], level = q.offsets[n * 4 + 3]
    if (!Number.isFinite(ox) || !Number.isFinite(oy) || !Number.isFinite(l) || !(l > 0)) continue
    if (level > deepest) deepest = level
    rows.push({ face, ox, oy, l, level })
  }
  if (!rows.length) return { error: 'no usable quads', count }
  const deep = rows.filter((r) => r.level === deepest)
  let su = 0, sv = 0, sMin = Infinity, sMax = -Infinity
  for (const r of deep) {
    const a = spanU(r.ox, r.oy, r.l) / g
    const b = spanV(r.ox, r.oy, r.l) / g
    su += a; sv += b
    const m = (a + b) * 0.5
    if (m < sMin) sMin = m
    if (m > sMax) sMax = m
  }
  const nD = deep.length
  const rc = W.__renderControls
  // splitDist is computed by mapspinner's computeSplitDist and floored at 1.1; recompute it from the
  // live knob, the live canvas height and the live camera fov so the floor is visible, not assumed.
  let splitDistRaw = null, splitDist = null, splitFactor = null, fov = null, canvasH = null
  try {
    const app = W.__app
    const cam = app && app.camera
    fov = cam && cam.fov ? cam.fov : null
    canvasH = app && app.renderer && app.renderer.domElement ? app.renderer.domElement.height : null
    splitFactor = rc && typeof rc.get === 'function' ? rc.get('splitFactor') : null
    const vf = Number.isFinite(fov) ? fov : 70
    const vh = Number.isFinite(canvasH) ? canvasH : 1080
    if (Number.isFinite(splitFactor)) {
      splitDistRaw = splitFactor * vh / 1024 * Math.tan(40 * Math.PI / 180) / Math.tan(vf / 2 * Math.PI / 180)
      splitDist = (splitDistRaw >= 1.1 && Number.isFinite(splitDistRaw)) ? splitDistRaw : 1.1
    }
  } catch (_) {}
  let player = null
  try { const c = W.__client; const s = c && c.getLocalState && c.getLocalState(); if (s && Array.isArray(s.position)) player = [s.position[0], s.position[1], s.position[2]] } catch (_) {}
  let nearField = null
  try { if (typeof p.nearField === 'function') nearField = p.nearField() } catch (_) {}
  return {
    radius: R,
    gridSize: g,
    quadCount: rows.length,
    deepestLevel: deepest,
    deepestQuadCount: nD,
    finestLeafM: 2 * R / Math.pow(2, deepest),
    stepLocalM: (2 * R / Math.pow(2, deepest)) / g,
    nearSpacingMeanM: (su / nD + sv / nD) * 0.5,
    nearSpacingUm: su / nD,
    nearSpacingVm: sv / nD,
    nearSpacingMinM: sMin,
    nearSpacingMaxM: sMax,
    splitFactor, splitDistRaw, splitDist, fov, canvasH,
    knobMaxLevel: rc && typeof rc.get === 'function' ? rc.get('maxLevel') : null,
    windowMaxLevel: W.__maxLevel == null ? null : W.__maxLevel,
    nearField,
    weatherType: rc && typeof rc.get === 'function' ? rc.get('weatherType') : null,
    tod: W.__timeOfDay ? { paused: !!W.__timeOfDay.paused, clock: W.__timeOfDay.clock, elevationDeg: W.__timeOfDay.elevationDeg, sunIntensity: W.__timeOfDay.sunIntensity } : null,
    governor: W.__qualityGovernorState || null,
    playerLocal: player,
    rendererInfo: W.__rendererInfo || null,
  }
})()`

// The rendered mesh is a piecewise-linear grid over the exact height sampler the same frame exposes,
// so |rendered - exact| along a transect is the visible faceting error in metres.
const TRANS_EXPR = `(async () => {
  const W = window
  const t = W.__terrain
  const frame = t && t.frame
  if (!frame) return { error: 'no frame' }
  const rm = frame.renderMeshHeightAtLocal
  const ex = frame.groundHeightLocal
  if (typeof rm !== 'function' || typeof ex !== 'function') return { error: 'missing height fns' }
  let px = 0, pz = 0
  try { const s = W.__client && W.__client.getLocalState && W.__client.getLocalState(); if (s && Array.isArray(s.position)) { px = s.position[0]; pz = s.position[2] } } catch (_) {}
  const N = 400, STEP = 0.25, HALF = N * STEP * 0.5
  const run = (horizontal) => {
    let n = 0, sum = 0, mx = 0, unserved = 0
    for (let i = 0; i < N; i++) {
      const x = horizontal ? px - HALF + i * STEP : px
      const z = horizontal ? pz : pz - HALF + i * STEP
      const r = rm(x, z)
      if (r === null || r === undefined || !Number.isFinite(r)) { unserved++; continue }
      const e = ex(x, z)
      if (!Number.isFinite(e)) continue
      const d = Math.abs(r - e)
      sum += d; n++; if (d > mx) mx = d
    }
    return { n, unserved, mean: n ? +(sum / n).toFixed(4) : null, max: n ? +mx.toFixed(4) : null }
  }
  const ax = run(true), az = run(false)
  return {
    playerLocal: [px, pz], transectM: N * STEP,
    samplesX: ax.n, unservedX: ax.unserved, meanAbsDevXM: ax.mean, maxAbsDevXM: ax.max,
    samplesZ: az.n, unservedZ: az.unserved, meanAbsDevZM: az.mean, maxAbsDevZM: az.max,
    meanAbsDevM: (ax.mean != null && az.mean != null) ? +((ax.mean + az.mean) / 2).toFixed(4) : null,
    maxAbsDevM: Math.max(ax.max || 0, az.max || 0),
  }
})()`

const GRASS_EXPR = `(async () => {
  const m = await import('/src/terrain/GrassPlacement.js')
  const G = m.GRASS
  const out = { CELL: G.CELL, CHUNK: G.CHUNK, GRID: G.GRID, BLADES_PER_CELL: G.BLADES_PER_CELL, CLUMP_R: G.CLUMP_R, SLOPE_D: G.SLOPE_D, JITTER: G.JITTER }
  out.cellSpacingM = G.CHUNK / G.GRID
  out.bladesPerM2 = G.BLADES_PER_CELL / (G.CELL * G.CELL)
  out.meanBladeSpacingM = 0.5 / Math.sqrt(out.bladesPerM2)
  return out
})()`

const knobApplySrc = (knobs) => `(() => {
  const W = window
  const want = ${JSON.stringify(knobs)}
  let registry = null
  const apply = () => {
    const applied = []
    for (const k of want) {
      const ok = registry.set(k.key, k.value)
      applied.push({ key: k.key, value: k.value, setReturned: ok })
    }
    W.__nearfieldKnobs = applied
  }
  Object.defineProperty(W, '__renderControls', {
    configurable: true,
    get: () => registry,
    set: (v) => { registry = v; if (registry && typeof registry.set === 'function') apply() },
  })
})()`

const INSTRUMENT = `(() => {
  const W = window
  if (W.__nfRig) return
  const rig = { frames: [], on: false, loadUntil: 0 }
  W.__nfRig = rig
  W.__nfSetLoad = (ms) => { rig.loadUntil = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + ms; return true }
  const burn = ${Number(flag('load-burn-ms', 38))}
  let last = -1
  function tick(now) {
    const dt = last < 0 ? 0 : now - last
    last = now
    if (typeof performance !== 'undefined' && performance.now() < rig.loadUntil) {
      const t0 = performance.now()
      while (performance.now() - t0 < burn) {}
    }
    if (rig.on && rig.frames.length < 400000) rig.frames.push(+dt.toFixed(3))
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})()`

const NF_RESET = () => { const r = window.__nfRig; r.frames.length = 0; r.on = true; return true }
const NF_STOP = () => { const r = window.__nfRig; r.on = false; return { frames: r.frames.slice() } }

const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return +s[Math.floor(s.length / 2)].toFixed(2) }
const pct = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2) }

const shot = async (page, name) => {
  const full = resolve(SHOT_DIR, name + '.png')
  await page.screenshot({ path: full })
  const bands = {
    near: { x: Math.round(VIEW_W * 0.30), y: Math.round(VIEW_H * 0.72), width: Math.round(VIEW_W * 0.40), height: Math.round(VIEW_H * 0.26) },
    mid: { x: Math.round(VIEW_W * 0.30), y: Math.round(VIEW_H * 0.46), width: Math.round(VIEW_W * 0.40), height: Math.round(VIEW_H * 0.22) },
    far: { x: 0, y: Math.round(VIEW_H * 0.33), width: VIEW_W, height: Math.round(VIEW_H * 0.16) },
  }
  const out = { full }
  for (const [k, clip] of Object.entries(bands)) {
    const r = await page._send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } }).catch(() => null)
    if (!r || !r.data) continue
    const p = resolve(SHOT_DIR, name + '-' + k + '.png')
    writeFileSync(p, Buffer.from(r.data, 'base64'))
    out[k] = p
  }
  return out
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  mkdirSync(SHOT_DIR, { recursive: true })

  // PREDICTION, written before any live value is read. Source of truth read statically:
  // src/presets/planet.js terrain {radius 63600, maxLevel 13, physics {extent 256, resolution 2}};
  // TD.gridMeshSize 9 (8 steps per patch); src/terrain/GrassPlacement.js GRASS {CHUNK 32, GRID 16}.
  const PREDICT = { radius: 63600, gridMeshSize: 9, bootMaxLevel: 13, colliderExtent: 256, colliderResolution: 2, grassCellM: 2 }
  const PREDICT_METRIC = { dSdu: 0.780, dSdv: 0.617 }
  const prediction = {
    ...PREDICT,
    predicted: [14, 13, 11, 9, 7].map((L) => {
      const leaf = 2 * PREDICT.radius / Math.pow(2, L)
      const step = leaf / (PREDICT.gridMeshSize - 1)
      return {
        maxLevel: L, leafM: +leaf.toFixed(3), stepLocalM: +step.toFixed(3),
        worldStepUm: +(step * PREDICT_METRIC.dSdu).toFixed(3),
        worldStepVm: +(step * PREDICT_METRIC.dSdv).toFixed(3),
      }
    }),
    predictedColliderConfiguredM: +(256 / (Math.round(256 / PREDICT.colliderResolution) - 1)).toFixed(4),
    predictedColliderFineM: 1.0,
    predictedGrassCellM: 2.0,
  }
  console.log('[nearfield] PREDICTION ' + JSON.stringify(prediction))

  const { chromium } = await import(pathToFileURL(resolve(ROOT, 'scripts', 'lib', 'cdp-browser.mjs')).href)
  const { assertGpu, vendorGpuArgs } = await import(pathToFileURL(resolve(ROOT, 'scripts', 'lib', 'gpu-probe.mjs')).href)

  const port = String(20000 + Math.floor(Math.random() * 20000))
  process.env.WORLD = process.env.WORLD || WORLD
  process.env.PORT = port
  process.env.SPOINT_NO_WATCH = '1'

  const serverLogs = []
  const _origLog = console.log.bind(console)
  const _origWarn = console.warn.bind(console)
  console.log = (...a) => { serverLogs.push(a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ')); _origLog(...a) }
  console.warn = (...a) => { serverLogs.push(a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ')); _origWarn(...a) }

  const { boot } = await import(pathToFileURL(resolve(ROOT, 'src', 'sdk', 'server.js')).href)
  const server = await boot()
  console.log('[nearfield] server up on ' + port)

  const args = vendorGpuArgs(GPU)
  const browser = await chromium.launch({ args, owner: LABEL, root: ROOT, leaseWaitMs: LEASE_WAIT_MS })
  const page = await browser.newPage({ viewport: { width: VIEW_W, height: VIEW_H } })
  await page._send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT })
  await page._send('Page.addScriptToEvaluateOnNewDocument', { source: knobApplySrc(KNOBS) })
  await page._send('Performance.enable').catch(() => {})

  const url = `http://localhost:${port}/?singleplayer&webgpu=1&world=${WORLD}&v=${Date.now()}`
  console.log('[nearfield] navigating ' + url)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 240000 })

  let ready = false
  for (let i = 0; i < 400 && !ready; i++) {
    ready = await page.evaluate(() => !!(window.__app && window.__app.loadingMachine && window.__app.loadingMachine.isReady) && !!(window.__terrain && window.__terrain.planet)).catch(() => false)
    if (!ready) await wait(500)
  }
  if (!ready) throw new Error('[nearfield] world never became ready')
  const gpu = await assertGpu(page, { requireAccelerated: true, expectVendor: EXPECT_VENDOR })
  console.log('[nearfield] gpu ' + JSON.stringify(gpu))
  // The planet module is a root-relative runtime import (/node_modules/mapspinner/...), so the page
  // can be running a build other than the working tree. Prove which one before trusting any number.
  const buildProbe = await page.evaluate(`(async () => {
    const u = '/node_modules/mapspinner/src/tsl/planet-tsl.js'
    try { const t = await (await fetch(u)).text(); return { bytes: t.length, hasLodCacheKey: t.includes('nearLeafM'), hasQuadCache: t.includes('quadCache') } } catch (e) { return { error: String(e && e.message || e) } }
  })()`).catch((e) => ({ error: e.message }))
  console.log('[nearfield] build-probe ' + JSON.stringify(buildProbe))
  console.log('[nearfield] knobs ' + JSON.stringify(await page.evaluate(() => window.__nearfieldKnobs || null).catch(() => null)))
  await wait(6000)

  // A 600 s day cycle and live rain both move every pixel, so a shot-to-shot comparison across tiers
  // is only readable with the clock stopped and the weather off. Read the pin back on every row.
  if (PIN) {
    const pinned = await page.evaluate(`(() => {
      const w = window, out = {}
      try { const api = w.__timeOfDayApi; if (api) { api.setPaused(true); api.setFraction(0.30); out.clock = api.getClockString(); out.paused = api.isPaused() } else out.tod = 'no api' } catch (e) { out.todError = String(e && e.message || e) }
      try { const rc = w.__renderControls; if (rc && typeof rc.set === 'function') { out.weatherType = rc.set('weatherType', 'clear'); out.weatherIntensity = rc.set('weatherIntensity', 0); w.__wetnessForce = 0 } else out.weather = 'no registry' } catch (e) { out.weatherError = String(e && e.message || e) }
      return out
    })()`).catch((e) => ({ error: e.message }))
    console.log('[nearfield] pinned ' + JSON.stringify(pinned))
    await wait(1500)
  }

  const grass = await page.evaluate(GRASS_EXPR).catch((e) => ({ error: e.message }))
  console.log('[nearfield] grass ' + JSON.stringify(grass))

  const num = (re, s, i = 1) => { const m = re.exec(s || ''); return m ? Number(m[i]) : null }
  const colliderLog = {
    colliderUsing: serverLogs.filter((l) => l.includes('[terrain] collider using')).slice(0, 4),
    latticeConfigured: serverLogs.filter((l) => l.includes('[terrain] collider lattice:')).slice(0, 4),
    latticeChosen: serverLogs.filter((l) => l.includes('[terrain] collider lattice at')).slice(0, 8),
  }
  const collider = {
    bakedSpacingCm: num(/spacing\s+(\d+)cm/, colliderLog.colliderUsing[0] || ''),
    bakedN: num(/N=(\d+)/, colliderLog.colliderUsing[0] || ''),
    bakedExtentM: num(/extent=(\d+)m/, colliderLog.colliderUsing[0] || ''),
    configuredResolutionM: num(/collider lattice:\s*([\d.]+)m/, colliderLog.latticeConfigured[0] || ''),
    frozenTargetM: num(/down to ([\d.]+)m/, colliderLog.latticeConfigured[0] || ''),
    chosenN: colliderLog.latticeChosen.map((l) => num(/N=(\d+) -> N=(\d+)/, l, 2)).filter((x) => x != null),
    raw: colliderLog,
  }
  let collN = Math.max(2, Math.round(256 / (collider.configuredResolutionM || 2)))
  if (collN % 2 !== 0) collN += 1
  collider.configuredSpacingM = Number.isFinite(collider.configuredResolutionM) ? +(256 / (collN - 1)).toFixed(4) : null
  console.log('[nearfield] collider ' + JSON.stringify(collider))

  const sample = async (tier, wantShots) => {
    let setReturned = null
    if (tier !== 'boot') {
      setReturned = await page.evaluate(`(() => { const rc = window.__renderControls; const ok = rc && rc.set ? rc.set('maxLevel', ${Number(tier)}) : null; return { ok, readback: rc && rc.get ? rc.get('maxLevel') : null } })()`).catch((e) => ({ error: e.message }))
    }
    await wait(SETTLE_MS)
    const still = await page.evaluate(measureExpr(PREDICT.radius)).catch((e) => ({ error: e.message }))
    let refreshed = still, clearCache = null
    if (REFRESH) {
      clearCache = await page.evaluate(`(() => { const p = window.__terrain && window.__terrain.planet; if (!p || typeof p.clearCache !== 'function') return 'no clearCache'; p.clearCache(); return 'cleared' })()`).catch((e) => ({ error: e.message }))
      await wait(REFRESH_SETTLE_MS)
      refreshed = await page.evaluate(measureExpr(PREDICT.radius)).catch((e) => ({ error: e.message }))
    }
    await page.evaluate(NF_RESET).catch(() => null)
    const send0 = await page._send('Performance.getMetrics').catch(() => ({ metrics: [] }))
    const t0wall = Date.now()
    await wait(SAMPLE_MS)
    const send1 = await page._send('Performance.getMetrics').catch(() => ({ metrics: [] }))
    const wall = Date.now() - t0wall
    const acc = await page.evaluate(NF_STOP).catch(() => null)
    const by = (s) => { const o = {}; for (const e of s.metrics || []) o[e.name] = e.value; return o }
    const m0 = by(send0), m1 = by(send1)
    const f = ((acc && acc.frames) || []).filter((d) => d > 0)
    const nF = f.length
    const m = refreshed
    const dev = await page.evaluate(TRANS_EXPR).catch((e) => ({ error: e.message }))
    const cost = {
      frames: nF,
      frameP50Ms: median(f),
      frameP95Ms: pct(f, 0.95),
      fps: nF && wall ? +(nF / (wall / 1000)).toFixed(2) : null,
      threadMsPerFrame: (m1.ThreadTime != null && nF) ? +(((m1.ThreadTime - m0.ThreadTime) * 1000) / nF).toFixed(3) : null,
      terrainQuads: m.quadCount ?? null,
      terrainTris: Number.isFinite(m.quadCount) && Number.isFinite(m.gridSize) ? m.quadCount * m.gridSize * m.gridSize * 2 : null,
      deepestQuads: m.deepestQuadCount ?? null,
    }
    const images = (SHOTS && wantShots) ? await shot(page, LABEL + '-' + tier) : null
    const row = { tier, setReturned, still, refreshed, clearCache, ...m, dev, cost, images }
    console.log('[nearfield] ' + tier + ' ' + JSON.stringify({ still, refreshed, clearCache, dev, cost, images: images ? Object.keys(images) : null }))
    return row
  }

  const rows = []
  for (const tier of TIERS) rows.push(await sample(tier, SHOT_TIERS.has(tier)))

  const extra = {}
  if (SPLIT_PROBE != null) {
    const before = await page.evaluate(measureExpr(PREDICT.radius)).catch((e) => ({ error: e.message }))
    const ok = await page.evaluate(`(() => { const rc = window.__renderControls; const o = rc && rc.set ? rc.set('splitFactor', ${Number(SPLIT_PROBE)}) : null; return { ok: o, readback: rc && rc.get ? rc.get('splitFactor') : null } })()`).catch((e) => ({ error: e.message }))
    await wait(SETTLE_MS + 1500)
    const after = await page.evaluate(measureExpr(PREDICT.radius)).catch((e) => ({ error: e.message }))
    extra.splitProbe = { value: Number(SPLIT_PROBE), setReturned: ok, before, after }
    console.log('[nearfield] split-probe ' + JSON.stringify(extra.splitProbe))
  }

  // "Always": re-arm the governor and load the main thread until it sheds, then re-measure the near
  // band at whatever tier it reached. A pin that only holds at boot does not satisfy the ruling.
  if (LOAD_MS > 0) {
    await page.evaluate(`(() => { const rc = window.__renderControls; rc && rc.set && rc.set('qualityGovernorOff', false); rc && rc.set && rc.set('qualityGovernor', true); return { gov: rc && rc.get ? rc.get('qualityGovernor') : null, off: rc && rc.get ? rc.get('qualityGovernorOff') : null } })()`).catch(() => null)
    await wait(1500)
    const pre = await page.evaluate(measureExpr(PREDICT.radius)).catch((e) =>({ error: e.message }))
    await page.evaluate(`(() => { window.__nfSetLoad(${LOAD_MS}); return true })()`).catch(() => null)
    const trace = []
    const deadline = Date.now() + LOAD_MS
    while (Date.now() < deadline) {
      const s = await page.evaluate(`(() => { const rc = window.__renderControls; return { t: performance.now(), maxLevel: rc && rc.get ? rc.get('maxLevel') : null, tier: (window.__qualityGovernorState && window.__qualityGovernorState.tier) != null ? window.__qualityGovernorState.tier : null, gov: window.__qualityGovernorState || null } })()`).catch(() => null)
      if (s) trace.push(s)
      await wait(500)
    }
    await wait(1500)
    const post = await page.evaluate(measureExpr(PREDICT.radius)).catch((e) => ({ error: e.message }))
    const postDev = await page.evaluate(TRANS_EXPR).catch((e) => ({ error: e.message }))
    const maxLevels = [...new Set(trace.map((s) => s.maxLevel).filter((v) => v != null))]
    const tiers = [...new Set(trace.map((s) => s.tier).filter((v) => v != null))]
    extra.load = { pre, post, postDev, maxLevels, tiers, samples: trace.length, lastGovernor: trace.length ? trace[trace.length - 1].gov : null }
    console.log('[nearfield] load ' + JSON.stringify(extra.load))
  }

  if (SHOTS) {
    await wait(4000)
    const noiseShots = await shot(page, LABEL + '-repeat')
    console.log('[nearfield] repeat-shots ' + JSON.stringify(Object.keys(noiseShots)))
  }

  const collFine = Number.isFinite(collider.frozenTargetM) && collider.frozenTargetM > 0 ? collider.frozenTargetM : null
  const verdict = rows.map((r) => {
    if (r.error || !Number.isFinite(r.nearSpacingMeanM)) return { tier: r.tier, error: r.error || 'no spacing' }
    return {
      tier: r.tier,
      maxLevel: r.deepestLevel,
      renderedNearSpacingM: +r.nearSpacingMeanM.toFixed(3),
      renderedNearSpacingMinM: +r.nearSpacingMinM.toFixed(3),
      renderedNearSpacingMaxM: +r.nearSpacingMaxM.toFixed(3),
      grassPlacementSpacingM: Number.isFinite(grass && grass.cellSpacingM) ? grass.cellSpacingM : null,
      colliderSpacingM: collFine ?? collider.configuredSpacingM,
      renderedVsCollider: (collFine ?? collider.configuredSpacingM) ? +(r.nearSpacingMeanM / (collFine ?? collider.configuredSpacingM)).toFixed(2) : null,
      renderedVsGrass: Number.isFinite(grass && grass.cellSpacingM) ? +(r.nearSpacingMeanM / grass.cellSpacingM).toFixed(2) : null,
      nearFieldIsCoarserThanCollider: collFine != null ? r.nearSpacingMaxM > collFine : null,
      meanFacetingErrorM: r.dev ? r.dev.meanAbsDevM : null,
      maxFacetingErrorM: r.dev ? r.dev.maxAbsDevM : null,
      splitDist: r.splitDist, splitDistRaw: r.splitDistRaw, splitFactor: r.splitFactor,
      quads: r.cost.terrainQuads, tris: r.cost.terrainTris, threadMsPerFrame: r.cost.threadMsPerFrame,
      nearFieldStepM: r.nearField ? r.nearField.stepM : null,
      nearFieldTiles: r.nearField ? r.nearField.tiles : null,
      stillQuads: r.still ? r.still.quadCount : null,
      stillDeepestLevel: r.still ? r.still.deepestLevel : null,
      stillNearSpacingM: r.still && Number.isFinite(r.still.nearSpacingMeanM) ? +r.still.nearSpacingMeanM.toFixed(3) : null,
    }
  })

  const out = { label: LABEL, ts: new Date().toISOString(), gpu, world: WORLD, viewport: VIEW_W + 'x' + VIEW_H, knobs: KNOBS, prediction, grass, collider, rows, verdict, extra }
  writeFileSync(resolve(OUT_DIR, LABEL + '.json'), JSON.stringify(out, null, 1))
  console.log('[nearfield] wrote ' + resolve(OUT_DIR, LABEL + '.json'))
  console.log('[nearfield] RESULT ' + JSON.stringify(verdict))

  // ---- the decision ----------------------------------------------------------------------------
  // The table above is a measurement, not a verdict. What makes "the near band is 2.409 m against a
  // 1.00 m collider" a fact rather than a printout is that the on-sphere spacing it reports is the
  // drawn leaf's own step length times the cube-sphere metric the PREDICT block declares -- two
  // numbers the page computes by different routes (radius/level/gridSize, and a metric integral over
  // the real drawn-quad payload) that have to agree. Everything else here is the instrument proving
  // it ran: the knob read back what was set, the renderer is the accelerated path, frames were
  // counted and both comparison lattices were measured. A gate on the table alone cannot fail, so
  // the run decides on those and nothing else.
  const checks = []
  const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); if (!ok) console.log(`FAIL: ${name} ${detail}`) }
  const okRows = rows.filter((r) => !r.error && Number.isFinite(r.nearSpacingMeanM))

  check('tiersMeasured', okRows.length === rows.length && rows.length === TIERS.length && okRows.every((r) => r.nearSpacingMeanM > 0 && Number.isFinite(r.nearSpacingMinM) && Number.isFinite(r.nearSpacingMaxM)), `rows=${rows.length} of ${TIERS.length}, measured=${okRows.length}`)
  check('knobTookTheTierThatWasSet', rows.every((r) => r.tier === 'boot' ? r.windowMaxLevel === prediction.bootMaxLevel : r.windowMaxLevel === Number(r.tier)), JSON.stringify(rows.map((r) => [r.tier, r.windowMaxLevel])))
  let metricWorst = null
  for (const r of okRows) {
    if (!(Number.isFinite(r.stepLocalM) && r.stepLocalM > 0)) { metricWorst = 'stepLocalM ' + r.stepLocalM; continue }
    const gu = (r.nearSpacingUm / r.stepLocalM) / PREDICT_METRIC.dSdu
    const gv = (r.nearSpacingVm / r.stepLocalM) / PREDICT_METRIC.dSdv
    const worst = Math.max(Math.abs(gu - 1), Math.abs(gv - 1))
    if (metricWorst === null || typeof metricWorst === 'string' || worst > metricWorst) metricWorst = worst
  }
  check('metricFactorMatchesPrediction', typeof metricWorst === 'number' && metricWorst <= 0.05, `worst |measured metric / predicted metric - 1| = ${metricWorst}`)
  check('drawnQuadPayloadMeasured', okRows.every((r) => Number.isInteger(r.deepestLevel) && r.deepestLevel > 0 && r.quadCount > 0 && r.gridSize === prediction.gridMeshSize && r.radius === prediction.radius), JSON.stringify(okRows.map((r) => [r.tier, r.quadCount, r.deepestLevel, r.gridSize, r.radius])))
  // The tier has to be VISIBLE in the payload, not merely held in a knob: quadCount is the count of
  // instances the draw actually consumes, so a set of tiers that all report one count is a knob that
  // did not reach the geometry.
  check('drawnQuadPayloadRespondsToMaxLevel', new Set(okRows.map((r) => r.quadCount)).size >= 3, JSON.stringify(rows.map((r) => [r.tier, r.still && r.still.quadCount, r.quadCount])))
  // ...and it has to be visible WITHOUT an outside nudge: a payload that only changes once something
  // else shakes the camera is a shed the governor cannot make while the player stands still.
  check('payloadFreshWithoutForcedRefresh', okRows.every((r) => r.still && r.still.quadCount === r.quadCount && r.still.deepestLevel === r.deepestLevel), JSON.stringify(rows.map((r) => [r.tier, r.still && r.still.quadCount, r.quadCount, r.still && r.still.deepestLevel, r.deepestLevel])))
  check('rendererIsTheAcceleratedWebGpuPath', !!(gpu && gpu.accelerated) && rows.every((r) => r.rendererInfo && r.rendererInfo.class === 'WebGPURenderer' && r.rendererInfo.backend === 'webgpu'), JSON.stringify({ gpu: gpu && { accelerated: gpu.accelerated, renderer: gpu.renderer }, classes: [...new Set(rows.map((r) => r.rendererInfo && r.rendererInfo.class))] }))
  check('framesCounted', okRows.every((r) => r.cost && r.cost.frames > 0), JSON.stringify(rows.map((r) => [r.tier, r.cost && r.cost.frames])))
  check('comparisonLatticesMeasured', verdict.every((v) => !v.error && Number.isFinite(v.colliderSpacingM) && v.colliderSpacingM > 0 && Number.isFinite(v.grassPlacementSpacingM) && v.grassPlacementSpacingM > 0), JSON.stringify(verdict.map((v) => [v.tier, v.colliderSpacingM, v.grassPlacementSpacingM])))

  const failed = checks.filter((c) => !c.ok)
  console.log(`[nearfield] decision metricWorst=${metricWorst} tiers=${rows.length} deepestLevels=${JSON.stringify([...new Set(okRows.map((r) => r.deepestLevel))])} windowMaxLevels=${JSON.stringify(rows.map((r) => r.windowMaxLevel))}`)
  console.log(`[nearfield] checks ${checks.length - failed.length} passed, ${failed.length} failed`)
  if (failed.length) console.log(`RESULT: FAIL (${failed.length} of ${checks.length} check(s))`)
  else console.log('RESULT: PASS')
  try { await server.stop() } catch (_) {}
  await wait(1500)
  process.exit(failed.length ? 1 : 0)
}

main().catch(async (e) => { console.error('[nearfield] FAILED: ' + (e && e.stack || e)); process.exit(1) })
