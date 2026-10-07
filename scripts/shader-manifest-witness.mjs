#!/usr/bin/env node
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { chromium } from './lib/cdp-browser.mjs'
import { gpuLaunchArgs, gpuModeFlag, witnessGpu } from './lib/gpu-probe.mjs'
import { expandWorldPresets } from '../src/shared/worldPresets.js'

const argv = process.argv.slice(2)
function flag(name, dflt = null) {
  const hit = argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}

const PORT = flag('port', '3167')
const WORLD = flag('world', 'sandbox')
const PARAMS = flag('params', 'singleplayer')
const EXPECT = flag('expect', 'absent')
const TIMEOUT_MS = Number(flag('timeout', '240000'))
const SETTLE_MS = Number(flag('settle', '3000'))
const GPU_MODE = gpuModeFlag()

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TAG = '[shader-manifest]'
const failures = []
function expect(cond, msg) {
  if (cond) return true
  failures.push(msg)
  console.error(`${TAG} assertion failed: ${msg}`)
  return false
}

const PROBE = `(() => {
  const warm = window.__lastShaderWarmup || null
  const client = (window.__app && window.__app.client) || null
  return {
    warmup: warm ? { manifestDriven: !!warm.manifestDriven, manifestUrls: Array.isArray(warm.manifestUrls) ? warm.manifestUrls.slice().sort() : null, manifestedCount: warm.manifestedCount, residentCount: warm.residentCount, total: warm.total, skipped: !!warm.skipped, reason: warm.reason || null, manifestedUrls: [...new Set((warm.manifestedUrls || []).filter(Boolean))].sort(), residentModelUrls: [...new Set((warm.residentModelUrls || []).filter(Boolean))].sort() } : null,
    playerId: client ? client.playerId : null,
    connected: !!(client && client.connected),
    revealed: !!(window.__app && window.__app.revealedAt),
    entityMeshUrls: [...((window.__app && window.__app.el && window.__app.el.entityMeshes) || new Map()).values()].map(m => (m && m.userData ? m.userData.modelUrl : null) || null),
  }
})()`

const READY = `!!(window.__app && window.__app.client && window.__app.client.playerId != null && (window.__lastShaderWarmup || window.__app.revealedAt))`

