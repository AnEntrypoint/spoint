#!/usr/bin/env node
import { chromium } from './lib/cdp-browser.mjs'
import { gpuLaunchArgs, gpuModeFlag } from './lib/gpu-probe.mjs'
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
const GPU_MODE = gpuModeFlag()
const GPU_VENDOR = flag('gpu', null)
const SHOT = flag('screenshot', null)
const ALLOW_ERRORS = has('allow-errors')
const ALLOW_CONSOLE_ERRORS = has('allow-console-errors')
const ALLOWED_CONSOLE_ERROR_TEXTS = process.argv.filter(a => a.startsWith('--allow-console-error=')).map(a => a.slice('--allow-console-error='.length))
const ALLOW_FAILED_REQUESTS = has('allow-failed-requests')
const CANCELLED_REQUEST_ERROR_TEXTS = new Set(['net::ERR_ABORTED'])
const REQUIRE_GPU = flag('require-gpu') || (has('require-gpu') ? 'any' : null)

const SOFTWARE_ADAPTER = /swiftshader|llvmpipe|softwarerasterizer|microsoft basic render|apple software renderer/i
const VENDOR_ADAPTER = {
  amd: /amd|radeon|rdna/i,
  nvidia: /nvidia|geforce|rtx|quadro/i,
  intel: /intel|\barc\b|iris|uhd graphics|hd graphics/i,
}

const LUID_POWERSHELL = `
$live = @{}
(Get-Counter '\\GPU Adapter Memory(*)\\Dedicated Usage').CounterSamples | ForEach-Object {
  if ($_.InstanceName -match 'luid_0x([0-9a-f]+)_0x([0-9a-f]+)_') {
    $high = [Convert]::ToInt64($matches[1], 16)
    $low = [Convert]::ToInt64($matches[2], 16)
    $live[[string]($high * 4294967296 + $low)] = "$high,$low"
  }
}
Get-ChildItem HKLM:\\SOFTWARE\\Microsoft\\DirectX | ForEach-Object {
  $p = Get-ItemProperty $_.PSPath
  if ($p.Description -and $null -ne $p.AdapterLuid) {
    $key = [string]$p.AdapterLuid
    if ($live.ContainsKey($key)) { "$($p.Description)|$($live[$key])" }
  }
}
`

