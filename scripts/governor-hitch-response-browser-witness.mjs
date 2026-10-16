#!/usr/bin/env node
// Deferred arm of PERF-governor-hitch-response-r1: the synthetic-load-spike measurement on the real
// GPU path. Deliberately NOT registered in scripts/check.mjs -- it reaches the browser surface, so
// it must ride behind SPOINT_GPU_WITNESS, not the gpu-free arm. Run it under scripts/gpulock.mjs.
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, DEFAULT_VIEWPORT } from './lib/cdp-browser.mjs'
import { vendorLaunchArgs } from './lib/witness-gpu.mjs'
import { witnessGpu } from './lib/gpu-probe.mjs'
import {
  assertServedClientRoot, clientRootTag, CLIENT_ROOT_BUNDLE,
} from './lib/served-client-root.mjs'
import {
  FRAME_BUDGET_MS, LOWER_ABOVE_MS, MIN_STEP_INTERVAL_MS, QUALITY_TIERS,
  HITCH_RESPONSE_BOUND_FRAMES,
} from '../client/core/QualityGovernor.js'

const LABEL = 'governor-hitch-response-browser-witness'
const LF = String.fromCharCode(10)

function flag(name, dflt = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}

const PORT = flag('port', '3157')
const WORLD = flag('world', 'tps-game')
const GPU_MODE = flag('gpu', 'accelerated')
const OVERLOAD = flag('overload', 'maxLevel=20,splitFactor=1.2,ssao=true,bloom=true,ssr=true')
const TIMEOUT_MS = Number(flag('timeout', '180000'))
const SETTLE_MS = Number(flag('settle', '3000'))
const MEASURE_MS = Number(flag('measure', '4000'))
const POLL_MS = Number(flag('poll', '100'))
const [VIEW_W, VIEW_H] = String(flag('viewport', DEFAULT_VIEWPORT.width + 'x' + DEFAULT_VIEWPORT.height)).split('x').map(Number)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRATCH = resolve(flag('scratch', join(tmpdir(), 'spoint-governor-hitch-browser')))

function finish(verdict, detail) {
  console.log(`RESULT: ${verdict} arm=${GPU_MODE} label=${LABEL} -- ${String(detail).split(LF).join(' ')}`)
  process.exit(verdict === 'PASS' ? 0 : 1)
}
const fail = (detail) => finish('FAIL', detail)

const num = (x) => typeof x === 'number' && Number.isFinite(x)
const OPS = {
  '==': (got, want) => Object.is(got, want),
  '<=': (got, want) => num(got) && got <= want,
  '>=': (got, want) => num(got) && got >= want,
  '>': (got, want) => num(got) && got > want,
  '<': (got, want) => num(got) && got < want,
}
const checks = []
function expect(label, got, op, want) {
  const pass = OPS[op](got, want) === true
  checks.push({ label, got, op, want, pass })
  return pass
}
const jsonLine = (o) => JSON.stringify(o)

const PLAYABLE_EXPR = 'window.__app && window.__app.revealedAt != null'

const APPLY_OVERLOAD = `(() => {
  const spec = ${JSON.stringify(OVERLOAD)}.split(',').map(s => s.split('=')).map(([k, v]) => [k, v === 'true' ? true : v === 'false' ? false : Number(v)])
  const out = []
  for (const [k, v] of spec) {
    const setReturned = window.__renderControls.set(k, v)
    out.push({ key: k, value: v, setReturned, readback: window.__renderControls.get(k) })
  }
  return { applied: out }
})()`

// The latch path sheds a tier without publishing state, and publish() only runs when a 30-frame
// window closes, so watching __qualityGovernorState.steps would see the action up to 30 frames late.
// The action the governor actually takes is a RenderControls.set on a governed key, so hook that.
const TIER_KEYS_JSON = JSON.stringify(['maxLevel', 'splitFactor', 'vegLeafOff', 'ssao', 'bloom', 'ssr'])
const INSTALL_WRITE_HOOK = `(() => {
  const rc = window.__renderControls
  if (!rc) return { ok: false, why: 'no window.__renderControls' }
  const keys = ${TIER_KEYS_JSON}
  window.__govWrites = []
  window.__govEnableWall = Date.now()
  const orig = rc.set.bind(rc)
  rc.set = (k, v) => {
    if (window.__govEnableWall !== null && keys.indexOf(k) >= 0) {
      window.__govWrites.push({ key: k, value: v, wall: Date.now(), frames: window.__perf ? window.__perf.stats().count : 0 })
    }
    return orig(k, v)
  }
  return { ok: true }
})()`

