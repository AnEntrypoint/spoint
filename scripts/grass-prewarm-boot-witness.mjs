#!/usr/bin/env node
import { chromium } from './lib/cdp-browser.mjs'
import { vendorLaunchArgs } from './lib/witness-gpu.mjs'
import { witnessGpu } from './lib/gpu-probe.mjs'
import {
  assertServedClientRoot, clientRootTag, rebuildClientBundle, CLIENT_ROOT_BUNDLE, CLIENT_ROOT_RAW,
} from './lib/served-client-root.mjs'
import { unreachedReasons } from './lib/witness-reachability.mjs'

const LABEL = 'grass-prewarm-boot-witness'

function flag(name, dflt = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}

const PORT = flag('port', '3137')
const PARAMS = flag('params', 'singleplayer')
const WORLD = flag('world', 'tps-game')
const GPU_VENDOR = flag('gpu', null)
const REPS = Math.max(1, Number(flag('reps', '3')) | 0)
const TIMEOUT_MS = Number(flag('timeout', '240000'))
const MAX_PLAYABLE_MS = Number(flag('max-playable-ms', '0')) || null
const MAX_PREWARM_MS = Number(flag('max-prewarm-ms', '0')) || null
const MAX_GRASS_WAIT_MS = Number(flag('max-grass-wait-ms', '1500'))
const MIN_GRASS_INSTANCES = Number(flag('min-grass-instances', '0')) || null
const SETTLE_MS = Number(flag('settle', '0'))

const PLAYABLE_EXPR = "window.__app && window.__app.revealedAt != null"

const PROBE = `(() => {
  const g = window.__grass, r = window.__rocks, v = window.__veg
  const marks = {}
  for (const m of performance.getEntriesByType('mark')) marks[m.name] = Math.round(m.startTime)
  const snap = (api) => api ? { totalInstances: api.totalInstances, profile: { ...api.profile } } : null
  return {
    revealedAt: (window.__app && window.__app.revealedAt) || null,
    marks,
    grass: snap(g),
    rocks: snap(r),
    veg: snap(v),
  }
})()`

const SERVED_ENTRY = `(async () => {
  const res = await fetch('/app.js', { cache: 'no-store' })
  const text = await res.text()
  return { status: res.status, bytes: text.length, hasPrewarmWorkMs: text.includes('prewarmWorkMs'), hasYieldFrame: text.includes('_yieldFrame') }
})()`

function stageMs(marks) {
  if (!marks) return null
  const built = marks['boot:foliage-built']
  const prewarmed = marks['boot:foliage-prewarmed']
  if (!Number.isFinite(built) || !Number.isFinite(prewarmed)) return null
  return prewarmed - built
}