async function adapterLuidArgs(vendor) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)
  const pattern = VENDOR_ADAPTER[vendor]
  if (!pattern) throw new Error(`gpu=${vendor}: unknown vendor, expected one of ${Object.keys(VENDOR_ADAPTER).join(', ')}`)
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', LUID_POWERSHELL], { maxBuffer: 1 << 20 })
  for (const line of stdout.split('\n')) {
    const [description, luid] = line.split('|')
    if (!description || !luid || /basic render/i.test(description)) continue
    if (pattern.test(description)) return ['--use-angle=d3d11', `--use-adapter-luid=${luid.trim()}`]
  }
  const seen = stdout.split('\n').filter(l => l.includes('|')).map(l => l.split('|')[0].trim()).join(', ') || 'none'
  throw new Error(`gpu=${vendor}: no live ${vendor} adapter found among: ${seen}`)
}

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
    const args = GPU_VENDOR
      ? await adapterLuidArgs(GPU_VENDOR)
      : gpuLaunchArgs(GPU_MODE)
    browser = await chromium.launch({ headless: HEADLESS, args })
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    const consoleEntries = []
    const pageErrors = []
    const failedRequests = []
    const cancelledRequests = []
    page.on('pageerror', e => pageErrors.push(String(e)))
    page.on('Runtime.consoleAPICalled', p => consoleEntries.push({ level: p?.type || 'unknown', text: textOf(p) }))
    page.on('Runtime.exceptionThrown', p => consoleEntries.push({ level: 'exception', text: p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || 'exception' }))
    await page.enableDomain('Network.enable')
    await page.enableDomain('Log.enable')
    const requestUrls = new Map()
    page.on('Network.requestWillBeSent', p => { if (p?.requestId) requestUrls.set(p.requestId, p?.request?.url || 'unknown-request') })
    const recordFailedRequest = (bucket, p) => bucket.push({ url: (p?.requestId && requestUrls.get(p.requestId)) || p?.requestId || 'unknown-request', text: p?.errorText || 'failed' })
    page.on('Network.loadingFailed', p => recordFailedRequest(CANCELLED_REQUEST_ERROR_TEXTS.has(p?.errorText) ? cancelledRequests : failedRequests, p))
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
    const wanted = GPU_VENDOR || REQUIRE_GPU || 'any'
    const gotVendor = Object.keys(VENDOR_ADAPTER).find(v => VENDOR_ADAPTER[v].test(gpuName) || VENDOR_ADAPTER[v].test(gpu.renderer || '')) || null
    const gpuKind = gpuSoftware ? 'SOFTWARE (swiftshader/llvmpipe or no webgpu adapter)' : (gotVendor ? gotVendor.toUpperCase() : 'UNRECOGNISED ADAPTER')
    console.log(`[page-boot-witness] gpu adapter=${JSON.stringify(gpuName)} glRenderer=${JSON.stringify(gpu.renderer)} classification=${gpuKind} wanted=${JSON.stringify(wanted || 'any')} gpuMode=${GPU_MODE.mode}`)
    if (GPU_MODE.accelerated && gpuSoftware) fail(`gpuMode=${GPU_MODE.mode} demands an accelerated rasterizer but the page measured ${gpuKind} (${gpuName})`)
    if (GPU_MODE.vendor) {
      const wantVendor = VENDOR_ADAPTER[GPU_MODE.vendor] || new RegExp(GPU_MODE.vendor, 'i')
      if (!wantVendor.test(`${gpuName} ${gpu.renderer || ''}`)) fail(`gpuMode=${GPU_MODE.mode} demands a ${GPU_MODE.vendor} adapter but the page measured ${gpuName} / ${gpu.renderer}`)
    }
    if (SHOT) { await page.screenshot({ path: SHOT }); console.log(`[page-boot-witness] screenshot -> ${SHOT}`) }

    const consoleErrorLevels = new Set(['error', 'exception'])
    const consoleErrorEntries = consoleEntries.filter(e => consoleErrorLevels.has(e.level))
    const unallowedConsoleErrors = ALLOW_CONSOLE_ERRORS
      ? []
      : consoleErrorEntries.filter(e => !ALLOWED_CONSOLE_ERROR_TEXTS.some(t => e.text.includes(t)))
    const levelCounts = consoleEntries.reduce((acc, e) => { acc[e.level] = (acc[e.level] || 0) + 1; return acc }, {})
    console.log(`[page-boot-witness] console entries=${consoleEntries.length} levels=${JSON.stringify(levelCounts)} pageErrors=${pageErrors.length} failedRequests=${failedRequests.length} cancelledRequests=${cancelledRequests.length} consoleErrors=${consoleErrorEntries.length} unallowedConsoleErrors=${unallowedConsoleErrors.length}`)
    const warnErr = has('console-all') ? consoleEntries : consoleEntries.filter(e => e.level === 'warning' || e.level === 'error' || e.level === 'exception')
    const consoleLimit = Number(flag('console-limit', '20'))
    const shown = consoleLimit === 0 ? warnErr : warnErr.slice(0, consoleLimit)
    for (const e of shown) console.log(`  [${e.level}] ${e.text.slice(0, 240)}`)
    for (const e of unallowedConsoleErrors) console.log(`  [unallowed-console-error] ${e.text.slice(0, 240)}`)
    for (const e of pageErrors.slice(0, 10)) console.log(`  [pageerror] ${String(e).slice(0, 240)}`)
    for (const f of failedRequests.slice(0, 20)) console.log(`  [request] ${f.text} ${f.url}`)
    for (const f of cancelledRequests.slice(0, 20)) console.log(`  [request-cancelled] ${f.text} ${f.url}`)
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
    if (consoleEntries.length === 0 && marks.length === 0) failures.push('the page produced neither a console entry nor a performance mark: an empty observation set witnesses nothing and is not a boot')
    if (unreached.length) failures.push(unreached.join('; '))
    if (REQUIRE_GPU && REQUIRE_GPU === 'any' && gpuSoftware) failures.push(`the arm needs a real GPU but the page has no WebGPU adapter and/or a software GL renderer (adapter=${JSON.stringify(gpuName)}, glRenderer=${JSON.stringify(gpu.renderer)})`)
    if (REQUIRE_GPU && REQUIRE_GPU !== 'any' && (gpuSoftware || gotVendor !== REQUIRE_GPU)) failures.push(`the arm needs the ${REQUIRE_GPU} adapter but the page got ${JSON.stringify(gpuName)} / ${JSON.stringify(gpu.renderer)} (classed ${gpuKind})`)
    if (!ALLOW_ERRORS && pageErrors.length) failures.push(`${pageErrors.length} uncaught page error(s): ${String(pageErrors[0]).slice(0, 200)}`)
    if (!ALLOW_FAILED_REQUESTS && failedRequests.length) failures.push(`${failedRequests.length} failed request(s): ${failedRequests[0].text} ${failedRequests[0].url}`)
    if (unallowedConsoleErrors.length) failures.push(`${unallowedConsoleErrors.length} console error(s)/exception(s) the page caught and logged instead of surfacing: ${unallowedConsoleErrors[0].text.slice(0, 200)}`)
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
