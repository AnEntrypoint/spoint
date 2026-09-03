#!/usr/bin/env node
// e2e-ci.mjs -- real Playwright end-to-end CI gate for the playwright-e2e-plus-perf-gates-ci PRD row.
//
// Boots the REAL server (src/sdk/server.js boot(), the same path server.js/npm start uses) against a
// minimal, terrain-free arena (apps/world/e2e-ci-arena.js), then drives TWO real headless Chromium
// clients via Playwright against it -- the actual client/index.html page, the actual PhysicsNetworkClient
// WebSocket path (no ?singleplayer/?host: plain multiplayer join, see AGENTS.md
// one-server-two-client-modes-same-origin), the actual InputHandler keydown/keyup wiring. Not a
// jest/mocha/vitest harness and no unit-test/spec files are created -- this is a runnable operational
// script whose console PASS/FAIL output IS the live witness, matching the no-test-files-ever rule
// already followed by scripts/verify-session.mjs and scripts/replay-record-and-play.mjs.
//
// Assertions (read directly off real live client state via page.evaluate, nothing synthetic):
//  1. Both clients actually connect and receive a HANDSHAKE_ACK-derived playerId.
//  2. Each client's own live snapshot stream (client.state.players) sees the OTHER player join.
//  3. Driving real KeyW keydown on client A actually moves client A's predicted local position
//     (window.__net().predictionEnabled confirms prediction is live; position delta over time confirms
//     real physics ran, not a frozen/dead session).
//  4. Prediction/reconciliation invariants stay BOUNDED for the whole run: window.__net().divergence
//     (PredictionEngine.calculateDivergence(), the real local-vs-server divergence used to decide
//     correction) never exceeds a sane cap, and window.__net().errorOffset (ReconciliationEngine's
//     live smoothing-correction vector, see AGENTS.md reconciliation-smoothing-and-jitter-buffer-autotune)
//     stays finite and bounded too -- an unbounded/NaN value here is exactly the netcode failure mode
//     this gate exists to catch.
//  5. Client B (a stationary remote observer) sees client A's remote player position converge toward
//     client A's own predicted position within a real tolerance -- the actual cross-client agreement
//     invariant "prediction/reconciliation" means in a live two-peer session.
//  6. Screenshot-diff regression: each client's canvas is screenshotted after settle; compared byte-size
//     (non-trivial painted content, not a blank/black canvas) as a coarse regression signal, and the
//     PNG bytes are written to disk (data/e2e-ci/*.png) as the artifact a human/future run diffs visually
//     -- this script does not attempt fragile exact-pixel diffing across renderer/driver versions, only
//     "did it paint something non-degenerate," which is the CI-safe portion of visual regression.
//
// Usage: node scripts/e2e-ci.mjs

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

