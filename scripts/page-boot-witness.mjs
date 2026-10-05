#!/usr/bin/env node
import { chromium } from './lib/cdp-browser.mjs'
import { unreachedReasons } from './lib/witness-reachability.mjs'

function flag(name, dflt = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const has = (name) => process.argv.includes(`--${name}`)

const PORT = flag('port', '3118')
const PARAMS = flag('params', 'singleplayer')
const SETUP = flag('set', null)
const WAITS = String(flag('wait', 'window.__app && window.__app.loadingMachine && window.__app.loadingMachine.isReady')).split('|').map(s => s.trim()).filter(Boolean)
const REQUIRES = String(flag('require', '')).split('|').map(s => s.trim()).filter(Boolean)
const TIMEOUT_MS = Number(flag('timeout', '180000'))
const OBSERVE_MS = Number(flag('observe', '0'))
const PROXY = flag('proxy', null)
const WORLD = flag('world', 'tps-game')
const HEADLESS = !has('headed')
const GL = flag('gl', 'swiftshader')
const SHOT = flag('screenshot', null)
const ALLOW_ERRORS = has('allow-errors')
const ALLOW_FAILED_REQUESTS = has('allow-failed-requests')
const REQUIRE_GPU = has('require-gpu')

const SOFTWARE_ADAPTER = /swiftshader|llvmpipe|softwarerasterizer|microsoft basic render|apple software renderer/i

const GPU_PROBE = `(() => { try {
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
  const ext = gl && gl.getExtension('WEBGL_debug_renderer_info')
  const renderer = gl ? String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : null
  let webgpu = 'unavailable'
  if (typeof navigator !== 'undefined' && navigator.gpu && typeof navigator.gpu.requestAdapter === 'function') {
    webgpu = navigator.gpu.requestAdapter().then(a => a ? ((a.info && (a.info.description || a.info.vendor)) || 'adapter-without-info') : null)
  }
  return Promise.resolve(webgpu).then(w => ({ renderer, webgpu: w === null || w === 'unavailable' ? String(w) : String(w), webgpuPresent: w !== null && w !== 'unavailable' }))
} catch (e) { return { renderer: null, webgpu: 'probe-threw: ' + e.message, webgpuPresent: false } } })()`

function textOf(entry) {
  const args = entry?.args || []
  return args.map(a => a?.description || (a?.value === undefined ? '' : String(a.value))).join(' ')
}

async function main() {
  process.env.SPOINT_SKIP_PREWARM = process.env.SPOINT_SKIP_PREWARM || '1'
  process.env.WORLD = process.env.WORLD || WORLD
  process.env.PORT = PORT
  process.env.SPOINT_NO_WATCH = '1'
  let server = null
  let base = PROXY
  if (!base) {
    console.log(`[page-boot-witness] booting real server on port ${PORT} (world=${process.env.WORLD}) ...`)
    const { boot } = await import('../src/sdk/server.js')
    server = await boot()
    base = `http://localhost:${PORT}`
    console.log('[page-boot-witness] server up.')
  } else {
    console.log(`[page-boot-witness] using existing origin ${base}`)
  }

  let browser
  const fail = (msg) => { console.error(`[page-boot-witness] RESULT: FAIL -- ${msg}`); process.exit(1) }
  try {
    const args = GL === 'none' ? [] : ['--use-gl=' + GL, '--use-angle=' + GL, '--ignore-gpu-blocklist']
    browser = await chromium.launch({ headless: HEADLESS, args })
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    const consoleEntries = []
    const pageErrors = []
    const failedRequests = []
    page.on('pageerror', e => pageErrors.push(String(e)))
    page.on('Runtime.consoleAPICalled', p => consoleEntries.push({ level: p?.type || 'unknown', text: textOf(p) }))
    page.on('Runtime.exceptionThrown', p => consoleEntries.push({ level: 'exception', text: p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || 'exception' }))
    await page.enableDomain('Network.enable')
    await page.enableDomain('Log.enable')
    const requestUrls = new Map()
    page.on('Network.requestWillBeSent', p => { if (p?.requestId) requestUrls.set(p.requestId, p?.request?.url || 'unknown-request') })
    page.on('Network.loadingFailed', p => failedRequests.push({ url: (p?.requestId && requestUrls.get(p.requestId)) || p?.requestId || 'unknown-request', text: p?.errorText || 'failed' }))
    page.on('Network.responseReceived', p => {
      const status = p?.response?.status || 0
      if (status >= 400) failedRequests.push({ url: p?.response?.url, text: 'HTTP ' + status })
    })
    if (SETUP) await page._send('Page.addScriptToEvaluateOnNewDocument', { source: SETUP })

    const url = `${base}/?${PARAMS}`
    console.log(`[page-boot-witness] navigating to ${url} ...`)
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    const t0 = Date.now()

    const times = {}
    for (const expr of WAITS) {
      let ok = false
      while (Date.now() - t0 < TIMEOUT_MS) {
        ok = await page.evaluate(`!!(${expr})`).catch(() => false)
        if (ok) break
        await new Promise(r => setTimeout(r, 200))
      }
      times[expr] = ok ? Date.now() - t0 : null
      console.log(`[page-boot-witness] wait ${ok ? 'reached' : 'UNREACHED'} ${JSON.stringify(expr)} @ ${JSON.stringify(times[expr])}ms`)
    }
    if (OBSERVE_MS > 0) await page.waitForTimeout(OBSERVE_MS)

    const values = {}
    for (const expr of [...WAITS, ...REQUIRES]) values[expr] = await page.evaluate(`(() => { try { return (${expr}) } catch (e) { return 'threw: ' + e.message } })()`).catch(e => 'evaluate failed: ' + e.message)
    const marks = await page.evaluate(`performance.getEntriesByType('mark').map(m => ({ name: m.name, t: Math.round(m.startTime) }))`).catch(() => [])
    const gpu = await page.evaluate(GPU_PROBE).catch(e => ({ renderer: null, webgpu: 'probe failed: ' + e.message, webgpuPresent: false }))
    const gpuSoftware = !gpu.webgpuPresent || !gpu.renderer || SOFTWARE_ADAPTER.test(gpu.renderer) || SOFTWARE_ADAPTER.test(gpu.webgpu)
    const gpuName = gpu.webgpuPresent ? gpu.webgpu : (gpu.renderer || 'none')
    console.log(`[page-boot-witness] gpu adapter=${JSON.stringify(gpuName)} glRenderer=${JSON.stringify(gpu.renderer)} classification=${gpuSoftware ? 'SOFTWARE (swiftshader/llvmpipe or no webgpu adapter)' : 'DISCRETE/NAMED (' + gpuName + ')'}`)
    if (SHOT) { await page.screenshot({ path: SHOT }); console.log(`[page-boot-witness] screenshot -> ${SHOT}`) }

    console.log(`[page-boot-witness] console entries=${consoleEntries.length} pageErrors=${pageErrors.length} failedRequests=${failedRequests.length}`)
    const warnErr = has('console-all') ? consoleEntries : consoleEntries.filter(e => e.level === 'warning' || e.level === 'error' || e.level === 'exception')
    const consoleLimit = Number(flag('console-limit', '20'))
    const shown = consoleLimit === 0 ? warnErr : warnErr.slice(0, consoleLimit)
    for (const e of shown) console.log(`  [${e.level}] ${e.text.slice(0, 240)}`)
    for (const e of pageErrors.slice(0, 10)) console.log(`  [pageerror] ${String(e).slice(0, 240)}`)
    for (const f of failedRequests.slice(0, 20)) console.log(`  [request] ${f.text} ${f.url}`)
    console.log('[page-boot-witness] values ' + JSON.stringify(values))
    console.log('[page-boot-witness] marks ' + JSON.stringify(marks))

    await browser.close().catch(() => {})
    if (server) server.stop()

    const unreached = unreachedReasons({
      marks: marks.map(m => m.name),
      requiredMarks: String(flag('require-mark', '')).split('|').map(s => s.trim()).filter(Boolean),
      counts: Object.fromEntries(Object.entries(times).map(([k, v]) => [k, v])),
      requiredCounts: WAITS,
    })
    const failures = []
    if (unreached.length) failures.push(unreached.join('; '))
    if (REQUIRE_GPU && gpuSoftware) failures.push(`the arm needs a real GPU but the page has no WebGPU adapter and/or a software GL renderer (adapter=${JSON.stringify(gpuName)}, glRenderer=${JSON.stringify(gpu.renderer)})`)
    if (!ALLOW_ERRORS && pageErrors.length) failures.push(`${pageErrors.length} uncaught page error(s): ${String(pageErrors[0]).slice(0, 200)}`)
    if (!ALLOW_FAILED_REQUESTS && failedRequests.length) failures.push(`${failedRequests.length} failed request(s): ${failedRequests[0].text} ${failedRequests[0].url}`)
    if (failures.length) fail(failures.join('; '))
    console.log(`[page-boot-witness] RESULT: PASS -- ${JSON.stringify(times)}`)
    process.exit(0)
  } catch (e) {
    console.error('[page-boot-witness] run FAILED:', e.stack || e.message)
    if (browser) await browser.close().catch(() => {})
    if (server) server.stop()
    process.exit(1)
  }
}

main()
