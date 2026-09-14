#!/usr/bin/env node
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from './lib/cdp-browser.mjs'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 20000 + Math.floor(Math.random() * 20000)
const OUT_DIR = resolve(SDK_ROOT, 'data', 'e2e-ci')

const PASS = []
const FAIL = []
function check(label, cond, detail) {
  if (cond) { PASS.push(label); console.log(`  [PASS] ${label}`) }
  else { FAIL.push(label); console.log(`  [FAIL] ${label}${detail ? ' -- ' + detail : ''}`) }
}

async function waitFor(page, fn, { timeoutMs = 15000, intervalMs = 200, label = 'condition' } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = await page.evaluate(fn).catch(() => undefined)
    if (v) return v
    await new Promise(r => setTimeout(r, intervalMs))
  }
  throw new Error(`timeout waiting for ${label} after ${timeoutMs}ms`)
}

async function holdForward(page, ms) {
  await page.keyboard.down('KeyW')
  await new Promise(r => setTimeout(r, ms))
  await page.keyboard.up('KeyW')
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true })

  process.env.WORLD = 'e2e-ci-arena'
  process.env.PORT = String(PORT)
  process.env.SPOINT_SKIP_PREWARM = '1'
  process.env.SPOINT_NO_WATCH = '1'
  console.log(`[e2e-ci] booting real server on port ${PORT} (world=e2e-ci-arena, prewarm+watchers skipped)...`)
  const { boot } = await import('../src/sdk/server.js')
  const server = await boot()
  console.log(`[e2e-ci] server up.`)

  let browser
  try {
    browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] })
    const ctxA = await browser.newContext({ viewport: { width: 640, height: 480 } })
    const ctxB = await browser.newContext({ viewport: { width: 640, height: 480 } })
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    const consoleErrors = { A: [], B: [] }
    pageA.on('pageerror', e => consoleErrors.A.push(String(e)))
    pageB.on('pageerror', e => consoleErrors.B.push(String(e)))

    const url = `http://localhost:${PORT}/?multiplayer&world=e2e-ci-arena&predict=1`
    console.log(`[e2e-ci] navigating both clients to ${url}`)
    await Promise.all([
      pageA.goto(url, { waitUntil: 'domcontentloaded' }),
      pageB.goto(url, { waitUntil: 'domcontentloaded' }),
    ])

    console.log('[e2e-ci] waiting for both clients to connect + get a playerId...')
    const CONNECT_TIMEOUT_MS = 120000
    const playerIdA = await waitFor(pageA, () => window.__client?.connected && window.__client?.playerId, { label: 'client A connect', timeoutMs: CONNECT_TIMEOUT_MS })
    const playerIdB = await waitFor(pageB, () => window.__client?.connected && window.__client?.playerId, { label: 'client B connect', timeoutMs: CONNECT_TIMEOUT_MS })
    check('client A connected with a playerId', !!playerIdA, `playerIdA=${JSON.stringify(playerIdA)}`)
    check('client B connected with a playerId', !!playerIdB, `playerIdB=${JSON.stringify(playerIdB)}`)
    check('client A and B got DIFFERENT playerIds', playerIdA !== playerIdB, `A=${playerIdA} B=${playerIdB}`)
    console.log(`[e2e-ci] playerIdA=${playerIdA} playerIdB=${playerIdB}`)

    console.log('[e2e-ci] waiting for each client to see the OTHER player in its own snapshot stream...')
    async function waitForOtherPlayer(page, otherId, label) {
      const start = Date.now()
      while (Date.now() - start < 20000) {
        const seen = await page.evaluate((id) => window.__client?.state?.players?.some(p => p.id === id), otherId).catch(() => false)
        if (seen) return true
        await new Promise(r => setTimeout(r, 200))
      }
      console.warn(`[e2e-ci] timed out waiting for ${label}`)
      return false
    }
    const aSeesB = await waitForOtherPlayer(pageA, playerIdB, 'A to see B')
    const bSeesA = await waitForOtherPlayer(pageB, playerIdA, 'B to see A')
    check('client A sees client B in its live snapshot state', !!aSeesB)
    check('client B sees client A in its live snapshot state', !!bSeesA)

    console.log('[e2e-ci] waiting for client A to land (onGround) before measuring movement...')
    await waitFor(pageA, () => { const s = window.__client?.getLocalState?.(); return s?.onGround === true }, { label: 'client A onGround', timeoutMs: 10000 }).catch(() => console.warn('[e2e-ci] client A never reported onGround=true within 10s -- continuing anyway, the movement check below will surface any real problem'))

    const localPosBefore = await pageA.evaluate(() => { const s = window.__client?.getLocalState?.(); return s?.position ? [...s.position] : null })
    check('client A has a finite predicted local position before input', Array.isArray(localPosBefore) && localPosBefore.every(Number.isFinite), JSON.stringify(localPosBefore))

    const diagBefore = await pageA.evaluate(() => ({
      hasFocus: document.hasFocus(), activeElementTag: document.activeElement?.tagName || null,
      vsyncFrame: window.__vsync?.frameCount ?? null, connected: window.__client?.connected ?? null,
    }))
    console.log(`[e2e-ci] diag before KeyW: ${JSON.stringify(diagBefore)}`)

    console.log('[e2e-ci] driving 2000ms of real KeyW input on client A...')
    await holdForward(pageA, 2000)
    const INPUT_RECONCILE_SETTLE_MS = 500
    await new Promise(r => setTimeout(r, INPUT_RECONCILE_SETTLE_MS))

    const diagAfter = await pageA.evaluate(() => ({
      hasFocus: document.hasFocus(), activeElementTag: document.activeElement?.tagName || null,
      vsyncFrame: window.__vsync?.frameCount ?? null, connected: window.__client?.connected ?? null,
    }))
    console.log(`[e2e-ci] diag after KeyW: ${JSON.stringify(diagAfter)}`)

    const localPosAfter = await pageA.evaluate(() => { const s = window.__client?.getLocalState?.(); return s?.position ? [...s.position] : null })
    check('client A has a finite predicted local position after input', Array.isArray(localPosAfter) && localPosAfter.every(Number.isFinite), JSON.stringify(localPosAfter))
    const movedDist = (localPosBefore && localPosAfter)
      ? Math.hypot(localPosAfter[0] - localPosBefore[0], localPosAfter[2] - localPosBefore[2])
      : 0
    check('client A actually moved from real forward input (prediction + physics are live)', movedDist > 0.5, `movedDist=${movedDist.toFixed(3)}m before=${JSON.stringify(localPosBefore)} after=${JSON.stringify(localPosAfter)} diagBefore=${JSON.stringify(diagBefore)} diagAfter=${JSON.stringify(diagAfter)}`)

    console.log('[e2e-ci] sampling window.__net() prediction/reconciliation invariants across the run...')
    const samples = []
    for (let i = 0; i < 10; i++) {
      await holdForward(pageA, 150)
      const net = await pageA.evaluate(() => window.__net ? window.__net() : null)
      if (net) samples.push(net)
      await new Promise(r => setTimeout(r, 50))
    }
    check('captured at least one window.__net() sample', samples.length > 0, `samples=${samples.length}`)
    check('prediction was enabled for the whole sampled run', samples.every(s => s.predictionEnabled === true), JSON.stringify(samples.map(s => s.predictionEnabled)))
    const divergences = samples.map(s => s.divergence).filter(d => typeof d === 'number')
    check('divergence samples are all finite numbers', divergences.length === samples.length && divergences.every(Number.isFinite), JSON.stringify(divergences))
    const DIVERGENCE_CAP_M = 10
    check(`divergence stays under the ${DIVERGENCE_CAP_M}m sanity cap for every sample`, divergences.every(d => Math.abs(d) < DIVERGENCE_CAP_M), JSON.stringify(divergences))
    const errorOffsets = samples.map(s => s.errorOffset).filter(Boolean)
    check('errorOffset vectors are all finite (no NaN/Infinity reconciliation blowup)', errorOffsets.every(v => v.every(Number.isFinite)), JSON.stringify(errorOffsets))
    const ERROR_OFFSET_CAP_M = 10
    check(`errorOffset magnitude stays under ${ERROR_OFFSET_CAP_M}m for every sample`, errorOffsets.every(v => Math.hypot(...v) < ERROR_OFFSET_CAP_M), JSON.stringify(errorOffsets.map(v => Math.hypot(...v))))

    console.log('[e2e-ci] letting the session settle, then comparing cross-client position agreement...')
    let aOwnFinalPos = null, bViewOfAPos = null
    for (let i = 0; i < 10; i++) {
      aOwnFinalPos = await pageA.evaluate(() => { const s = window.__client?.getLocalState?.(); return s?.position ? [...s.position] : null })
      bViewOfAPos = await pageB.evaluate((aId) => { const p = window.__client?.state?.players?.find(p => p.id === aId); return p?.position ? [...p.position] : null }, playerIdA)
      if (bViewOfAPos) break
      await new Promise(r => setTimeout(r, 300))
    }
    check('client B has a live remote-player record for client A with a finite position', Array.isArray(bViewOfAPos) && bViewOfAPos.every(Number.isFinite), JSON.stringify(bViewOfAPos))
    const crossClientDelta = (aOwnFinalPos && bViewOfAPos)
      ? Math.hypot(aOwnFinalPos[0] - bViewOfAPos[0], aOwnFinalPos[1] - bViewOfAPos[1], aOwnFinalPos[2] - bViewOfAPos[2])
      : Infinity
    const CROSS_CLIENT_TOLERANCE_M = 5
    check(`client B's view of client A stays within ${CROSS_CLIENT_TOLERANCE_M}m of A's own position (cross-client agreement)`, crossClientDelta < CROSS_CLIENT_TOLERANCE_M, `delta=${crossClientDelta.toFixed(3)}m A=${JSON.stringify(aOwnFinalPos)} B-view-of-A=${JSON.stringify(bViewOfAPos)}`)

    console.log('[e2e-ci] capturing screenshots (visual-regression artifact)...')
    const shotA = await pageA.screenshot()
    const shotB = await pageB.screenshot()
    await writeFile(join(OUT_DIR, 'client-a.png'), shotA)
    await writeFile(join(OUT_DIR, 'client-b.png'), shotB)
    const MIN_SCREENSHOT_BYTES = 5000
    check(`client A screenshot is non-trivial (>${MIN_SCREENSHOT_BYTES}B, not a blank canvas)`, shotA.length > MIN_SCREENSHOT_BYTES, `${shotA.length}B`)
    check(`client B screenshot is non-trivial (>${MIN_SCREENSHOT_BYTES}B, not a blank canvas)`, shotB.length > MIN_SCREENSHOT_BYTES, `${shotB.length}B`)
    console.log(`[e2e-ci] screenshots written to ${OUT_DIR}`)

    check('zero uncaught page errors on client A', consoleErrors.A.length === 0, JSON.stringify(consoleErrors.A))
    check('zero uncaught page errors on client B', consoleErrors.B.length === 0, JSON.stringify(consoleErrors.B))

    await ctxA.close()
    await ctxB.close()
  } finally {
    if (browser) await browser.close()
    server.stop()
  }

  console.log(`\n[e2e-ci] ${PASS.length} passed, ${FAIL.length} failed`)
  if (FAIL.length) {
    console.log('[e2e-ci] RESULT: FAIL')
    process.exitCode = 1
  } else {
    console.log('[e2e-ci] RESULT: PASS')
    process.exitCode = 0
  }
}

main().catch(err => {
  console.error('[e2e-ci] RESULT: FAIL (uncaught error)')
  console.error(err?.stack || err)
  process.exitCode = 1
})
