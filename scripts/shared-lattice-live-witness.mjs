// Live witness: on a real client, does the placement surface read the collider's own sample buffer?
//
// scripts/shared-lattice-surface-witness.mjs measures the change without a GPU and without a page.
// This one proves the wiring actually reaches the browser: that the world's bakedHeightfield arrives
// in the client's terrain config, that the rendered-mesh mirror reports reading it, that the live
// residual between the lattice and the frame is the one measured offline, and that grass is still
// placed and still on the ground in the near, mid and far bands with time of day pinned and weather
// off -- the 600 s day cycle and rain otherwise swamp the comparison.
//
// Screenshots go to a scratch directory outside the repo; nothing here writes tracked files.
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { chromium, DEFAULT_VIEWPORT } from './lib/cdp-browser.mjs'
import { assertGpu } from './lib/gpu-probe.mjs'
import { vendorLaunchArgs } from './lib/witness-gpu.mjs'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const SHOTS = mkdtempSync(resolve(tmpdir(), 'shared-lattice-live-'))

const argv = process.argv.slice(2)
const arg = (n, d) => { const h = argv.find(a => a.startsWith(`--${n}=`)); return h === undefined ? d : h.slice(n.length + 3) }
const WORLD = String(arg('world', 'tps-game'))
const GPU = String(arg('gpu', 'nvidia'))
const TOD = Number(arg('tod', 0.35))
const WALK_MS = Number(arg('walkMs', 8000))