const REARM_WRITE_HOOK = `(() => { window.__govWrites = []; window.__govEnableWall = Date.now(); return { ok: true } })()`

const WRITE_PROBE = `(() => {
  const l = window.__govWrites || []
  return { n: l.length, first: l[0] || null, wall: Date.now() }
})()`

const KNOBS_READ = `(() => {
  const rc = window.__renderControls
  return { maxLevel: rc.get('maxLevel'), splitFactor: rc.get('splitFactor'), vegLeafOff: rc.get('vegLeafOff'), ssao: rc.get('ssao'), bloom: rc.get('bloom'), ssr: rc.get('ssr'), off: rc.get('qualityGovernorOff'), tier: window.__qualityGovernorApi ? window.__qualityGovernorApi.tier : null }
})()`

const PROBE = `(() => {
  const g = window.__qualityGovernorState
  const r = window.__renderer
  const c = r && r.domElement
  const info = r && r.info && r.info.render ? r.info.render : null
  return {
    tier: g ? g.tier : null,
    avgMs: g ? g.avgMs : null,
    steps: g ? g.steps : null,
    knobs: g ? g.knobs : null,
    pr: r && r.getPixelRatio ? r.getPixelRatio() : null,
    cw: c ? c.width : null,
    ch: c ? c.height : null,
    drawCalls: info ? info.calls : null,
    renderer: window.__rendererInfo ? window.__rendererInfo.renderer : null,
    dprAuto: window.__renderControls ? window.__renderControls.get('dprAuto') : null,
    dprOff: window.__renderControls ? window.__renderControls.get('dprOff') : null,
    frames: window.__perf ? window.__perf.stats().count : 0,
    perfAvgMs: window.__perf ? window.__perf.stats().avgMs : null,
    perfMaxMs: window.__perf ? window.__perf.stats().maxMs : null,
    effects: window.__renderControls
      ? { ssao: window.__renderControls.get('ssao'), bloom: window.__renderControls.get('bloom'), ssr: window.__renderControls.get('ssr') }
      : null,
  }
})()`

async function measureWindow(page) {
  await page.evaluate(`window.__perf.reset()`)
  const a = await page.evaluate(PROBE)
  const t0 = Date.now()
  await page.waitForTimeout(MEASURE_MS)
  const b = await page.evaluate(PROBE)
  const wallMs = Date.now() - t0
  const dFrames = b.frames - a.frames
  const dCalls = num(b.drawCalls) && num(a.drawCalls) ? b.drawCalls - a.drawCalls : null
  return {
    wallMs, frames: dFrames,
    fps: dFrames > 0 ? +(dFrames / (wallMs / 1000)).toFixed(2) : null,
    avgMs: num(b.perfAvgMs) ? +b.perfAvgMs.toFixed(3) : null,
    maxMs: num(b.perfMaxMs) ? +b.perfMaxMs.toFixed(3) : null,
    drawsPerFrame: dFrames > 0 && dCalls !== null ? +(dCalls / dFrames).toFixed(2) : null,
    drawCalls: dCalls,
    pr: b.pr, cw: b.cw, ch: b.ch, effects: b.effects, tier: b.tier, steps: b.steps, knobs: b.knobs,
  }
}

