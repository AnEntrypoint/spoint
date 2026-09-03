#!/usr/bin/env node
// cold-load-gate.mjs -- repo-root cold-load-time regression gate (zero deps).
//
// Boots the REAL server (src/sdk/server.js boot(), the same path server.js/npm start uses)
// against the minimal terrain-free arena (apps/world/e2e-ci-arena.js, the same world
// scripts/e2e-ci.mjs already exercises) and drives ONE real headless Chromium client, in a
// FRESH Playwright browser CONTEXT (Playwright's own per-context cookie/localStorage/cache
// isolation -- the standard "cold cache" simulation this gate needs, no manual cache-clearing
// API required) against it via the real client/index.html page. Measures real wall-clock time
// from navigation start to client/core/LoadingMachine.js's real `isReady` terminal signal
// (window.__app.loadingMachine.isReady -- the same signal client/app.js's own
// `loadingMachine.subscribe` uses to call `_finishLoading()` and hide the loading screen), the
// actual "the game is playable" moment a real player experiences, not a proxy for it.
//
// Follows the same committed-JSON-baseline + threshold + --update-baseline pattern already
// proven by scripts/perf-gate.mjs / scripts/bundle-size-gate.mjs / packages/mapspinner's
// perf-gate.mjs -- deliberately not a different config format.
//
// Not a jest/mocha/vitest harness and no unit-test/spec files are created -- runnable
// operational script whose console PASS/FAIL output IS the live witness, matching the
// no-test-files-ever rule already followed by scripts/e2e-ci.mjs / scripts/perf-gate.mjs.
//
// Usage: node scripts/cold-load-gate.mjs [--update-baseline]
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chromium } from './lib/cdp-browser.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const BASELINE_PATH = join(ROOT, '.cold-load-baseline.json')
const THRESHOLD = 1.25
const UPDATE = process.argv.includes('--update-baseline')
// Fixed, unlikely-to-collide port -- overridable, but never the game's own default 3001 (this
// gate must not fight a real dev server already listening there). Distinct from perf-gate.mjs's
// 3097 and e2e-ci.mjs's random 20000-40000 range so all three can run concurrently in CI.
const PORT = process.env.PORT || '3098'
// Cold-cache asset transforms (e.g. anim-lib.glb, the shared player-animation library every
// real client needs before ASSETS_DONE) can take 60s+ on a genuinely uncached CI runner (see
// scripts/e2e-ci.mjs's own CONNECT_TIMEOUT_MS comment). Live-measured locally on a heavily
// CPU/disk-contended dev machine (many concurrent sibling worktree sessions running real
// servers+browsers simultaneously) the SAME cold bake cost 41s, 142s, then 295s across three
// consecutive runs as contention worsened -- this is real host-load variance, not a script bug
// (a dedicated CI runner would not see this). Sized generously above the worst observed local
// figure rather than tuned tight, since a false-positive timeout on CI-runner noise is worse
// than a slow-but-correct pass; the regression check below (vs a --update-baseline figure
// captured on a similarly-real machine) is the actual signal that matters, not this backstop.
const LOAD_TIMEOUT_MS = 480_000

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return null
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
}

function writeBaseline(data) {
  writeFileSync(BASELINE_PATH, JSON.stringify(data, null, 2) + '\n')
  console.log(`[cold-load-gate] baseline written: ${BASELINE_PATH}`)
  console.log(JSON.stringify(data, null, 2))
}

// GLBTransformer.js caches its transformed output on disk at client/.glb-cache/ (see
// CACHE_DIR_NAME), gitignored (**/.glb-cache/), so a real fresh CI checkout always starts with
// it absent -- a genuinely cold first-request bake (live-measured ~41s locally for anim-lib.glb,
// the shared player-animation library every client needs before ASSETS_DONE). A run-to-run local
// dev cycle would otherwise silently reuse a warm on-disk cache from a PRIOR run and measure a
// misleadingly fast few-second number that has nothing to do with real cold-CI-checkout cost --
// clearing it here before every measurement (update or gate) keeps the baseline honest and
// reproducible on any machine, matching what a real CI runner always experiences.
const GLB_CACHE_DIR = join(ROOT, 'client', '.glb-cache')
function clearGlbCache() {
  if (existsSync(GLB_CACHE_DIR)) {
    rmSync(GLB_CACHE_DIR, { recursive: true, force: true })
    console.log(`[cold-load-gate] cleared ${GLB_CACHE_DIR} (forcing a genuinely cold asset-transform bake)`)
  }
}