async function main() {
  process.env.SPOINT_SKIP_PREWARM = process.env.SPOINT_SKIP_PREWARM || '1'
  process.env.SPOINT_NO_WATCH = '1'
  process.env.WORLD = process.env.WORLD || WORLD
  process.env.PORT = PORT

  const worldModule = await import(pathToFileURL(path.join(ROOT, 'apps', 'world', `${WORLD}.js`)).href)
  const expectedModels = [...new Set((expandWorldPresets(worldModule.default).entities || []).filter(e => e && typeof e.model === 'string').map(e => e.model))].sort()
  console.log(`${TAG} world ${WORLD} entity model urls: ${JSON.stringify(expectedModels)}`)
  console.log(`${TAG} booting real server on port ${PORT} (world=${process.env.WORLD}) ...`)
  const { boot } = await import('../src/sdk/server.js')
  const server = await boot()
  const base = `http://localhost:${PORT}`
  console.log(`${TAG} server up at ${base}`)

  const responses = []
  const requests = []
  let browser = null
  try {
    browser = await chromium.launch({ headless: true, args: gpuLaunchArgs(GPU_MODE) })
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    const pageErrors = []
    page.on('pageerror', e => pageErrors.push(String(e)))
    await page._send('Network.enable')
    page.on('Network.requestWillBeSent', p => requests.push({ url: p.request?.url || '', type: p.type || null }))
    page.on('Network.responseReceived', p => responses.push({ url: p.response?.url || '', status: p.response?.status ?? null, mime: p.response?.mimeType || null, type: p.type || null }))
    page.on('Network.loadingFailed', p => responses.push({ url: p.requestId || '', status: 'failed', mime: null, type: p.type || null, failedText: p.errorText || null }))
    const url = `${base}/?${PARAMS}${/(^|&)world=/.test(PARAMS) ? '' : `&world=${WORLD}`}`
    console.log(`${TAG} navigating to ${url}`)
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    const gpu = await witnessGpu(page, GPU_MODE)
    console.log(`${TAG} rasterizer=${gpu.rasterizer} gpu=${gpu.haystack || 'none'} gpuMode=${GPU_MODE.mode}`)

    const t0 = Date.now()
    let ready = false
    let lastCount = -1
    let stableSince = Date.now()
    while (Date.now() - t0 < TIMEOUT_MS) {
      ready = await page.evaluate(READY).catch(() => false)
      if (responses.length !== lastCount) { lastCount = responses.length; stableSince = Date.now() }
      if (ready && Date.now() - stableSince >= SETTLE_MS) break
      await new Promise(r => setTimeout(r, 250))
    }

    const probe = await page.evaluate(PROBE).catch(e => ({ error: 'evaluate failed: ' + e.message }))
    console.log(`${TAG} boot ready=${ready} pageErrors=${pageErrors.length} elapsedMs=${Date.now() - t0}`)
    for (const e of pageErrors.slice(0, 5)) console.log(`${TAG}   [pageerror] ${e.slice(0, 200)}`)
    console.log(`${TAG} probe ${JSON.stringify(probe)}`)

    const isManifest = u => /\.shadermanifest\.json(\?|$)/.test(u)
    const manifestHits = responses.filter(r => isManifest(r.url))
    const notOk = responses.filter(r => typeof r.status === 'number' && r.status >= 400)
    console.log(`${TAG} network responses observed: ${responses.length}, requests sent: ${requests.length}`)
    console.log(`${TAG} shadermanifest requests=${manifestHits.length} ${JSON.stringify(manifestHits.map(r => r.url + ' -> ' + r.status))}`)
    console.log(`${TAG} responses >= 400: ${notOk.length} ${JSON.stringify(notOk.slice(0, 12).map(r => r.url + ' -> ' + r.status))}`)

    expect(ready === true, `the page never reached a booted player (window.__app.client.playerId stayed null) -- the network log proves nothing about a boot: ${JSON.stringify(probe)}`)
    expect(probe && probe.error === undefined, `the in-page probe failed: ${JSON.stringify(probe)}`)
    expect(responses.length > 0, `zero network responses were observed: the CDP Network domain captured nothing, so this run proves nothing`)
    expect(manifestHits.length === 0, `the client requested a world shader manifest ${manifestHits.length} time(s): ${JSON.stringify(manifestHits.map(r => r.url + ' -> ' + r.status))}`)
    expect(manifestHits.every(r => r.status !== 404), `a shader manifest request answered 404: ${JSON.stringify(manifestHits.map(r => r.url + ' -> ' + r.status))}`)
    if (EXPECT === 'manifest') {
      expect(expectedModels.length > 0, `world ${WORLD} has no entity model urls, so --expect=manifest cannot hold: ${JSON.stringify(expectedModels)}`)
      expect(probe.warmup !== null, `world ${WORLD} declares a shader manifest but the shader warmup never recorded a run (window.__lastShaderWarmup is null): ${JSON.stringify(probe)}`)
      expect(probe.warmup && probe.warmup.manifestDriven === true, `world ${WORLD} declares a shader manifest but the warmup was not manifest-driven: ${JSON.stringify(probe.warmup)}`)
      expect(probe.warmup && JSON.stringify(probe.warmup.manifestUrls) === JSON.stringify(expectedModels), `the manifest the client derived ${JSON.stringify(probe.warmup && probe.warmup.manifestUrls)} is not the world's entity model urls ${JSON.stringify(expectedModels)}`)
      expect(probe.warmup && probe.warmup.skipped === false, `world ${WORLD} declares a shader manifest but the warmup skipped the compile ${JSON.stringify(probe.warmup)}`)
      const warmupUrls = probe.warmup ? [...probe.warmup.manifestedUrls, ...probe.warmup.residentModelUrls] : []
      const eligible = expectedModels.filter(u => warmupUrls.includes(u))
      expect(probe.warmup === null || JSON.stringify(probe.warmup.manifestedUrls) === JSON.stringify(eligible), `the meshes the manifest selected ${JSON.stringify(probe.warmup && probe.warmup.manifestedUrls)} are not the warmup-resident meshes whose url is in the manifest ${JSON.stringify(eligible)}: ${JSON.stringify(probe.warmup)}`)
      expect(probe.warmup === null || eligible.length === 0 || probe.warmup.manifestedCount > 0, `${eligible.length} resident mesh(es) carry a manifest url yet the warmup manifested ${probe.warmup && probe.warmup.manifestedCount}: ${JSON.stringify(probe.warmup)}`)
    } else {
      expect(expectedModels.length === 0, `world ${WORLD} carries entity model urls ${JSON.stringify(expectedModels)}, so --expect=absent is the wrong arm for it`)
      expect(probe.warmup === null || (probe.warmup.manifestDriven === false && probe.warmup.manifestUrls === null), `world ${WORLD} has no entity model urls yet the warmup carried manifest ${JSON.stringify(probe.warmup && probe.warmup.manifestUrls)} (warmup null means it was skipped entirely, which is the expected singleplayer path at >= 10 entity meshes)`)
    }

    await browser.close().catch(() => {})
  } catch (e) {
    console.error(`${TAG} run FAILED: ${e.stack || e.message}`)
    failures.push(String(e.message || e))
    try { if (browser) await browser.close() } catch (_) {}
  }
  try { server.stop() } catch (_) {}

  if (failures.length) {
    console.error(`${TAG} RESULT: FAIL -- ${failures.length} assertion(s) failed, first: ${failures[0]}`)
    process.exit(1)
  }
  console.log(`${TAG} RESULT: PASS -- world=${WORLD} params=${PARAMS} expect=${EXPECT} shadermanifest requests=0${EXPECT === 'manifest' ? ', warmup manifest-driven' : ''}`)
  process.exit(0)
}

main()