// Real KeyW hold via Playwright's actual keyboard input (not a synthetic DOM dispatchEvent) -- matches
// AGENTS.md's "real Playwright input, not synthetic DOM clicks" discipline for input-affecting checks.
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
  // Real bug found+fixed by this script: without this, the SDK/client file watcher can broadcast
  // MSG.HOT_RELOAD to a just-connected browser client (client/app.js's onHotReload does
  // location.reload()), reconnecting it mid-test and re-assigning it whatever PlayerManager.nextPlayerId
  // the server is on at that moment -- live-reproduced as BOTH clients reading back playerId=1. See the
  // SPOINT_NO_WATCH comment in src/sdk/ServerAPI.js for the full mechanism.
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

    // ?predict=1 opts this real session into the client-prediction+reconciliation code path (see
    // client/app.js's _predictParam) -- predictionEnabled defaults to false in this build otherwise, so
    // window.__net()'s predictionEnabled/divergence/errorOffset readouts would all be inert without it.
    // ?multiplayer is REQUIRED here: client/index.html's inline redirect-guard script sends any URL
    // lacking singleplayer/wwjoin/room/multiplayer straight to `?singleplayer&world=tps-game` before
    // app.js ever runs -- without it, both "two real WS clients" silently become two independent
    // in-Worker BrowserServer singleplayer sessions on the DEFAULT tps-game world, never actually
    // talking to this script's real server or to each other. Live-reproduced: without ?multiplayer, both
    // clients read back playerId=1 (each BrowserServer's own local counter) and predictionEnabled=false
    // (predict=1 lost in the redirect along with world=e2e-ci-arena), and client B's view of client A
    // never moved (two disjoint simulations, not one shared session).
    const url = `http://localhost:${PORT}/?multiplayer&world=e2e-ci-arena&predict=1`
    console.log(`[e2e-ci] navigating both clients to ${url}`)
    await Promise.all([
      pageA.goto(url, { waitUntil: 'domcontentloaded' }),
      pageB.goto(url, { waitUntil: 'domcontentloaded' }),
    ])

    console.log('[e2e-ci] waiting for both clients to connect + get a playerId...')
    // Generous timeout: a cold cache pays a real one-time GLBTransformer bake (e.g. anim-lib.glb, the
    // shared player-animation library every client needs before ASSETS_DONE) which can take 60s+ on an
    // uncached CI runner (live-measured 54s cold locally) -- see AGENTS.md content-hash-asset-cache
    // caveats for why this is a real, expected, one-time cost, not a bug this gate should flag.
    const CONNECT_TIMEOUT_MS = 120000
    const playerIdA = await waitFor(pageA, () => window.__client?.connected && window.__client?.playerId, { label: 'client A connect', timeoutMs: CONNECT_TIMEOUT_MS })
    const playerIdB = await waitFor(pageB, () => window.__client?.connected && window.__client?.playerId, { label: 'client B connect', timeoutMs: CONNECT_TIMEOUT_MS })
    check('client A connected with a playerId', !!playerIdA, `playerIdA=${JSON.stringify(playerIdA)}`)
    check('client B connected with a playerId', !!playerIdB, `playerIdB=${JSON.stringify(playerIdB)}`)
    check('client A and B got DIFFERENT playerIds', playerIdA !== playerIdB, `A=${playerIdA} B=${playerIdB}`)
    console.log(`[e2e-ci] playerIdA=${playerIdA} playerIdB=${playerIdB}`)

    console.log('[e2e-ci] waiting for each client to see the OTHER player in its own snapshot stream...')
    // waitFor's evaluate takes no args, so poll directly here with an explicit evaluate call that DOES
    // pass the other client's real id (a vacuous no-arg check would always compare against undefined).
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

    // Let both players finish falling from spawn and land on the floor before measuring horizontal
    // movement -- otherwise a still-falling player's dominant position delta is vertical (gravity), not
    // horizontal (the real forward-input signal this check cares about).
    console.log('[e2e-ci] waiting for client A to land (onGround) before measuring movement...')
    await waitFor(pageA, () => { const s = window.__client?.getLocalState?.(); return s?.onGround === true }, { label: 'client A onGround', timeoutMs: 10000 }).catch(() => console.warn('[e2e-ci] client A never reported onGround=true within 10s -- continuing anyway, the movement check below will surface any real problem'))

    // Real predicted-local-position baseline before driving any input.
    const localPosBefore = await pageA.evaluate(() => { const s = window.__client?.getLocalState?.(); return s?.position ? [...s.position] : null })
    check('client A has a finite predicted local position before input', Array.isArray(localPosBefore) && localPosBefore.every(Number.isFinite), JSON.stringify(localPosBefore))

    // Diagnostic snapshot for the e2e-flake-2026-08-15-investigation-note PRD row: a prior CI run saw
    // localPosBefore===localPosAfter bit-for-bit (movedDist=0.000m) with no other assertion failing --
    // this captures document.hasFocus()/document.activeElement/inputHandler's own live key-state and
    // input._vsync tick count around the KeyW hold so the NEXT flake occurrence's CI log actually shows
    // which of the untested hypotheses (lost focus, dead input loop, stalled physics tick) is real,
    // instead of the bare movedDist=0 this row was opened to explain.
    const diagBefore = await pageA.evaluate(() => ({
      hasFocus: document.hasFocus(), activeElementTag: document.activeElement?.tagName || null,
      vsyncFrame: window.__vsync?.frameCount ?? null, connected: window.__client?.connected ?? null,
    }))
    console.log(`[e2e-ci] diag before KeyW: ${JSON.stringify(diagBefore)}`)

    console.log('[e2e-ci] driving 2000ms of real KeyW input on client A...')
    await holdForward(pageA, 2000)
    await new Promise(r => setTimeout(r, 500)) // settle: let the last inputs round-trip + reconcile

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

    // -- Prediction/reconciliation invariants, sampled repeatedly across the run (not just once) --
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
    // Bounded, not zero: a real bug (runaway correction, feedback loop) shows up as unbounded growth,
    // not merely nonzero divergence (some divergence between predict and confirm ticks is expected/normal).
    const DIVERGENCE_CAP_M = 10
    check(`divergence stays under the ${DIVERGENCE_CAP_M}m sanity cap for every sample`, divergences.every(d => Math.abs(d) < DIVERGENCE_CAP_M), JSON.stringify(divergences))
    const errorOffsets = samples.map(s => s.errorOffset).filter(Boolean)
    check('errorOffset vectors are all finite (no NaN/Infinity reconciliation blowup)', errorOffsets.every(v => v.every(Number.isFinite)), JSON.stringify(errorOffsets))
    const ERROR_OFFSET_CAP_M = 10
    check(`errorOffset magnitude stays under ${ERROR_OFFSET_CAP_M}m for every sample`, errorOffsets.every(v => Math.hypot(...v) < ERROR_OFFSET_CAP_M), JSON.stringify(errorOffsets.map(v => Math.hypot(...v))))

    // -- Cross-client agreement: does client B's view of client A converge toward A's own position? --
    console.log('[e2e-ci] letting the session settle, then comparing cross-client position agreement...')
    // Poll rather than a single point-in-time read after one fixed delay: state.players is REPLACED
    // wholesale on each decoded snapshot (client/app.js's onStateUpdate), and reading it exactly between
    // two WS message-handler ticks is a real, benign race (live-observed: one run's single-shot read hit
    // a moment where client B's OWN in-flight state rebuild hadn't yet re-populated the array, returning
    // undefined for a still-very-much-connected remote player) -- not a netcode defect. The invariant
    // under test is "does B's view of A actually converge," which a bounded retry verifies properly
    // rather than asserting on an arbitrary single millisecond.
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
    // Generous tolerance -- B's snapshot-interpolated remote view legitimately lags A's own predicted
    // position by up to a couple of snapshot intervals; the invariant under test is "converges to the
    // same place," not "byte-identical every frame" (see AGENTS.md's replay-format 0.5m tolerance for a
    // similar same-process-determinism-vs-real-tick-jitter precedent).
    const CROSS_CLIENT_TOLERANCE_M = 5
    check(`client B's view of client A stays within ${CROSS_CLIENT_TOLERANCE_M}m of A's own position (cross-client agreement)`, crossClientDelta < CROSS_CLIENT_TOLERANCE_M, `delta=${crossClientDelta.toFixed(3)}m A=${JSON.stringify(aOwnFinalPos)} B-view-of-A=${JSON.stringify(bViewOfAPos)}`)

    // -- Screenshot / coarse visual-regression artifact --
    console.log('[e2e-ci] capturing screenshots (visual-regression artifact)...')
    const shotA = await pageA.screenshot()
    const shotB = await pageB.screenshot()
    await writeFile(join(OUT_DIR, 'client-a.png'), shotA)
    await writeFile(join(OUT_DIR, 'client-b.png'), shotB)
    // Coarse "painted something real" signal: a blank/black canvas PNG compresses to a tiny handful of
    // KB regardless of resolution; a rendered 3D scene does not. Not exact-pixel diffing (fragile across
    // GPU/driver/ANGLE backend versions in CI, see AGENTS.md debugging-playbook), but a real, cheap,
    // non-trivial-content regression signal that a full renderer crash/black-screen WILL fail.
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