async function browserArm() {
  process.env.WORLD = process.env.WORLD || WORLD
  process.env.PORT = PORT
  process.env.SPOINT_NO_WATCH = '1'
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(SCRATCH, { recursive: true })
  process.env.SPOINT_STATIC_CACHE_DIR = join(SCRATCH, 'static')
  const { boot } = await import('../src/sdk/server.js')
  const { STATIC_CACHE_DIR } = await import('../src/sdk/StaticCache.js')
  if (STATIC_CACHE_DIR !== join(SCRATCH, 'static')) fail(`static cache resolved to ${STATIC_CACHE_DIR}, not the scratch dir`)
  const server = await boot({ storageDir: join(SCRATCH, 'data') })
  const base = `http://127.0.0.1:${PORT}`

  let browser = null
  const pageErrors = []
  let gpuName = null
  let servedRoot = null
  let before = null
  let after = null
  let firstAction = null
  let knobsBefore = null
  let dprAuto = null
  let dprOff = null
  let prs = []
  let sizes = []
  try {
    browser = await chromium.launch({ args: vendorLaunchArgs(GPU_MODE) })
    const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT })
    page.on('pageerror', e => pageErrors.push(String(e)))
    await page.goto(`${base}/?singleplayer&dprOff=true`, { waitUntil: 'domcontentloaded' })
    // This arm measures steady-state frame time after boot, not the load path, so it is admitted on
    // whichever client root the server actually serves -- but only on one it can ATTRIBUTE: the entry
    // must carry its own root kind and its bytes must hash to this checkout's entry for that kind.
    // A stale bundle makes the server fall through to raw ESM, and refusing that would make the arm
    // unrunnable on a tree where sibling lanes are still editing client sources.
    const root = await assertServedClientRoot(page, { want: null, label: LABEL }).catch(e => e)
    if (root instanceof Error) fail(root.message)
    servedRoot = root
    expect('browser: the served client root is hash-attributed to this checkout', servedRoot.byHash, '==', servedRoot.kind)
    const gpu = await witnessGpu(page, GPU_MODE)
    gpuName = gpu.renderer || gpu.adapter || null

    const t0 = Date.now()
    let playable = false
    while (Date.now() - t0 < TIMEOUT_MS) {
      const st = await page.evaluate(`({ playable: !!(${PLAYABLE_EXPR}) })`).catch(() => ({}))
      if (st.playable) { playable = true; break }
      await new Promise(r => setTimeout(r, 250))
    }
    if (!playable) fail(`the page never became playable within ${TIMEOUT_MS}ms (pageErrors=${pageErrors.length}${pageErrors[0] ? ': ' + pageErrors[0].slice(0, 200) : ''})`)

    // The governor is live by default and boot frames are over budget, so it can walk the ladder
    // before the arm starts. Pin the opt-out the moment the page is playable and hand the tier back
    // to 0, so the baseline is the overload and the enable is what makes the governor act.
    const shippedOn = await page.evaluate(`window.__renderControls.get('qualityGovernor')`)
    expect('browser: the shipped default of qualityGovernor is true', shippedOn, '==', true)
    await page.evaluate(`window.__renderControls.set('qualityGovernorOff', true)`)
    // dprOff is NOT parsed out of the query string on this page (the URL param is inert outside
    // perf-run.mjs), so pin it through the registry and then read it back.
    await page.evaluate(`window.__renderControls.set('dprOff', true)`)
    const rewound = await page.evaluate(`(() => {
      const api = window.__qualityGovernorApi
      if (!api) return { ok: false }
      api.setTier(0)
      return { ok: true, tier: api.tier }
    })()`)
    if (!rewound || rewound.ok !== true) fail(`browser: the governor never exposed its api, so the baseline tier cannot be pinned: ${JSON.stringify(rewound)}`)

    const applied = await page.evaluate(APPLY_OVERLOAD)
    if (!applied || applied.error) fail(`browser: the overload never applied: ${JSON.stringify(applied)}`)
    expect('browser: every overload knob landed through RenderControls.set', applied.applied.every(k => k.setReturned === true && k.readback === k.value), '==', true)
    dprAuto = await page.evaluate(`window.__renderControls.get('dprAuto')`)
    dprOff = await page.evaluate(`window.__renderControls.get('dprOff')`)
    expect('browser: dprAuto is false on the measuring arm', dprAuto, '==', false)
    expect('browser: dprOff is true on the measuring arm', dprOff, '==', true)

    const hooked = await page.evaluate(INSTALL_WRITE_HOOK)
    if (!hooked || hooked.ok !== true) fail(`browser: the write hook never installed: ${JSON.stringify(hooked)}`)
    await page.evaluate(`window.__renderControls.set('qualityGovernorOff', true)`)

    before = await measureWindow(page)
    const baselineWrites = await page.evaluate(WRITE_PROBE)
    expect('browser: the governor is pinned off for the whole baseline window', baselineWrites.n, '==', 0)
    expect('browser: the overload exceeds the frame budget before the governor is enabled', before.avgMs, '>', LOWER_ABOVE_MS)
    expect('browser: draw calls are counted, so the measured effect is a counted work unit', before.drawsPerFrame, '>', 0)
    const enableFrames = (await page.evaluate(PROBE)).frames
    knobsBefore = await page.evaluate(KNOBS_READ)
    const tEnable = Date.now()
    await page.evaluate(REARM_WRITE_HOOK)
    await page.evaluate(`window.__renderControls.set('qualityGovernorOff', false)`)

    while (Date.now() - tEnable < TIMEOUT_MS) {
      await page.waitForTimeout(POLL_MS)
      const w = await page.evaluate(WRITE_PROBE)
      if (w.n > 0) {
        firstAction = { latencyMs: w.first.wall - tEnable, frames: w.first.frames - enableFrames, key: w.first.key, value: w.first.value, writes: w.n, wallNow: w.wall }
        break
      }
    }
    if (firstAction === null) fail(`browser: the governor took no action within ${TIMEOUT_MS}ms of the load spike`)
    // Freeze the ladder at the tier the first action reached, so the after-arm measures the effect of
    // exactly that action and not of the rest of the walk down.
    await page.evaluate(`window.__renderControls.set('qualityGovernorOff', true)`)
    const knobsAfter = await page.evaluate(KNOBS_READ)
    firstAction.tier = knobsAfter.tier
    firstAction.knobs = knobsAfter

    after = await measureWindow(page)
    const sizesBefore = `${before.cw}x${before.ch}`
    const sizesAfter = `${after.cw}x${after.ch}`
    prs = [...new Set([before.pr, after.pr])]
    sizes = [...new Set([sizesBefore, sizesAfter])]

    console.log(`[${LABEL}] before ${jsonLine({ ...before, knobs: knobsBefore })}`)
    console.log(`[${LABEL}] firstAction ${jsonLine(firstAction)}`)
    console.log(`[${LABEL}] after ${jsonLine({ ...after, knobs: knobsAfter })}`)

    expect('browser: the response latency beats the window-driven one-second floor', firstAction.latencyMs, '<', MIN_STEP_INTERVAL_MS)
    expect('browser: the first action lands inside the response bound plus one poll interval', firstAction.frames, '<=', HITCH_RESPONSE_BOUND_FRAMES + Math.ceil(POLL_MS / FRAME_BUDGET_MS))
    expect('browser: the governor action lowered the measured frame time', after.avgMs, '<', before.avgMs)
    expect('browser: the governor action lowered counted draw work per frame', after.drawsPerFrame, '<', before.drawsPerFrame)
    expect('browser: the first action wrote at least one governed key', firstAction.writes, '>', 0)
    expect('browser: the first action left the booted tier', firstAction.tier, '>=', 1)
    expect('browser: the action clamps maxLevel to the tier-1 table value', firstAction.knobs.maxLevel, '<=', QUALITY_TIERS[1].maxLevel)
    expect('browser: the action did not move the leaf distance band', firstAction.knobs.vegLeafOff, '==', 0)
    expect('browser: effects were shed', after.effects && after.effects.ssao === false && after.effects.bloom === false && after.effects.ssr === false, '==', true)
    expect('browser: devicePixelRatio is unchanged by the governor', prs.length, '==', 1)
    expect('browser: canvas drawing-buffer size is unchanged by the governor', sizes.length, '==', 1)
    expect('browser: no uncaught page errors', pageErrors.length, '==', 0)
    await browser.close().catch(() => {})
    browser = null
    server.stop()
  } catch (e) {
    if (browser) await browser.close().catch(() => {})
    server.stop()
    throw e
  }

  console.log(`[${LABEL}] browser ${jsonLine({ gpu: gpuName, clientRoot: servedRoot ? clientRootTag(servedRoot) : null, before: before && { avgMs: before.avgMs, drawsPerFrame: before.drawsPerFrame }, after: after && { avgMs: after.avgMs, drawsPerFrame: after.drawsPerFrame }, firstAction, prs, sizes })}`)

  const failed = checks.filter(c => !c.pass)
  for (const c of failed) console.log(`[${LABEL}] FAILED ${c.label}: got ${JSON.stringify(c.got)} ${c.op} ${JSON.stringify(c.want)}`)
  console.log(`[${LABEL}] checks ${checks.length - failed.length}/${checks.length} passed`)
  finish(failed.length === 0 ? 'PASS' : 'FAIL', failed.length === 0
    ? `governor answered the load spike after ${firstAction.latencyMs}ms / ${firstAction.frames} frames (tier 0 -> ${firstAction.tier}, maxLevel ${knobsBefore.maxLevel} -> ${firstAction.knobs.maxLevel}, splitFactor ${knobsBefore.splitFactor} -> ${firstAction.knobs.splitFactor}, vegLeafOff ${knobsBefore.vegLeafOff} -> ${firstAction.knobs.vegLeafOff}); frame time ${before.avgMs}ms -> ${after.avgMs}ms and draws/frame ${before.drawsPerFrame} -> ${after.drawsPerFrame}, pr ${JSON.stringify(prs)} canvas ${JSON.stringify(sizes)} unchanged`
    : `${failed.length} check(s) failed`)
}

browserArm().catch(e => fail(`${e && e.stack ? e.stack : e}`))