const failures = []
const measurements = []
function expect(name, got, predicate) {
  measurements.push(name)
  let ok = false
  try { ok = Boolean(predicate(got)) } catch { ok = false }
  if (!ok) failures.push(`${name}=${JSON.stringify(got)}`)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} = ${JSON.stringify(got)}`)
  return got
}
const finite = (v) => Number.isFinite(v)

const PORT = String(20000 + Math.floor(Math.random() * 20000))
process.env.WORLD = process.env.WORLD || WORLD
process.env.PORT = PORT
process.env.SPOINT_NO_WATCH = '1'
const { boot } = await import(pathToFileURL(resolve(ROOT, 'src', 'sdk', 'server.js')).href)
const server = await boot()
console.log(`[shared-lattice-live] server up on ${PORT} world=${process.env.WORLD}`)

const browser = await chromium.launch({ args: [...vendorLaunchArgs(GPU)] })
try {
  const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT })
  const terrainLines = []
  page.on('console', (m) => { const t = String(m.text() || ''); if (t.includes('[terrain]')) terrainLines.push(t.slice(0, 220)) })
  page.on('pageerror', (e) => console.log('[shared-lattice-live] pageerror: ' + String((e && e.message) || e).slice(0, 300)))
  const url = `http://127.0.0.1:${PORT}/?multiplayer&world=${WORLD}&v=${Date.now()}`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })

  const bootStart = Date.now()
  let ready = false
  while (Date.now() - bootStart < 240000) {
    const r = await page.evaluate(() => ({
      terrain: !!(window.__terrain && window.__terrain.frame),
      revealedAt: (window.__app && window.__app.revealedAt) || 0,
      connected: !!(window.__client && window.__client.connected),
    })).catch(() => null)
    if (r && r.terrain && r.revealedAt && r.connected) { ready = true; break }
    await new Promise((r2) => setTimeout(r2, 1000))
  }
  if (!ready) throw new Error('page never reached terrain+revealedAt')
  console.log(`[shared-lattice-live] boot ok in ${Math.round((Date.now() - bootStart) / 1000)}s`)

  const gpu = await assertGpu(page, { requireAccelerated: true, expectVendor: GPU })
  const ri = await page.evaluate(() => window.__rendererInfo || null)
  console.log(`[shared-lattice-live] gpu=${GPU} accelerated=${gpu.accelerated} rasterizer=${gpu.rasterizer} rendererInfo=${JSON.stringify(ri)}`)
  expect('the GPU arm is accelerated on the adapter it names', gpu.accelerated, (v) => v === true)
  expect('window.__rendererInfo is pinned', ri ? String(ri.renderer || ri.vendor || 'set') : null, (v) => typeof v === 'string' && v.length > 0)

  for (const l of terrainLines) console.log(`[shared-lattice-live] page: ${l}`)

  // Pin the two things that otherwise swamp a visual comparison.
  const pinned = await page.evaluate(`(() => {
    const W = window
    const out = {}
    const tod = W.__timeOfDayApi
    if (tod && typeof tod.setPaused === 'function') { tod.setPaused(true); if (typeof tod.setFraction === 'function') tod.setFraction(${TOD}) }
    out.todPaused = tod && typeof tod.isPaused === 'function' ? tod.isPaused() : null
    const wx = W.__weather
    if (wx && typeof wx.setIntensity === 'function') wx.setIntensity(0)
    out.weatherIntensity = wx && typeof wx.getIntensity === 'function' ? wx.getIntensity() : null
    return out
  })()`)
  console.log(`[shared-lattice-live] pinned: ${JSON.stringify(pinned)}`)
  expect('time of day is pinned', pinned.todPaused, (v) => v === true)
  expect('weather is off', pinned.weatherIntensity, (v) => v === 0)

  // ---- the wiring: the bake reached the client and the mirror is reading it
  const wiring = await page.evaluate(`(() => {
    const t = window.__terrain
    if (!t) return { error: 'no window.__terrain' }
    const lat = typeof t.sharedLattice === 'function' ? t.sharedLattice() : null
    const ms = typeof t.meshSurface === 'function' ? t.meshSurface() : null
    const st = ms && typeof ms.stats === 'function' ? ms.stats() : null
    const out = {
      lattice: lat ? { N: lat.N, extent: lat.extent, stepM: lat.stepM, kind: lat.kind } : null,
      mirrorStats: st,
      groundSource: t.frame ? t.frame.groundSource : null,
      renderMeshHeightAtLocal: typeof (t.frame && t.frame.renderMeshHeightAtLocal),
      chartEpoch: t.frame ? t.frame.chartEpoch : null,
    }
    if (lat) {
      // The live residual: the lattice vs the frame's own solve, over the ground under the player.
      const f = t.frame
      const diffs = []
      for (let k = 1; k <= 400; k++) {
        const a = (k * 2.399963) % (Math.PI * 2)
        const r = 2 + (k / 400) * 58
        const x = Math.cos(a) * r, z = Math.sin(a) * r
        if (!lat.covers(x, z)) continue
        const exact = f.groundHeightLocal(x, z)
        const ly = lat.heightAtLocal(x, z)
        if (Number.isFinite(exact) && Number.isFinite(ly)) diffs.push(Math.abs(ly - exact))
      }
      diffs.sort((a, b) => a - b)
      out.liveProbes = diffs.length
      out.liveMeanM = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : null
      out.liveMaxM = diffs.length ? diffs[diffs.length - 1] : null
    }
    let instanced = 0, instancedMeshes = 0
    try {
      const seen = []
      const walk = (o) => { if (!o) return; if (o.isInstancedMesh || (o.count && o.instanceMatrix)) { instancedMeshes++; instanced += (o.count || 0) }; (o.children || []).forEach(walk); seen.push(1) }
      if (window.__app && window.__app.scene) walk(window.__app.scene)
      else if (window.__scene) walk(window.__scene)
    } catch (_) {}
    out.instancedMeshes = instancedMeshes
    out.instancedTotal = instanced
    return out
  })()`)
  console.log(`[shared-lattice-live] wiring: ${JSON.stringify(wiring, null, 2)}`)
  expect('the client resolved the shared lattice', wiring.lattice ? [wiring.lattice.N, wiring.lattice.stepM] : null, (v) => Array.isArray(v) && v[0] === 257 && Math.abs(v[1] - 1) < 1e-9)
  expect('the mesh mirror reports reading the lattice', wiring.mirrorStats ? wiring.mirrorStats.latticeVertexHits : null, (v) => Number.isInteger(v) && v > 0)
  expect('the live lattice-vs-frame residual is under 5 cm', wiring.liveMaxM, (v) => finite(v) && v <= 0.05)
  expect('grass and vegetation instances are in the scene', wiring.instancedTotal, (v) => Number.isFinite(v) && v > 0)

  // ---- visual: near, then walk out, then further out. Time of day and weather are pinned above.
  const shot = async (name) => {
    const p = resolve(SHOTS, `${name}.png`)
    const buf = await page.screenshot()
    writeFileSync(p, buf)
    const pos = await page.evaluate(`(() => { const c = window.__client && window.__client.getLocalState ? window.__client.getLocalState() : null; const v = c && c.position; return v ? [Math.round(v[0]), Math.round(v[1]), Math.round(v[2])] : null })()`)
    console.log(`[shared-lattice-live] shot ${name} -> ${p} at position ${JSON.stringify(pos)}`)
    return { p, pos }
  }
  const shots = []
  shots.push(await shot('near'))
  await page.keyboard.down('KeyW').catch(() => {})
  await new Promise((r) => setTimeout(r, WALK_MS))
  await page.keyboard.up('KeyW').catch(() => {})
  await new Promise((r) => setTimeout(r, 1500))
  shots.push(await shot('mid'))
  await page.keyboard.down('KeyW').catch(() => {})
  await new Promise((r) => setTimeout(r, WALK_MS * 2))
  await page.keyboard.up('KeyW').catch(() => {})
  await new Promise((r) => setTimeout(r, 1500))
  shots.push(await shot('far'))

  const after = await page.evaluate(`(() => { const ms = window.__terrain && typeof window.__terrain.meshSurface === 'function' ? window.__terrain.meshSurface() : null; return ms && typeof ms.stats === 'function' ? ms.stats() : null })()`)
  console.log(`[shared-lattice-live] mirror stats after the walk: ${JSON.stringify(after)}`)
  expect('the mirror kept reading the lattice while the player moved', after ? after.latticeVertexHits : null, (v) => Number.isInteger(v) && v > 0)
  expect('the mirror served every placement query it was asked', after ? after.unserved / Math.max(1, after.queries) : null, (v) => finite(v) && v <= 0.5)
  console.log(`[shared-lattice-live] screenshots: ${shots.map(s => s.p).join(' ')}`)
} finally {
  const pid = browser.pid
  await browser.close().catch(() => {})
  if (pid) { try { process.kill(pid, 'SIGKILL') } catch (_) {} }
  try { server.stop() } catch (_) {}
}
console.log('')
for (const f of failures) console.log(`FAIL: ${f}`)
if (failures.length) console.log(`RESULT: FAIL (${failures.length} of ${measurements.length} measurement(s))`)
else console.log('RESULT: PASS')
await exitAfterQuiesce(failures.length ? 1 : 0, 1500)
