import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from './lib/cdp-browser.mjs'
import { gpuArgs, assertGpu } from './lib/gpu-probe.mjs'
import { vendorPinArgs } from './lib/witness-gpu.mjs'
import {
  assertServedClientRoot, clientRootTag, rebuildIfRequested, CLIENT_ROOT_BUNDLE,
} from './lib/served-client-root.mjs'

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

const GPU = flag('gpu', 'amd')
const AT = String(flag('at', '-500,-500'))
const SETTLE_MS = Number(flag('settle', '45000'))
const WALK_MS = Number(flag('walk', '0'))
const ROUTE = String(flag('route', '-60,-12.5;-60,-60;0,-60'))
const WALK_SPEED = Number(flag('walk-speed', '7'))
const EXPECT_VENDOR = flag('expect-vendor', GPU)
const LAUNCH_ARGS = [...gpuArgs({ accelerated: true }), ...vendorPinArgs(GPU)]

const port = String(20000 + Math.floor(Math.random() * 20000))
process.env.WORLD = process.env.WORLD || 'tps-game'
process.env.PORT = port
process.env.SPOINT_NO_WATCH = '1'

rebuildIfRequested('veg-witness')
const { boot } = await import(pathToFileURL(resolve(ROOT, 'src', 'sdk', 'server.js')).href)
const server = await boot()
console.log('[veg-witness] server on ' + port)

const readProfile = (page) => page.evaluate(() => {
  const veg = window.__vegProfile || null
  const grass = window.__grassProfile || null
  const rocks = window.__rocksProfile || null
  const pos = window.__app && window.__app.client && window.__app.client.getLocalState
    ? window.__app.client.getLocalState().position
    : null
  return {
    vegTotal: veg ? veg.totalInstances : null,
    vegVisible: veg ? veg.visibleInstances : null,
    vegDraws: veg ? veg.vegDrawCalls : null,
    vegLoads: veg ? veg.loads : null,
    vegUnloads: veg ? veg.unloads : null,
    vegMesh: veg ? veg.meshInstances : null,
    vegImpostor: veg ? veg.impostorInstances : null,
    grassTotal: grass ? grass.totalInstances : null,
    rocksTotal: rocks ? rocks.totalInstances : null,
    pos,
  }
}).catch((e) => ({ error: e.message }))

const readStream = (page) => page.evaluate(() => {
  const app = window.__app || {}
  const grab = (o) => {
    if (!o || !o.streamState) return null
    const s = o.streamState()
    return { ...s, missingKeys: (s.missingKeys || []).slice(0, 6) }
  }
  return { veg: grab(app.vegetation), grass: grab(app.grass), rocks: grab(app.rocks) }
}).catch((e) => ({ error: e.message }))

