import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from './lib/cdp-browser.mjs'
import { gpuArgs, adapterLuidFor, assertGpu } from './lib/gpu-probe.mjs'

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
const EXPECT_VENDOR = flag('expect-vendor', GPU)
const AMD_LUID = adapterLuidFor('amd')
if (GPU === 'amd' && !AMD_LUID) {
  console.error('[veg-witness] no AMD adapter LUID resolvable; pass --gpu=nvidia or check the DirectX registry')
  process.exit(2)
}
const VENDOR_ARGS = {
  nvidia: ['--use-gl=angle', '--use-angle=d3d11'],
  amd: ['--use-gl=angle', '--use-angle=d3d11', '--use-adapter-luid=0,' + AMD_LUID],
}

const port = String(20000 + Math.floor(Math.random() * 20000))
process.env.WORLD = process.env.WORLD || 'tps-game'
process.env.PORT = port
process.env.SPOINT_NO_WATCH = '1'

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

let browser
let failed = 0
try {
  browser = await chromium.launch({ args: [...gpuArgs({ accelerated: true }), ...(VENDOR_ARGS[GPU] || VENDOR_ARGS.nvidia)] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String((e && e.message) || e)))
  const url = `http://localhost:${port}/?singleplayer&world=tps-game&at=${encodeURIComponent(AT)}&v=${Date.now()}`
  console.log('[veg-witness] ' + url)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })

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

  const stream = await page.evaluate(() => {
    const app = window.__app || {}
    const grab = (o) => {
      if (!o || !o.streamState) return null
      const s = o.streamState()
      return { ...s, missingKeys: (s.missingKeys || []).slice(0, 6) }
    }
    return { veg: grab(app.vegetation), grass: grab(app.grass), rocks: grab(app.rocks) }
  }).catch((e) => ({ error: e.message }))
  console.log('[veg-witness] streamState: ' + JSON.stringify(stream))

  const checks = [
    ['vegetation has instances after the player stands on open ground', final.vegTotal > 0, `vegTotal=${final.vegTotal} peak=${peak}`],
    ['vegetation issues draw calls', final.vegDraws > 0 || final.vegImpostor > 0, `vegDraws=${final.vegDraws} impostor=${final.vegImpostor}`],
    ['grass has instances', final.grassTotal === null || final.grassTotal > 0, `grassTotal=${final.grassTotal}`],
    ['no page errors', errors.length === 0, `errors=${errors.slice(0, 3).join(' | ')}`],
  ]
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
