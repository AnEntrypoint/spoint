#!/usr/bin/env node
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, rmSync } from 'node:fs'
import { chromium } from './lib/cdp-browser.mjs'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 20000 + Math.floor(Math.random() * 20000)
const WORLD_NAME = 'agent-verify-tmp'

const argNames = process.argv.slice(2).filter(a => !a.startsWith('--'))
const KEEP = process.argv.includes('--keep')
const APPS = argNames.length > 0
  ? argNames
  : ['agent-simple-demo', 'agent-physics-demo', 'agent-interactive-demo', 'agent-spawner-demo', 'agent-fsm-demo']

const PASS = []
const FAIL = []
function check(label, cond, detail) {
  if (cond) { PASS.push(label); console.log(`  [PASS] ${label}`) }
  else { FAIL.push(label); console.log(`  [FAIL] ${label}${detail ? ' -- ' + detail : ''}`) }
}

async function waitForEval(page, fn, arg, { timeoutMs = 60000, intervalMs = 200, label = 'condition' } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = await page.evaluate(fn, arg).catch(() => undefined)
    if (v) return v
    await new Promise(r => setTimeout(r, intervalMs))
  }
  throw new Error(`timeout waiting for ${label} after ${timeoutMs}ms`)
}

async function main() {
  const entities = [{ id: 'floor', app: 'box-static', position: [0, -1, 0], config: { hx: 100, hy: 1, hz: 100 } }]
  APPS.forEach((app, i) => entities.push({ id: `verify-${app}`, app, position: [(i - (APPS.length - 1) / 2) * 4, 2, 0] }))
  const worldFile = join(SDK_ROOT, 'apps', 'world', `${WORLD_NAME}.js`)
  writeFileSync(worldFile,
    '// throwaway verify-app.mjs world -- safe to delete\nexport default ' +
    JSON.stringify({ port: PORT, tickRate: 60, gravity: [0, -9.81, 0], spawnPoint: [0, 5, 8], entities }, null, 2) + '\n')
  console.log(`[verify-app] wrote ${worldFile} with ${APPS.length} app entities: ${APPS.join(', ')}`)

  process.env.WORLD = WORLD_NAME
  process.env.PORT = String(PORT)
  process.env.SPOINT_SKIP_PREWARM = '1'
  process.env.SPOINT_NO_WATCH = '1'

  console.log(`[verify-app] booting real server on port ${PORT} (world=${WORLD_NAME})...`)
  const serverErrors = []
  const origConsoleError = console.error.bind(console)
  console.error = (...a) => { serverErrors.push(a.map(String).join(' ')); origConsoleError(...a) }
  const { boot } = await import('../src/sdk/server.js')
  const server = await boot()
  console.log('[verify-app] server up')

  const base = `http://localhost:${PORT}`
  let exitCode = 0
  let browser
  try {
    const appsResp = await fetch(`${base}/agent/apps`).then(r => r.json())
    for (const app of APPS) {
      check(`app '${app}' is registered server-side`, appsResp.ok && appsResp.apps.includes(app),
        `registered=[${(appsResp.apps || []).slice(0, 20).join(',')}]...`)
    }
    const entsResp = await fetch(`${base}/agent/entities`).then(r => r.json())
    const liveIds = new Set((entsResp.entities || []).map(e => e.id))
    for (const app of APPS) {
      check(`entity 'verify-${app}' is live in the world`, liveIds.has(`verify-${app}`),
        `live=[${Array.from(liveIds).slice(0, 20).join(',')}]`)
    }

    browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] })
    const context = await browser.newContext({ viewport: { width: 640, height: 480 } })
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', e => pageErrors.push(String(e)))
    await page._send('Page.addScriptToEvaluateOnNewDocument', { source:
      'window.__verifyConsoleErrors=[];(function(){var ce=console.error.bind(console);' +
      'console.error=function(){window.__verifyConsoleErrors.push(Array.from(arguments).map(String).join(" "));' +
      'ce.apply(null,arguments)}})();' +
      'window.addEventListener("error",function(e){window.__verifyConsoleErrors.push("uncaught: "+e.message)})' })
    const readConsoleErrors = () => page.evaluate(() => window.__verifyConsoleErrors || [])

    const url = `${base}/?multiplayer&world=${WORLD_NAME}`
    console.log(`[verify-app] navigating client to ${url}`)
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    const playerId = await waitForEval(page, () => window.__client?.connected && window.__client?.playerId, undefined, { label: 'client connect', timeoutMs: 120000 })
    check('headless client connected with a playerId', !!playerId, `playerId=${JSON.stringify(playerId)}`)

    await waitForEval(page, (want) => {
      const n = window.__client?.state
      const ents = n?.entities ? Object.keys(n.entities).length : (n?.entitiesArray?.length ?? 0)
      return ents >= want
    }, 1 + APPS.length, { label: 'entity streaming', timeoutMs: 30000 }).catch(() => console.warn('[verify-app] entity-count poll timed out; relying on server-side entity check'))
    const consoleErrors1 = await readConsoleErrors()
    const loadedClientApps = await page.evaluate(() =>
      window.debug?.appModules ? Array.from(window.debug.appModules.keys()) : null).catch(() => null)
    for (const app of APPS) {
      check(`client evaluated '${app}' client module`, Array.isArray(loadedClientApps) && loadedClientApps.includes(app),
        `loaded=[${(loadedClientApps || []).slice(0, 30).join(',')}]`)
    }
    check('zero uncaught page errors in the browser client', pageErrors.length === 0, JSON.stringify(pageErrors).slice(0, 2000))
    const attributable = (errs) => errs.filter(l => APPS.some(a => l.includes(a) || l.includes(`[app-eval] ${a}:`) || l.includes(`[app-setup] ${a} `)))
    check('zero console.error() calls attributable to the verified apps', attributable(consoleErrors1).length === 0, JSON.stringify(attributable(consoleErrors1)).slice(0, 2000))

    await page.keyboard.down('KeyW')
    await new Promise(r => setTimeout(r, 1500))
    await page.keyboard.up('KeyW')
    await new Promise(r => setTimeout(r, 1000))
    const consoleErrors2 = await readConsoleErrors()
    const ambient = consoleErrors2.length - attributable(consoleErrors2).length
    if (ambient > 0) console.log(`  [note] ${ambient} ambient console.error() from UNRELATED pre-existing shipped apps (not failing this gate): ${JSON.stringify([...new Set(consoleErrors2.filter(l => !attributable([l]).length).map(l => String(l).split(String.fromCharCode(10))[0].slice(0, 90)))])}`)
    check('zero uncaught page errors after input drive', pageErrors.length === 0, JSON.stringify(pageErrors).slice(0, 2000))
    check('zero console.error() calls attributable to the verified apps after input drive', attributable(consoleErrors2).length === 0, JSON.stringify(attributable(consoleErrors2)).slice(0, 2000))

    console.error = origConsoleError
    const realServerErrors = serverErrors.filter(l =>
      !l.startsWith('(node:') &&
      !l.includes('Use `node --trace-deprecation') &&
      !l.includes('[AppLoader] blocked pattern'))
    check('zero server-side console.error() across boot + drive', realServerErrors.length === 0,
      JSON.stringify(realServerErrors.slice(0, 10)).slice(0, 2000))

    await context.close()
  } catch (err) {
    console.error(`[verify-app] RESULT: FAIL (uncaught error)`)
    console.error(err?.stack || err)
    exitCode = 1
  } finally {
    if (browser) await browser.close().catch(() => {})
    try { server.stop?.() } catch {}
    if (!KEEP) rmSync(worldFile, { force: true })
  }

  console.log(`\n[verify-app] ${PASS.length} passed, ${FAIL.length} failed`)
  if (FAIL.length || exitCode) { console.log('[verify-app] RESULT: FAIL'); process.exit(1) }
  console.log('[verify-app] RESULT: PASS')
  process.exit(0)
}

main().catch(err => {
  console.error('[verify-app] RESULT: FAIL (uncaught error)')
  console.error(err?.stack || err)
  process.exit(1)
})