let browser
let failed = 0
try {
  browser = await chromium.launch({ args: LAUNCH_ARGS })
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || (e && e.message) || e)))
  const url = `http://localhost:${port}/?singleplayer&world=tps-game&at=${encodeURIComponent(AT)}&v=${Date.now()}`
  console.log('[veg-witness] ' + url)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })

  const servedRoot = await assertServedClientRoot(page, { want: CLIENT_ROOT_BUNDLE, label: 'veg-witness' })
  console.log(`[veg-witness] served ${clientRootTag(servedRoot)} required=${CLIENT_ROOT_BUNDLE}`)

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
  console.log('[veg-witness] gpu ' + JSON.stringify({ rasterizer: gpu.rasterizer, renderer: gpu.renderer, vendor: gpu.adapter }))
  console.log('[veg-witness] scenery-built at ' + revealedAt + 'ms')

  const atReveal = await readProfile(page)
  console.log('[veg-witness] at reveal: ' + JSON.stringify(atReveal))

  const relocated = await page.evaluate(() => ({
    boot: window.__spointBoot || null,
    where: window.__spoint && window.__spoint.where ? window.__spoint.where() : null,
  })).catch((e) => ({ error: e.message }))
  console.log('[veg-witness] boot relocation to ' + AT + ': ' + JSON.stringify(relocated))

  let peak = 0
  let final = atReveal
  const tSettle = Date.now()
  while (Date.now() - tSettle < SETTLE_MS) {
    await new Promise((r2) => setTimeout(r2, 2500))
    final = await readProfile(page)
    if (final.vegTotal && final.vegTotal > peak) peak = final.vegTotal
  }
  console.log('[veg-witness] after settle: ' + JSON.stringify(final) + ' peak=' + peak)

  if (flag('dump', false)) {
    const deep = await page.evaluate(() => {
      const veg = (window.__app || {}).vegetation
      const out = { profile: window.__vegProfile || null }
      const speciesOf = (o) => (o && o._meshes) || null
      const list = speciesOf(veg) || speciesOf(window.__veg) || null
      if (list) {
        out.species = list.slice(0, 10).map((r) => {
          const b = r && r.branch
          const render = b && b.LODinfo && b.LODinfo.render
          const lc = (render && render.count) || []
          const lv = (render && render.levels) || []
          return { name: r.name, count: b && b.count, tiers: Array.from(lc), visible: lv.map((l) => !!(l && l.object && l.object.visible)) }
        })
      } else {
        out.species = null
      }
      const app2 = window.__app || {}
      const r = app2.renderer || (app2.engine && app2.engine.renderer) || null
      out.renderer = r ? { isWebGPURenderer: !!r.isWebGPURenderer, isWebGLRenderer: !!r.isWebGLRenderer, backendWebGPU: !!(r.backend && r.backend.isWebGPUBackend) } : null
      const pos = (window.__spoint && window.__spoint.where && window.__spoint.where().position) || null
      if (list && pos) {
        let near80 = 0, near200 = 0, total = 0
        for (const rec of list) {
          const b = rec && rec.branch
          const arr = b && b.instanceMatrix && b.instanceMatrix.array
          if (!arr) continue
          for (let i = 0; i < (b.count || 0); i++) {
            const x = arr[i * 16 + 12], y = arr[i * 16 + 13], z = arr[i * 16 + 14]
            if (!Number.isFinite(x) || !Number.isFinite(z)) continue
            total++
            const d = Math.hypot(x - pos[0], z - pos[2])
            if (d <= 80) near80++
            if (d <= 200) near200++
          }
        }
        out.near = { pos, total, near80, near200 }
      }
      return out
    }).catch((e) => ({ error: e.message }))
    console.log('[veg-witness] dump: ' + JSON.stringify(deep))
  }

  const stream = await readStream(page)
  console.log('[veg-witness] streamState: ' + JSON.stringify(stream))

  const checks = [
    ['vegetation has instances after the player stands on open ground', final.vegTotal > 0, `vegTotal=${final.vegTotal} peak=${peak}`],
    ['vegetation issues draw calls', final.vegDraws > 0 || final.vegImpostor > 0, `vegDraws=${final.vegDraws} impostor=${final.vegImpostor}`],
    ['grass has instances', final.grassTotal > 0, `grassTotal=${final.grassTotal}`],
  ]

  if (WALK_MS > 0) {
    const waypoints = ROUTE.split(';').map((p) => { const n = p.split(',').map(Number); return { x: n[0], z: n[1] } })
    const started = await page.evaluate((wpts, speed) => {
      const route = window.__spoint && window.__spoint.route
      if (typeof route !== 'function') return { ok: false, reason: 'window.__spoint.route is not a function' }
      route(wpts, { mode: 'walk', speed })
      return { ok: true }
    }, waypoints, WALK_SPEED).catch((e) => ({ ok: false, reason: e.message }))
    console.log('[veg-witness] walk ' + JSON.stringify(waypoints) + ' at ' + WALK_SPEED + ' m/s -> ' + JSON.stringify(started))
    if (!started.ok) {
      failed++
      console.log(`  [FAIL] walk phase could not start (${started.reason})`)
    } else {
      const tWalk = Date.now()
      let maxMissing = 0, maxStale = 0, minVeg = Infinity, pathM = 0, lastPos = final.pos
      const walkPath = []
      while (Date.now() - tWalk < WALK_MS) {
        await new Promise((r2) => setTimeout(r2, 2500))
        const s = await readStream(page)
        const m = (s.veg && s.veg.missing) || 0
        const st = (s.veg && s.veg.stale) || 0
        if (m > maxMissing) maxMissing = m
        if (st > maxStale) maxStale = st
        const walkProfile = await readProfile(page)
        if (Number.isFinite(walkProfile.vegTotal) && walkProfile.vegTotal < minVeg) minVeg = walkProfile.vegTotal
        if (Array.isArray(walkProfile.pos)) {
          if (Array.isArray(lastPos)) pathM += Math.hypot(walkProfile.pos[0] - lastPos[0], walkProfile.pos[2] - lastPos[2])
          lastPos = walkProfile.pos
          walkPath.push([Number(walkProfile.pos[0].toFixed(2)), Number(walkProfile.pos[2].toFixed(2))])
        }
      }
      console.log('[veg-witness] walk path: ' + JSON.stringify(walkPath))
      await new Promise((r2) => setTimeout(r2, 20000))
      const after = await readStream(page)
      const settled = await readProfile(page)
      const moved = (Array.isArray(final.pos) && Array.isArray(settled.pos))
        ? Math.hypot(settled.pos[0] - final.pos[0], settled.pos[2] - final.pos[2])
        : null
      console.log('[veg-witness] after walk: ' + JSON.stringify({ maxMissing, maxStale, minVeg: minVeg === Infinity ? null : minVeg, pathM: Number(pathM.toFixed(2)), moved, after, settled }))
      const veg = after.veg || {}
      checks.push(['the walk actually moved the player along the route', pathM > 50, `pathM=${Number(pathM.toFixed(2))} netM=${moved === null ? null : moved.toFixed(2)} samples=${walkPath.length}`])
      checks.push(['streaming refills the ring after a walk', veg.missing === 0, `missing=${veg.missing} loaded=${veg.loaded} expected=${veg.expected}`])
      checks.push(['walking drops chunks past the drop radius', veg.stale === 0, `stale=${veg.stale} loaded=${veg.loaded}`])
      checks.push(['vegetation stays populated while walking', minVeg > 0, `minVeg=${minVeg === Infinity ? null : minVeg}`])
      checks.push(['vegetation is still drawn after a walk', settled.vegTotal > 0 && settled.vegDraws > 0, `vegTotal=${settled.vegTotal} vegDraws=${settled.vegDraws}`])
    }
  }

  checks.push(['no page errors', errors.length === 0, `errors=${errors.slice(0, 3).join(' | ')}`])
  if (errors.length) console.log('[veg-witness] page error detail: ' + errors.slice(0, 2).join('\n---\n'))
  for (const [name, ok, detail] of checks) {
    if (!ok) failed++
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} (${detail})`)
  }
  console.log(`RESULT: ${failed === 0 ? 'PASS' : 'FAIL'} vegTotal=${final.vegTotal} peak=${peak} grass=${final.grassTotal} gpu=${gpu.renderer}`)
} finally {
  if (browser) await browser.close().catch(() => {})
  if (server && typeof server.stop === 'function') { try { await server.stop() } catch (_) {} }
}
process.exit(failed === 0 ? 0 : 1)