async function measureRealColdLoadMs() {
  clearGlbCache()
  process.env.WORLD = 'e2e-ci-arena'
  process.env.PORT = PORT
  process.env.SPOINT_SKIP_PREWARM = '1'
  // Same real bug this gate would otherwise re-trigger (see scripts/e2e-ci.mjs's own comment /
  // src/sdk/ServerAPI.js SPOINT_NO_WATCH): the file watcher can broadcast MSG.HOT_RELOAD to a
  // just-connected client mid-measurement, forcing a real location.reload() that would corrupt
  // the cold-load timing this gate measures.
  process.env.SPOINT_NO_WATCH = '1'

  console.log(`[cold-load-gate] booting real server on port ${PORT} (world=e2e-ci-arena, prewarm+watchers skipped) ...`)
  const { boot } = await import('../src/sdk/server.js')
  const server = await boot()
  console.log('[cold-load-gate] server up.')

  let browser
  try {
    browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] })
    // A brand-new context per Playwright's own isolation model has empty cookies/localStorage/
    // IndexedDB/HTTP-cache -- the real "first-ever visit" cold-cache simulation this gate needs,
    // no manual cache-clearing API required (Playwright never shares cache state across contexts).
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    const page = await ctx.newPage()
    const pageErrors = []
    page.on('pageerror', e => pageErrors.push(String(e)))

    // Same URL shape/reasoning as e2e-ci.mjs: ?multiplayer required (index.html's redirect guard
    // otherwise sends this to ?singleplayer&world=tps-game before app.js even runs).
    const url = `http://localhost:${PORT}/?multiplayer&world=e2e-ci-arena`
    console.log(`[cold-load-gate] navigating (fresh context) to ${url} ...`)
    const t0 = Date.now()
    await page.goto(url, { waitUntil: 'domcontentloaded' })

    // Poll the REAL live loadingMachine.isReady signal -- client/app.js:555's own
    // `loadingMachine.subscribe` calls `_finishLoading()` (hides the loading screen, the actual
    // "game is playable" moment) on exactly this condition, so this gate measures the same
    // event a real player experiences, not an approximation of it.
    const start = Date.now()
    let ready = false
    while (Date.now() - start < LOAD_TIMEOUT_MS) {
      ready = await page.evaluate(() => !!(window.__app && window.__app.loadingMachine && window.__app.loadingMachine.isReady)).catch(() => false)
      if (ready) break
      await new Promise(r => setTimeout(r, 100))
    }
    const coldLoadMs = Date.now() - t0

    if (!ready) throw new Error(`loadingMachine never reached isReady within ${LOAD_TIMEOUT_MS}ms -- real cold-load hang, not a timing regression`)
    if (pageErrors.length > 0) throw new Error(`page threw ${pageErrors.length} uncaught error(s) during cold load: ${pageErrors[0]}`)

    console.log(`[cold-load-gate] real cold load: navigation -> loadingMachine.isReady in ${coldLoadMs}ms`)
    return coldLoadMs
  } finally {
    if (browser) await browser.close()
    server.stop()
  }
}

async function main() {
  let ms
  try {
    ms = await measureRealColdLoadMs()
  } catch (e) {
    console.error('[cold-load-gate] real-browser measurement FAILED:\n', e.stack || e.message)
    process.exit(1)
  }

  if (UPDATE) {
    writeBaseline({ ms })
    console.log('[cold-load-gate] baseline updated. PASS')
    process.exit(0)
  }

  const baseline = readBaseline()
  if (!baseline) {
    console.error('[cold-load-gate] no baseline found. Run with --update-baseline to create one.')
    process.exit(1)
  }
  if (baseline.ms == null) {
    console.error('[cold-load-gate] baseline missing ms. Run with --update-baseline to refresh.')
    process.exit(1)
  }

  // Wider threshold than the bundle-size/tick-budget gates' +10%: a single cold-load sample is
  // real wall-clock CI-runner-dependent wall time (disk/network variance on a shared runner),
  // not a tightly-controlled in-process metric -- +25% catches a genuine regression (e.g. a new
  // blocking cold-cache fetch added to the boot path) without flapping on ordinary CI noise.
  const limit = baseline.ms * THRESHOLD
  console.log(`[cold-load-gate] baseline=${baseline.ms}ms limit=${limit.toFixed(0)}ms (+25%) measured=${ms}ms`)

  if (ms > limit) {
    console.error(`[cold-load-gate] REGRESSION: ${ms}ms > ${limit.toFixed(0)}ms (${((ms / baseline.ms - 1) * 100).toFixed(1)}% over baseline)`)
    process.exit(1)
  }

  console.log('[cold-load-gate] PASS')
  process.exit(0)
}

main()
