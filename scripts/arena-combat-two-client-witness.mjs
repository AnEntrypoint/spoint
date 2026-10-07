#!/usr/bin/env node
import { chromium } from './lib/cdp-browser.mjs'
import { gpuModeFlag, probeGpu, rasterizerClass, witnessGpu } from './lib/gpu-probe.mjs'
import { vendorLaunchArgs } from './lib/witness-gpu.mjs'

function flag(name, dflt = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}

function has(name) {
  return process.argv.includes(`--${name}`)
}

const PORT = flag('port', '3130')
const PROXY = flag('proxy', null)
const PARAMS = flag('params', '')
const GPU_MODE = gpuModeFlag()
const REQUIRE_ACCELERATED = has('require-accelerated')
const READY_TIMEOUT_MS = Number(flag('timeout', '180000'))
const SHOTS = Number(flag('shots', '10'))
const SETTLE_MS = Number(flag('settle', '4000'))
const PLAYABLE_TIMEOUT_MS = Number(flag('playable-timeout', '120000'))
const EXPECT_PLAYERS = flag('expect-players', null)
const SWEEP_PX = Number(flag('sweep', '0'))
const EXPECT_DAMAGE = has('expect-damage')
const PROBE = flag('probe', null)

const READY = 'window.__app && window.__app.loadingMachine && window.__app.loadingMachine.isReady'
const CANCELLED_REQUEST_ERROR_TEXTS = new Set(['net::ERR_ABORTED'])

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
  const cancelledRequests = []
  page.on('pageerror', e => pageErrors.push(String(e)))
  page.on('Runtime.consoleAPICalled', p => consoleEntries.push({ level: p?.type || 'unknown', text: textOf(p) }))
  page.on('Runtime.exceptionThrown', p => consoleEntries.push({ level: 'exception', text: p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || 'exception' }))
  await page.enableDomain('Network.enable')
  page.on('Network.loadingFailed', p => (CANCELLED_REQUEST_ERROR_TEXTS.has(p?.errorText) ? cancelledRequests : failedRequests).push({ url: p?.requestId || 'unknown-request', text: p?.errorText || 'failed' }))
  page.on('Network.responseReceived', p => {
    const status = p?.response?.status || 0
    if (status >= 400) failedRequests.push({ url: p?.response?.url, text: 'HTTP ' + status })
  })
  return { label, page, consoleEntries, pageErrors, failedRequests, cancelledRequests }
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
    const args = vendorLaunchArgs(GPU_MODE)
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

    const gpuMode = REQUIRE_ACCELERATED && GPU_MODE.software ? 'accelerated' : GPU_MODE
    const probed = await probeGpu(a.page).catch(() => null)
    const gpu = await witnessGpu(a.page, gpuMode).catch(e => ({ rasterizer: probed ? rasterizerClass(probed) : 'unmeasured', haystack: e.message, error: e }))
    console.log(`[arena-combat] rasterizer=${gpu.rasterizer} gpu=${gpu.haystack || 'none'} gpuMode=${GPU_MODE.mode} requireAccelerated=${REQUIRE_ACCELERATED}`)
    if (gpu.error) throw gpu.error

    const centreOf = (page) => page.evaluate(() => {
      const el = window.__app?.renderer?.domElement
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    }).catch(() => null)
    const hudText = (page) => page.evaluate('(document.body.innerText || "").slice(0, 400)').catch(() => '')
    const readHud = (c) => c.page.evaluate('(() => ({ lock: window.__app?.pointerLock || null, hud: (document.body.innerText || "").slice(0, 400) }))()').catch(() => null)
    const locked = (page) => page.evaluate('!!document.pointerLockElement || window.__app?.pointerLock?.state === "locked"').catch(() => false)
    const playersOf = (text) => {
      const m = /Players:\s*(\d+)/.exec(text || '')
      return m ? Number(m[1]) : null
    }

    const failures = []
    for (const c of [a, b]) c.centre = await centreOf(c.page)
    console.log(`[arena-combat] canvas centre A=${JSON.stringify(a.centre)} B=${JSON.stringify(b.centre)}`)

    const enterPlay = async (c) => {
      const t0 = Date.now()
      while (Date.now() - t0 < PLAYABLE_TIMEOUT_MS) {
        const hud = await hudText(c.page)
        const playable = hud.includes('Click to play') && !hud.includes('Building world') && !hud.includes('Starting game')
        if (playable && c.centre) {
          await c.page.mouse.click(c.centre.x, c.centre.y)
          await new Promise(r => setTimeout(r, 700))
          if (await locked(c.page)) return true
        }
        await new Promise(r => setTimeout(r, 500))
      }
      return false
    }

    const lockA = await enterPlay(a)
    const lockB = await enterPlay(b)
    console.log(`[arena-combat] pointer lock A=${lockA} B=${lockB}`)

    let playersNote = 'not-checked'
    if (EXPECT_PLAYERS !== null) {
      const want = Number(EXPECT_PLAYERS)
      const obs = {}
      for (const c of [a, b]) {
        const t0 = Date.now()
        let seen = null
        while (Date.now() - t0 < PLAYABLE_TIMEOUT_MS) {
          seen = playersOf(await hudText(c.page))
          if (seen !== null && seen >= want) break
          await new Promise(r => setTimeout(r, 500))
        }
        obs[c.label] = { seen, ms: Date.now() - t0 }
        if (seen === null || seen < want) failures.push(`${c.label} never observed Players >= ${want} (saw ${seen})`)
      }
      playersNote = `A=${obs.clientA.seen}@${obs.clientA.ms}ms B=${obs.clientB.seen}@${obs.clientB.ms}ms`
    }
    console.log(`[arena-combat] players ${playersNote}`)

    await new Promise(r => setTimeout(r, SETTLE_MS))
    const before = await readHud(a)
    const beforeB = await readHud(b)
    console.log(`[arena-combat] clientA before=${JSON.stringify(before)}`)
    console.log(`[arena-combat] clientB before=${JSON.stringify(beforeB)}`)

    const vitalsOf = (hud) => {
      const m = /(\d+)\/(\d+)\s*\n\s*(\d+)/.exec(hud || '')
      return m ? { ammo: Number(m[1]), mag: Number(m[2]), health: Number(m[3]) } : null
    }
    for (const c of [a, b]) c.vitals = []
    const sample = async () => {
      for (const c of [a, b]) {
        const v = vitalsOf(await hudText(c.page))
        if (v) c.vitals.push(v)
      }
    }

    let firedA = 0, firedB = 0
    for (let i = 0; i < SHOTS; i++) {
      for (const c of [a, b]) {
        if (!c.centre || !c.page) continue
        const dx = SWEEP_PX ? Math.round(((i % 5) - 2) * (SWEEP_PX / 2)) : 0
        await c.page.mouse.move(c.centre.x + dx, c.centre.y)
        await c.page.mouse.down()
        await new Promise(r => setTimeout(r, 120))
        await c.page.mouse.up()
        if (c === a) firedA++
        else firedB++
      }
      await sample()
      await new Promise(r => setTimeout(r, 250))
    }
    console.log(`[arena-combat] fired A=${firedA} B=${firedB} shot(s)`)

    for (const c of [a, b]) {
      const healths = c.vitals.map(v => v.health)
      const ammos = c.vitals.map(v => v.ammo)
      let respawns = 0
      for (let i = 1; i < healths.length; i++) if (healths[i - 1] < 100 && healths[i] >= 100) respawns++
      c.healthMin = healths.length ? Math.min(...healths) : null
      c.ammoMin = ammos.length ? Math.min(...ammos) : null
      c.respawns = respawns
      c.healthSeq = healths.filter((h, i) => i === 0 || h !== healths[i - 1]).join('>')
      console.log(`[arena-combat] ${c.label} healthMin=${c.healthMin} ammoMin=${c.ammoMin} respawns=${c.respawns} healthSeq=${c.healthSeq}`)
    }
    if (EXPECT_DAMAGE && (!a.healthMin || a.healthMin >= 100) && (!b.healthMin || b.healthMin >= 100)) failures.push(`neither client's health dropped below 100 across ${SHOTS} shot(s) each, so no cross-client hit registered`)

    await new Promise(r => setTimeout(r, SETTLE_MS))
    const after = await readHud(a)
    const afterB = await readHud(b)
    console.log(`[arena-combat] clientA after=${JSON.stringify(after)}`)
    console.log(`[arena-combat] clientB after=${JSON.stringify(afterB)}`)

    for (const c of [a, b]) {
      const alive = await c.page.evaluate('1 + 1').catch(e => 'evaluate-threw: ' + (e?.message || e))
      c.alive = alive === 2
      if (!c.alive) failures.push(`${c.label} did not answer an evaluate after the settle window (${String(alive)}), so this arm's observations are not from a live page`)
    }
    console.log(`[arena-combat] liveness A=${a.alive} B=${b.alive}`)

    if (PROBE) {
      for (const c of [a, b]) {
        const r = await c.page.evaluate(PROBE).catch(e => 'probe-error: ' + (e?.message || e))
        console.log(`[arena-combat] ${c.label} probe=${typeof r === 'string' ? r : JSON.stringify(r)}`)
      }
    }

    if (!lockA || !lockB) failures.push(`${!lockA && !lockB ? 'neither client' : !lockA ? 'clientA' : 'clientB'} never acquired pointer lock, so no shot could have reached the game from it`)

    await browser.close().catch(() => {})
    if (server) server.stop()

    for (const c of [a, b]) {
      const errors = c.consoleEntries.filter(e => e.level === 'error' || e.level === 'exception')
      console.log(`[arena-combat] ${c.label} consoleEntries=${c.consoleEntries.length} consoleErrors=${errors.length} pageErrors=${c.pageErrors.length} failedRequests=${c.failedRequests.length} cancelledRequests=${c.cancelledRequests.length}`)
      for (const e of errors.slice(0, 10)) console.log(`  [${c.label}][${e.level}] ${e.text.slice(0, 1200)}`)
      for (const e of c.pageErrors.slice(0, 10)) console.log(`  [${c.label}][pageerror] ${String(e).slice(0, 240)}`)
      for (const f of c.failedRequests.slice(0, 10)) console.log(`  [${c.label}][request] ${f.text} ${f.url}`)
      for (const f of c.cancelledRequests.slice(0, 10)) console.log(`  [${c.label}][request-cancelled] ${f.text} ${f.url}`)
      if (c.readyMs === null) failures.push(`${c.label} never reached world-ready`)
      if (c.pageErrors.length) failures.push(`${c.label} had ${c.pageErrors.length} uncaught page error(s): ${String(c.pageErrors[0]).slice(0, 200)}`)
      if (errors.length) failures.push(`${c.label} had ${errors.length} console error(s): ${errors[0].text.slice(0, 200)}`)
    }
    if (before && after && before.hud === after.hud) failures.push('clientA HUD text was identical before and after firing, so no shot was observed to register')
    if (beforeB && afterB && beforeB.hud === afterB.hud) failures.push('clientB HUD text was identical before and after firing, so no shot was observed to register')

    if (failures.length) {
      console.error(`[arena-combat] RESULT: FAIL -- ${failures.join('; ')}`)
      process.exit(1)
    }
    console.log(`[arena-combat] RESULT: PASS -- both clients reached ready (${a.readyMs}ms / ${b.readyMs}ms), pointer lock A=${lockA} B=${lockB}, ${firedA}/${firedB} shot(s) fired, players ${playersNote}, 0 page errors, 0 console errors`)
    process.exit(0)
  } catch (e) {
    console.error('[arena-combat] run FAILED:', e.stack || e.message)
    if (browser) await browser.close().catch(() => {})
    if (server) server.stop()
    process.exit(1)
  }
}

main()
