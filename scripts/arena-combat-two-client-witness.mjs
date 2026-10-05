#!/usr/bin/env node
import { chromium } from './lib/cdp-browser.mjs'

function flag(name, dflt = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}

const PORT = flag('port', '3130')
const PROXY = flag('proxy', null)
const PARAMS = flag('params', '')
const GL = flag('gl', 'swiftshader')
const READY_TIMEOUT_MS = Number(flag('timeout', '180000'))
const SHOTS = Number(flag('shots', '10'))
const SETTLE_MS = Number(flag('settle', '4000'))

const READY = 'window.__app && window.__app.loadingMachine && window.__app.loadingMachine.isReady'

function textOf(entry) {
  const args = entry?.args || []
  return args.map(a => a?.description || (a?.value === undefined ? '' : String(a.value))).join(' ')
}

async function makeClient(browser, base, label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await context.newPage()
  const consoleEntries = []
  const pageErrors = []
  const failedRequests = []
  page.on('pageerror', e => pageErrors.push(String(e)))
  page.on('Runtime.consoleAPICalled', p => consoleEntries.push({ level: p?.type || 'unknown', text: textOf(p) }))
  page.on('Runtime.exceptionThrown', p => consoleEntries.push({ level: 'exception', text: p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || 'exception' }))
  await page.enableDomain('Network.enable')
  page.on('Network.loadingFailed', p => failedRequests.push({ url: p?.requestId || 'unknown-request', text: p?.errorText || 'failed' }))
  page.on('Network.responseReceived', p => {
    const status = p?.response?.status || 0
    if (status >= 400) failedRequests.push({ url: p?.response?.url, text: 'HTTP ' + status })
  })
  return { label, page, consoleEntries, pageErrors, failedRequests }
}

async function waitFor(page, expr, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const ok = await page.evaluate(`!!(${expr})`).catch(() => false)
    if (ok) return Date.now() - t0
    await new Promise(r => setTimeout(r, 250))
  }
  return null
}

async function main() {
  process.env.SPOINT_SKIP_PREWARM = process.env.SPOINT_SKIP_PREWARM || '1'
  process.env.WORLD = process.env.WORLD || 'arena-combat'
  process.env.PORT = PORT
  process.env.SPOINT_NO_WATCH = '1'

  let server = null
  let base = PROXY
  if (!base) {
    console.log(`[arena-combat] booting real server on port ${PORT} (world=${process.env.WORLD}) ...`)
    const { boot } = await import('../src/sdk/server.js')
    server = await boot()
    base = `http://localhost:${PORT}`
    console.log('[arena-combat] server up.')
  }

  let browser
  try {
    const args = GL === 'none' ? [] : ['--use-gl=' + GL, '--use-angle=' + GL, '--ignore-gpu-blocklist']
    browser = await chromium.launch({ headless: true, args })
    const a = await makeClient(browser, base, 'clientA')
    const b = await makeClient(browser, base, 'clientB')

    const url = base + '/' + (PARAMS ? '?' + PARAMS : '')
    for (const c of [a, b]) {
      console.log(`[arena-combat] navigating ${c.label} to ${url} ...`)
      await c.page.goto(url, { waitUntil: 'domcontentloaded' })
    }

    for (const c of [a, b]) {
      c.readyMs = await waitFor(c.page, READY, READY_TIMEOUT_MS)
      console.log(`[arena-combat] ${c.label} ready=${c.readyMs === null ? 'UNREACHED' : c.readyMs + 'ms'}`)
    }

    const centre = await a.page.evaluate(() => {
      const el = window.__app?.renderer?.domElement
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    }).catch(() => null)
    console.log(`[arena-combat] clientA canvas centre=${JSON.stringify(centre)}`)

    if (centre) {
      await a.page.mouse.click(centre.x, centre.y)
      await new Promise(r => setTimeout(r, 500))
    }
    await new Promise(r => setTimeout(r, SETTLE_MS))
    const readHud = (c) => c.page.evaluate('(() => ({ lock: window.__app?.pointerLock || null, hud: (document.body.innerText || "").slice(0, 400) }))()').catch(() => null)
    const before = await readHud(a)
    console.log(`[arena-combat] clientA before=${JSON.stringify(before)}`)

    if (centre) {
      for (let i = 0; i < SHOTS; i++) {
        await a.page.mouse.move(centre.x, centre.y)
        await a.page.mouse.down()
        await new Promise(r => setTimeout(r, 120))
        await a.page.mouse.up()
        await new Promise(r => setTimeout(r, 250))
      }
      console.log(`[arena-combat] clientA fired ${SHOTS} shot(s)`)
    }

    await new Promise(r => setTimeout(r, SETTLE_MS))
    const after = await readHud(a)
    console.log(`[arena-combat] clientA after=${JSON.stringify(after)}`)
    const afterB = await readHud(b)
    console.log(`[arena-combat] clientB after=${JSON.stringify(afterB)}`)

    await browser.close().catch(() => {})
    if (server) server.stop()

    const failures = []
    for (const c of [a, b]) {
      const errors = c.consoleEntries.filter(e => e.level === 'error' || e.level === 'exception')
      console.log(`[arena-combat] ${c.label} consoleEntries=${c.consoleEntries.length} consoleErrors=${errors.length} pageErrors=${c.pageErrors.length} failedRequests=${c.failedRequests.length}`)
      for (const e of errors.slice(0, 10)) console.log(`  [${c.label}][${e.level}] ${e.text.slice(0, 240)}`)
      for (const e of c.pageErrors.slice(0, 10)) console.log(`  [${c.label}][pageerror] ${String(e).slice(0, 240)}`)
      for (const f of c.failedRequests.slice(0, 10)) console.log(`  [${c.label}][request] ${f.text} ${f.url}`)
      if (c.readyMs === null) failures.push(`${c.label} never reached world-ready`)
      if (c.pageErrors.length) failures.push(`${c.label} had ${c.pageErrors.length} uncaught page error(s): ${String(c.pageErrors[0]).slice(0, 200)}`)
      if (errors.length) failures.push(`${c.label} had ${errors.length} console error(s): ${errors[0].text.slice(0, 200)}`)
    }
    if (before && after && before.hud === after.hud) failures.push('clientA HUD text was identical before and after firing, so no shot was observed to register')

    if (failures.length) {
      console.error(`[arena-combat] RESULT: FAIL -- ${failures.join('; ')}`)
      process.exit(1)
    }
    console.log(`[arena-combat] RESULT: PASS -- both clients reached ready (${a.readyMs}ms / ${b.readyMs}ms), ${SHOTS} shot(s) fired, 0 page errors, 0 console errors`)
    process.exit(0)
  } catch (e) {
    console.error('[arena-combat] run FAILED:', e.stack || e.message)
    if (browser) await browser.close().catch(() => {})
    if (server) server.stop()
    process.exit(1)
  }
}

main()
