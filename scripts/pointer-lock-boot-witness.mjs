#!/usr/bin/env node
import { chromium } from './lib/cdp-browser.mjs'

const PORT = process.env.PORT || '3117'
const OBSERVE_MS = Number(process.env.OBSERVE_MS || 60000)
const LOAD_TIMEOUT_MS = Number(process.env.LOAD_TIMEOUT_MS || 300000)
const POINTER_LOCK_RE = /pointer\s*lock|pointerLock/i

function textOf(entry) {
  const args = entry?.args || []
  return args.map(a => a?.description || (a?.value === undefined ? '' : String(a.value))).join(' ')
}

async function main() {
  process.env.WORLD = process.env.WORLD || 'tps-game'
  process.env.PORT = PORT
  process.env.SPOINT_NO_WATCH = '1'
  console.log(`[pointer-lock-witness] booting real server on port ${PORT} (world=${process.env.WORLD}) ...`)
  const { boot } = await import('../src/sdk/server.js')
  const server = await boot()
  console.log('[pointer-lock-witness] server up.')

  let browser
  let lockAfterClick = null
  let stateAfterClick = null
  let observedMs = 0
  try {
    browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] })
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    const consoleEvents = []
    const pageErrors = []
    page.on('pageerror', e => pageErrors.push(String(e)))
    page.on('Runtime.consoleAPICalled', p => consoleEvents.push({ level: p?.type || 'unknown', text: textOf(p) }))
    page.on('Runtime.exceptionThrown', p => consoleEvents.push({ level: 'exception', text: p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || 'exception' }))
    page.on('Log.entryAdded', p => consoleEvents.push({ level: p?.entry?.level || 'log', text: p?.entry?.text || '' }))
    await page.enableDomain('Log.enable')

    const url = `http://localhost:${PORT}/?singleplayer&world=${process.env.WORLD}`
    console.log(`[pointer-lock-witness] navigating to ${url} ...`)
    await page.goto(url, { waitUntil: 'domcontentloaded' })

    const start = Date.now()
    let ready = false
    while (Date.now() - start < LOAD_TIMEOUT_MS) {
      ready = await page.evaluate(() => !!(window.__app && window.__app.loadingMachine && window.__app.loadingMachine.isReady)).catch(() => false)
      if (ready) break
      await new Promise(r => setTimeout(r, 200))
    }
    console.log(`[pointer-lock-witness] loadingMachine.isReady=${ready}`)

    const remaining = OBSERVE_MS - (Date.now() - start)
    if (remaining > 0) {
      observedMs = remaining
      console.log(`[pointer-lock-witness] observing console for ${Math.round(remaining)}ms ...`)
      await page.waitForTimeout(remaining)
    }

    const pointerEvents = consoleEvents.filter(e => POINTER_LOCK_RE.test(e.text))
    console.log(`[pointer-lock-witness] console events=${consoleEvents.length} pointer-lock events=${pointerEvents.length}`)
    for (const e of pointerEvents) console.log(`  [${e.level}] ${e.text.slice(0, 300)}`)

    console.log('[pointer-lock-witness] clicking canvas centre ...')
    await page._send('Page.bringToFront').catch(() => {})
    const centre = await page.evaluate(() => {
      const el = window.__app?.renderer?.domElement
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })
    if (centre) {
      await page.mouse.click(centre.x, centre.y)
      await page.waitForTimeout(2000)
      const after = await page.evaluate(() => ({
        locked: !!document.pointerLockElement && document.pointerLockElement === (window.__app?.renderer?.domElement || null),
        state: window.__app?.pointerLock || null,
      }))
      lockAfterClick = after.locked
      stateAfterClick = after.state
    }
    console.log(`[pointer-lock-witness] lockAfterClick=${JSON.stringify(lockAfterClick)} pointerLockState=${JSON.stringify(stateAfterClick)}`)
    if (pageErrors.length) console.log(`[pointer-lock-witness] page errors: ${pageErrors.length} -- ${String(pageErrors[0]).slice(0, 300)}`)

    await browser.close().catch(() => {})
    server.stop()

    const failures = []
    if (pointerEvents.length) failures.push(`${pointerEvents.length} pointer-lock console event(s): ${pointerEvents[0].text.slice(0, 200)}`)
    if (!lockAfterClick) failures.push(`clicking the canvas did not lock the pointer (state=${JSON.stringify(stateAfterClick)})`)
    if (failures.length) {
      console.error(`[pointer-lock-witness] RESULT: FAIL -- ${failures.join('; ')}`)
      process.exit(1)
    }
    console.log(`[pointer-lock-witness] RESULT: PASS -- zero pointer-lock console events over ${Math.round(OBSERVE_MS)}ms (observed ${Math.round(observedMs)}ms), click locked the pointer (state=${JSON.stringify(stateAfterClick)})`)
    process.exit(0)
  } catch (e) {
    console.error('[pointer-lock-witness] run FAILED:', e.stack || e.message)
    if (browser) await browser.close().catch(() => {})
    server.stop()
    process.exit(1)
  }
}

main()