function median(xs) {
  const sorted = xs.filter(Number.isFinite).slice().sort((a, b) => a - b)
  if (!sorted.length) return null
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const fail = (msg) => { console.error(`[${LABEL}] RESULT: FAIL -- ${msg}`); process.exit(1) }

async function main() {
  process.env.WORLD = process.env.WORLD || WORLD
  process.env.PORT = PORT
  process.env.SPOINT_NO_WATCH = '1'

  if (process.argv.includes('--rebuild-bundle')) {
    console.log(`[${LABEL}] --rebuild-bundle: running scripts/bundle-client.mjs before boot ...`)
    rebuildClientBundle()
  }
  console.log(`[${LABEL}] booting real server on port ${PORT} (world=${process.env.WORLD}) ...`)
  const { boot } = await import('../src/sdk/server.js')
  const server = await boot()
  const base = `http://${'127.0.0.1'}:${PORT}`
  console.log(`[${LABEL}] server up at ${base}`)

  let browser = null
  try {
    const args = GPU_VENDOR ? vendorLaunchArgs({ mode: GPU_VENDOR }) : vendorLaunchArgs({ mode: 'accelerated' })
    browser = await chromium.launch({ headless: true, args })
    const runs = []
    let servedRoot = null
    let servedGrass = null

    for (let i = 0; i < REPS; i++) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
      const pageErrors = []
      page.on('pageerror', e => pageErrors.push(String(e)))
      await page.goto(`${base}/?${PARAMS}`, { waitUntil: 'domcontentloaded' })

      const want = process.argv.includes('--require-raw-esm') ? CLIENT_ROOT_RAW : CLIENT_ROOT_BUNDLE
      const root = await assertServedClientRoot(page, { want, label: LABEL }).catch(e => e)
      if (root instanceof Error) fail(root.message)
      servedRoot = root
      servedGrass = await page.evaluate(SERVED_ENTRY).catch(e => ({ status: 0, bytes: 0, error: e.message }))

      const gpu = await witnessGpu(page, GPU_VENDOR || 'accelerated')
      const t0 = Date.now()
      let reached = false
      while (Date.now() - t0 < TIMEOUT_MS) {
        reached = await page.evaluate(`!!(${PLAYABLE_EXPR})`).catch(() => false)
        if (reached) break
        await new Promise(r => setTimeout(r, 200))
      }
      if (!reached) fail(`rep ${i}: the page never became playable within ${TIMEOUT_MS}ms -- ${PLAYABLE_EXPR} stayed false (pageErrors=${pageErrors.length}${pageErrors[0] ? ': ' + pageErrors[0].slice(0, 200) : ''})`)
      if (SETTLE_MS > 0) await page.waitForTimeout(SETTLE_MS)

      const probe = await page.evaluate(PROBE)
      runs.push({ ...probe, gpu: gpu.renderer || gpu.adapter || null, pageErrors })
      console.log(`[${LABEL}] rep ${i}: playableAt=${Math.round(probe.revealedAt)}ms prewarmStage=${stageMs(probe.marks)}ms ` +
        `grassChunks=${probe.grass?.profile?.prewarmChunks ?? 'n/a'} grassWorkMs=${probe.grass?.profile?.prewarmWorkMs ?? 'n/a'} grassPrewarmMs=${probe.grass?.profile?.prewarmMs ?? 'n/a'} ` +
        `grassInstances=${probe.grass?.totalInstances ?? 'n/a'}`)
      await page.close().catch(() => {})
    }

    await browser.close().catch(() => {})
    browser = null
    server.stop()

    const playable = runs.map(r => r.revealedAt).filter(v => Number.isFinite(v))
    const stages = runs.map(r => stageMs(r.marks)).filter(v => Number.isFinite(v))
    const grassWait = runs.map(r => {
      const p = r.grass && r.grass.profile
      if (!p || !Number.isFinite(p.prewarmMs) || !Number.isFinite(p.prewarmWorkMs)) return null
      return p.prewarmMs - p.prewarmWorkMs
    })
    const out = {
      arm: flag('arm', 'unlabelled'),
      reps: runs.length,
      clientRoot: servedRoot ? clientRootTag(servedRoot) : null,
      servedGrass,
      gpu: runs[0]?.gpu ?? null,
      bootToPlayableMs: playable.map(v => Math.round(v)),
      bootToPlayableMedianMs: median(playable),
      prewarmStageMs: stages,
      prewarmStageMedianMs: median(stages),
      grassPrewarmMs: runs.map(r => r.grass?.profile?.prewarmMs ?? null),
      grassWorkMs: runs.map(r => r.grass?.profile?.prewarmWorkMs ?? null),
      grassChunks: runs.map(r => r.grass?.profile?.prewarmChunks ?? null),
      grassWaitMs: grassWait.map(v => (v === null ? null : Math.round(v))),
      grassInstances: runs.map(r => r.grass?.totalInstances ?? null),
      rocksChunks: runs.map(r => r.rocks?.profile?.prewarmChunks ?? null),
      rocksWorkMs: runs.map(r => r.rocks?.profile?.prewarmWorkMs ?? null),
      rocksPrewarmMs: runs.map(r => r.rocks?.profile?.prewarmMs ?? null),
      rocksWaitMs: runs.map(r => (r.rocks?.profile ? Math.round((r.rocks.profile.prewarmMs ?? 0) - (r.rocks.profile.prewarmWorkMs ?? 0)) : null)),
      vegChunks: runs.map(r => r.veg?.profile?.prewarmChunks ?? null),
      vegWorkMs: runs.map(r => r.veg?.profile?.prewarmWorkMs ?? null),
      vegWaitMs: runs.map(r => (r.veg?.profile ? Math.round((r.veg.profile.prewarmMs ?? 0) - (r.veg.profile.prewarmWorkMs ?? 0)) : null)),
    }
    console.log(`[${LABEL}] measurements ${JSON.stringify(out)}`)

    const failures = []
    const unreached = unreachedReasons({
      marks: Object.keys(runs[0]?.marks || {}),
      requiredMarks: ['boot:foliage-built', 'boot:foliage-prewarmed'],
      counts: { [PLAYABLE_EXPR]: runs.length },
      requiredCounts: [],
    })
    if (unreached.length) failures.push(unreached.join('; '))

    const waitMeasured = grassWait.filter(v => v !== null)
    if (waitMeasured.length !== runs.length) {
      failures.push(`grass profile does not report both prewarmMs and prewarmWorkMs in ${runs.length - waitMeasured.length}/${runs.length} rep(s) -- the grass prewarm budget is not auditable as work, so wall-clock waiting cannot be shown to be excluded from it`)
    } else {
      const worstWait = Math.max(...waitMeasured)
      if (worstWait > MAX_GRASS_WAIT_MS) failures.push(`grass prewarm spent ${Math.round(worstWait)}ms waiting inside its own budget (ceiling ${MAX_GRASS_WAIT_MS}ms) -- the budget is still charging wall-clock, not work`)
    }
    if (MAX_PLAYABLE_MS !== null && out.bootToPlayableMedianMs > MAX_PLAYABLE_MS) {
      failures.push(`median boot-to-playable ${out.bootToPlayableMedianMs}ms exceeds ceiling ${MAX_PLAYABLE_MS}ms`)
    }
    if (MAX_PREWARM_MS !== null && out.prewarmStageMedianMs > MAX_PREWARM_MS) {
      failures.push(`median prewarm stage ${out.prewarmStageMedianMs}ms exceeds ceiling ${MAX_PREWARM_MS}ms`)
    }
    if (MIN_GRASS_INSTANCES !== null) {
      const minSeen = Math.min(...out.grassInstances.filter(v => Number.isFinite(v)))
      if (!(minSeen >= MIN_GRASS_INSTANCES)) failures.push(`grass instances fell to ${minSeen}, below the ${MIN_GRASS_INSTANCES} floor -- prewarm starved grass`)
    }
    const errs = runs.reduce((n, r) => n + (r.pageErrors?.length || 0), 0)
    if (errs) failures.push(`the page threw ${errs} uncaught error(s): ${runs.find(r => r.pageErrors?.length)?.pageErrors[0].slice(0, 200)}`)

    if (failures.length) fail(failures.join('; '))
    console.log(`[${LABEL}] RESULT: PASS -- bootToPlayableMedianMs=${out.bootToPlayableMedianMs} prewarmStageMedianMs=${out.prewarmStageMedianMs} grassWaitMs=${JSON.stringify(out.grassWaitMs)}`)
    process.exit(0)
  } catch (e) {
    console.error(`[${LABEL}] run FAILED:`, e.stack || e.message)
    if (browser) await browser.close().catch(() => {})
    server.stop()
    process.exit(1)
  }
}

main()
