#!/usr/bin/env node
// Witness: tps-game reaches loadingMachine.isReady with species actually built.
//
// A species that failed to build used to shrink the landscape instead of refusing, so a boot with
// nothing in it looked healthy: placements counting, `meshes` short, no error. Commit 1e89f8c9 made
// the build refuse, species started building, and the boot stopped completing inside the budget a
// lane had been using -- which reads as a hang and is not one. It is the real cost of real work:
// the tier-node warm (`awaitTierNodeWarm`, client/core/Vegetation.js) compiles a TSL node graph per
// tier mesh per species, and on a software adapter that measures about 14 s a species over 45 of
// them.
//
// So this witness does not wait on `isReady` and call the outcome a verdict. It polls the loading
// machine's own state, every `boot:*` performance mark, the per-species measures and the vegetation
// instance count, and it reports the last mark the page reached: the mark that never appears names
// the hanging phase, and a bare "not-ready after N ms" distinguishes a slow boot from a stuck one.
//
// Its budget holds the work it measures. 540 s is not a guess: a real adapter reaches ready in about
// a minute, and the software adapter a lane may fall back to takes about ten, so a shorter budget
// reports its own timeout as a boot failure.
//
// The verdict is a number pair, never a boolean: the ready time, and the vegetation instance count
// that proves the species were really built rather than skipped.
import { chromium } from './lib/cdp-browser.mjs'
import { rebuildIfRequested } from './lib/served-client-root.mjs'
import { rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const TAG = '[veg-warm-drain]'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function flag(name, dflt = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const PORT = flag('port', '3139')
const WORLD = flag('world', 'tps-game')
const PARAMS = flag('params', 'singleplayer')
const BACKEND = flag('backend', 'webgpu')
const TIMEOUT_MS = Number(flag('timeout', '540000'))
const POLL_MS = Number(flag('poll', '2000'))
const OBSERVE_MS = Number(flag('observe', '3000'))

const say = (s) => console.log(`${TAG} ${s}`)

// One page-side read. It must not throw: a probe that throws reads as "not ready" and hides the
// phase it was meant to name.
const PROBE = `(() => {
  const W = window
  const app = W.__app || null
  const lm = app && app.loadingMachine ? app.loadingMachine : null
  let state = null
  if (lm) {
    try {
      const raw = lm.state !== undefined ? lm.state : (typeof lm.getState === 'function' ? lm.getState() : null)
      state = raw === null || raw === undefined ? null : (typeof raw === 'string' ? raw : (raw.value !== undefined ? raw.value : String(raw)))
    } catch (e) { state = 'unreadable:' + (e && e.message) }
  }
  const vegApi = W.__veg || W.__vegetation || null
  let vegInstances = null
  let vegMeshes = null
  if (vegApi) {
    if (typeof vegApi.totalInstances === 'number') vegInstances = vegApi.totalInstances
    const counts = []
    try {
      const meshes = vegApi._meshes
      const each = (m) => { if (m && typeof m.count === 'number') counts.push(m.count) }
      if (meshes && typeof meshes.forEach === 'function') meshes.forEach(each)
      else if (meshes && typeof meshes === 'object') for (const k of Object.keys(meshes)) each(meshes[k])
    } catch (e) { counts.length = 0 }
    if (vegInstances === null) vegInstances = counts.reduce((a, b) => a + b, 0)
    vegMeshes = counts.length
  }
  // The boot stamps its per-species phases as "measure" entries and its milestones as "mark"
  // entries; both are needed, because the phase that hangs is the one whose NEXT entry never
  // arrives, and the per-species measures are the only entries fine-grained enough to say which
  // species the boot was on.
  const marks = performance.getEntriesByType('mark').map((m) => ({ name: m.name, t: Math.round(m.startTime) }))
  const measures = performance.getEntriesByType('measure').map((m) => ({ name: m.name, t: Math.round(m.startTime), d: Math.round(m.duration) }))
  return {
    ready: !!(lm && lm.isReady),
    state: state,
    revealedAt: app && typeof app.revealedAt === 'number' ? Math.round(app.revealedAt) : null,
    vegInstances: vegInstances,
    vegMeshes: vegMeshes,
    renderer: W.__rendererInfo ? (W.__rendererInfo.renderer || W.__rendererInfo.glRenderer || null) : null,
    markCount: marks.length,
    marks: marks,
    measureCount: measures.length,
    lastMeasure: measures.length ? measures[measures.length - 1] : null,
  }
})()`

async function main() {
  // A fixed scratch dir has to be cleared at start or a previous run's profile is measured.
  rmSync(join(ROOT, '.gm', 'tmp', 'veg-warm-drain-profile'), { recursive: true, force: true })

  process.env.WORLD = process.env.WORLD || WORLD
  process.env.PORT = PORT
  process.env.SPOINT_NO_WATCH = '1'
  say(`booting real server on ${PORT} (world=${process.env.WORLD}) ...`)
  rebuildIfRequested('veg-warm-drain')
  const { boot } = await import(pathToFileURL(resolve(ROOT, 'src', 'sdk', 'server.js')).href)
  const server = await boot()

  let browser = null
  try {
    browser = await chromium.launch({})
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)))
    const query = BACKEND === 'webgpu' ? `${PARAMS}&webgpu=1` : PARAMS
    const url = `http://localhost:${PORT}/?${query}&world=${WORLD}&v=${Date.now()}`
    say(`navigating to ${url}`)
    await page.goto(url, { waitUntil: 'domcontentloaded' })

    const t0 = Date.now()
    let last = null
    const seenMarks = []
    const timeline = []
    let readyAtMs = null
    let readyState = null

    while (Date.now() - t0 < TIMEOUT_MS) {
      const p = await page.evaluate(PROBE).catch((e) => ({ error: 'probe failed: ' + e.message }))
      if (p && !p.error) {
        last = p
        for (let i = seenMarks.length; i < p.marks.length; i++) seenMarks.push(p.marks[i])
        timeline.push({
          atMs: Date.now() - t0, ready: p.ready, state: p.state,
          vegInstances: p.vegInstances, vegMeshes: p.vegMeshes,
          lastMark: p.marks.length ? p.marks[p.marks.length - 1].name : null,
        })
        if (p.ready && readyAtMs === null) { readyAtMs = Date.now() - t0; readyState = p.state; break }
      }
      await new Promise((r) => setTimeout(r, POLL_MS))
    }

    // A boot that reports ready must still be holding the species it built: read the counters again
    // after a short settle, because instances arrive through update() and not through the build.
    let settled = last
    if (readyAtMs !== null) {
      await new Promise((r) => setTimeout(r, OBSERVE_MS))
      const p = await page.evaluate(PROBE).catch(() => null)
      if (p && !p.error) settled = p
    }

    const lastMark = seenMarks.length ? seenMarks[seenMarks.length - 1] : null
    say(`readyAtMs=${readyAtMs === null ? 'NEVER' : readyAtMs} waitedMs=${Date.now() - t0} state=${JSON.stringify(readyState)}`)
    say(`lastMark=${JSON.stringify(lastMark)} markCount=${seenMarks.length}`)
    say(`lastMeasure=${JSON.stringify(settled ? settled.lastMeasure : null)} measureCount=${settled ? settled.measureCount : null}`)
    say(`vegInstances=${settled ? settled.vegInstances : null} vegMeshes=${settled ? settled.vegMeshes : null} renderer=${JSON.stringify(settled ? settled.renderer : null)}`)
    say(`pageErrors=${JSON.stringify(pageErrors.slice(0, 10))}`)
    if (readyAtMs === null) say(`TIMELINE ${JSON.stringify(timeline.filter((_, i) => i % 10 === 0 || i >= timeline.length - 12))}`)
    say(`MARKS ${JSON.stringify(seenMarks.slice(-30))}`)
    await browser.close().catch(() => {})

    // One expectation per measurement.
    const vegInstances = settled ? settled.vegInstances : null
    if (readyAtMs === null) {
      console.error(`${TAG} RESULT: FAIL label=veg-warm-drain -- loadingMachine never reached isReady within ${TIMEOUT_MS}ms; the hanging phase is after mark ${JSON.stringify(lastMark ? lastMark.name : null)}`)
      process.exit(1)
    }
    if (!(vegInstances > 0)) {
      console.error(`${TAG} RESULT: FAIL label=veg-warm-drain -- ready at ${readyAtMs}ms but vegInstances=${vegInstances}: the boot completed without building a species, which is the silent-empty-world it must not be`)
      process.exit(1)
    }
    say(`RESULT: PASS label=veg-warm-drain -- ready at ${readyAtMs}ms with vegInstances=${vegInstances} over ${settled.vegMeshes} mesh(es), renderer=${JSON.stringify(settled.renderer)}, last mark ${JSON.stringify(lastMark ? lastMark.name : null)}`)
    return 0
  } catch (e) {
    if (browser) await browser.close().catch(() => {})
    throw e
  } finally {
    // The in-process server goes with the process: this witness exits below, and stopping it here
    // would only risk a stop that never resolves on a shape boot() does not return.
    void server
  }
}

process.exit(await main().catch((e) => {
  console.error(`${TAG} RESULT: FAIL label=veg-warm-drain -- ${e && e.message ? e.message : String(e)}`)
  return 1
}))
