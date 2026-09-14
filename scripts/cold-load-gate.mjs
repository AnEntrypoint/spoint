#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chromium } from './lib/cdp-browser.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const BASELINE_PATH = join(ROOT, '.cold-load-baseline.json')
const THRESHOLD = 1.25
const UPDATE = process.argv.includes('--update-baseline')
const PORT = process.env.PORT || '3098'
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
  process.env.SPOINT_NO_WATCH = '1'

  console.log(`[cold-load-gate] booting real server on port ${PORT} (world=e2e-ci-arena, prewarm+watchers skipped) ...`)
  const { boot } = await import('../src/sdk/server.js')
  const server = await boot()
  console.log('[cold-load-gate] server up.')

  let browser
  try {
    browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] })
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    const page = await ctx.newPage()
    const pageErrors = []
    page.on('pageerror', e => pageErrors.push(String(e)))

    const url = `http://localhost:${PORT}/?multiplayer&world=e2e-ci-arena`
    console.log(`[cold-load-gate] navigating (fresh context) to ${url} ...`)
    const t0 = Date.now()
    await page.goto(url, { waitUntil: 'domcontentloaded' })

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
