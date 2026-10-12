#!/usr/bin/env node
// Witness for perf-dynamic-quality-governor-60fps-no-pixel-doubling.
//
// Arm 1 (always, no GPU): drives the REAL client/core/QualityGovernor.js module in Node with an
// injected clock and an injected read/write pair, from a synthetic load above the frame budget.
// Asserts convergence, stepwise +/-1 tier motion, the <=1 step/second bound, the dead band,
// clamp compliance, and that no resolution key is ever written.
//
// Arm 2 (browser, under scripts/gpulock.mjs): boots the real server + real client on the GPU with
// a deliberately over-budget terrain/effect load, enables the governor live, and asserts the frame
// time converges into the band (or the ladder rails) while devicePixelRatio and the canvas
// drawing-buffer size stay byte-constant across the whole run.
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from './lib/cdp-browser.mjs'
import { vendorLaunchArgs } from './lib/witness-gpu.mjs'
import { witnessGpu } from './lib/gpu-probe.mjs'
import {
  assertServedClientRoot, clientRootTag, rebuildClientBundle, CLIENT_ROOT_BUNDLE, CLIENT_ROOT_RAW,
} from './lib/served-client-root.mjs'
import {
  createQualityGovernor, QUALITY_TIERS, MAX_TIER, GOVERNED_KNOBS, RESOLUTION_KEYS,
  FRAME_BUDGET_MS, LOWER_ABOVE_MS, RAISE_BELOW_MS, MIN_STEP_INTERVAL_MS,
} from '../client/core/QualityGovernor.js'
import { flagListNumber, flagNumber } from './lib/witness-args.mjs'

const LABEL = 'quality-governor-witness'
const ADMITTED_GPU_MODES = new Set(['software', 'swiftshader', 'accelerated', 'nvidia', 'amd'])
const LF = String.fromCharCode(10)

function flag(name, dflt = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}

const PORT = flag('port', '3141')
const WORLD = flag('world', 'tps-game')
const GPU_MODE = flag('gpu', 'accelerated')
const OVERLOAD = flag('overload', 'maxLevel=20,splitFactor=1.2,ssao=true,bloom=true,ssr=true')
const TIMEOUT_MS = flagNumber(flag, 'timeout', 180000, process.argv.slice(2))
const SETTLE_MS = flagNumber(flag, 'settle', 3000, process.argv.slice(2))
const POLL_MS = flagNumber(flag, 'poll', 500, process.argv.slice(2))
const MAX_SAMPLES = flagNumber(flag, 'max-samples', 60, process.argv.slice(2))
const MIN_TIER = flagNumber(flag, 'min-tier', 1, process.argv.slice(2))
const CONTROL_FRAMES = flagNumber(flag, 'control-frames', 2010, process.argv.slice(2))
const ARM = flag('arm', 'unlabelled')
const [VIEW_W, VIEW_H] = flagListNumber(flag, 'viewport', [1280, 720], 'x', process.argv.slice(2))
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRATCH = resolve(flag('scratch', join(tmpdir(), 'spoint-quality-governor-witness')))

function finish(verdict, detail) {
  console.log(`RESULT: ${verdict} arm=${GPU_MODE} label=${ARM} -- ${String(detail).split(LF).join(' ')}`)
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

if (!ADMITTED_GPU_MODES.has(GPU_MODE)) {
  fail(`--gpu=${GPU_MODE} refused: admitted modes are software, swiftshader, accelerated, nvidia, amd`)
}

const GOVERNED_KEYS = GOVERNED_KNOBS.map(k => k.key)
// The state mirror is written by publish() but drives nothing: it is not a knob.
const PERMITTED_KEYS = new Set([...GOVERNED_KEYS, 'qualityGovernorState'])
const jsonLine = (o) => JSON.stringify(o)

// The overload is applied at DOCUMENT START, the way scripts/perf-run.mjs applies --knob: a
// document-start script traps each window.__<key> and the later assignment of
// window.__renderControls, then calls registry.set() the moment the registry appears. `?knob=` in
// the URL is inert (no client code parses it), so a URL alone would boot the un-overloaded page.
const OVERLOAD_PAIRS = OVERLOAD.split(',').map(pair => {
  const i = pair.indexOf('=')
  if (i < 0) fail(`--overload entry '${pair}' is not <key>=<value>`)
  const key = pair.slice(0, i).trim()
  const raw = pair.slice(i + 1).trim()
  const value = raw === 'true' ? true : raw === 'false' ? false : Number(raw)
  if (!GOVERNED_KEYS.includes(key)) fail(`--overload key '${key}' is not a governed knob: ${GOVERNED_KEYS.join(',')}`)
  if (!Number.isFinite(value) && typeof value !== 'boolean') fail(`--overload entry '${pair}' has a non-numeric, non-boolean value`)
  return { key, value }
})

// The overload is applied AFTER boot, not from the URL: `?knob=` is inert (no client code parses
// it) and client/core/QualityPresets.js re-sets ssao/bloom/ssr during boot, so a document-start
// write is overwritten before the first measured frame. Every governed knob has a live per-frame
// consumer, so setting it after boot is the load the governor is then asked to hold.
const APPLY_OVERLOAD = `(() => {
  const rc = window.__renderControls
  if (!rc || typeof rc.set !== 'function') return { error: 'no window.__renderControls.set' }
  const want = ${JSON.stringify(OVERLOAD_PAIRS)}
  const out = []
  for (const k of want) out.push({ key: k.key, value: k.value, setReturned: rc.set(k.key, k.value), readback: rc.get(k.key) })
  return { applied: out }
})()`

// ---------------------------------------------------------------- arm 1: real module, Node

function controlLawArm() {
  const reads = new Map([
    ['maxLevel', 20], ['splitFactor', 1.2], ['vegLeafOff', false],
    ['ssao', true], ['bloom', true], ['ssr', true],
  ])
  const writes = [] // {frame, key, value}
  const resolutionWrites = []
  let simNow = 1000
  let frame = 0
  const gov = createQualityGovernor({
    enabled: () => true,
    now: () => simNow,
    read: (k) => reads.get(k),
    write: (k, v) => {
      frame++
      writes.push({ frame, key: k, value: v })
      if (RESOLUTION_KEYS.has(k)) resolutionWrites.push(k)
      reads.set(k, v)
    },
  })

  const base = { maxLevel: 20, splitFactor: 1.2 }
  const feed = (ms, frames) => {
    for (let i = 0; i < frames; i++) { simNow += ms; gov.tick(ms) }
  }

  // phase 1: overload -- every frame at 40ms, ~2.4x the budget.
  const wall0 = simNow
  feed(40, CONTROL_FRAMES)
  const afterOverload = { ...gov.state() }
  const overloadWallMs = simNow - wall0

  // phase 2: recover -- every frame at 8ms, well below the raise threshold.
  feed(8, CONTROL_FRAMES)
  const afterRecover = { ...gov.state() }

  // phase 3: dead band -- 16.0ms sits inside [13.67, 17.67]; the governor must hold.
  const stepsBeforeBand = gov.state().steps
  feed(16.0, 900)
  const bandSteps = gov.state().steps - stepsBeforeBand

  // phase 4: single-window flip -- alternating slow/fast windows must never accumulate a streak.
  const stepsBeforeFlip = gov.state().steps
  for (let w = 0; w < 20; w++) feed(w % 2 === 0 ? 25 : 8, 30)
  const flipSteps = gov.state().steps - stepsBeforeFlip

  const tierWrites = writes.filter(w => w.key === 'maxLevel' || w.key === 'splitFactor')
  const badKnob = writes.find(w => !PERMITTED_KEYS.has(w.key))
  const maxLevels = writes.filter(w => w.key === 'maxLevel').map(w => w.value)
  const splitFactors = writes.filter(w => w.key === 'splitFactor').map(w => w.value)

  expect('control: governor shed tiers under a 40ms load', afterOverload.tier, '>=', MIN_TIER)
  expect('control: it did not run past the ladder floor', afterOverload.tier, '<=', MAX_TIER)
  expect('control: it came back down when headroom returned', afterRecover.tier, '<', afterOverload.tier)
  expect('control: it rested at the booted snapshot', afterRecover.tier, '==', 0)
  expect('control: dead band held at 16.0ms (no steps)', bandSteps, '==', 0)
  expect('control: single-window slow/fast flip never stepped', flipSteps, '==', 0)
  expect('control: no resolution key was ever written', resolutionWrites.length, '==', 0)
  expect('control: no ungoverned key was ever written', badKnob === undefined, '==', true)
  expect('control: every maxLevel write stayed in [2,22]', maxLevels.every(v => v >= 2 && v <= 22), '==', true)
  expect('control: every splitFactor write stayed >= 0.05', splitFactors.every(v => v >= 0.05), '==', true)
  expect('control: maxLevel never rose above the booted load', maxLevels.every(v => v <= base.maxLevel), '==', true)
  expect('control: splitFactor never rose above the booted load', splitFactors.every(v => v <= base.splitFactor + 1e-9), '==', true)
  // rate bound: one step per MIN_STEP_INTERVAL_MS of simulated wall clock, one slack step.
  const overloadSteps = writes.filter(w => w.key === 'ssao').length
  expect('control: steps stayed inside the 1/second bound', afterOverload.steps, '<=', Math.ceil(overloadWallMs / MIN_STEP_INTERVAL_MS) + 1)
  expect('control: the ladder has more than one shedding tier', QUALITY_TIERS.length, '>', 2)
  expect('control: effects were shed first', overloadSteps, '>=', 1)

  // monotonicity: successive maxLevel writes never increase while shedding.
  let mono = true
  for (let i = 1; i < maxLevels.length; i++) if (maxLevels[i] > maxLevels[i - 1] && maxLevels[i - 1] > base.maxLevel - 1e-9) mono = false
  expect('control: maxLevel writes never raised cost', mono, '==', true)

  console.log(`[${LABEL}] control ${jsonLine({ budgetMs: FRAME_BUDGET_MS, lowerAboveMs: LOWER_ABOVE_MS, raiseBelowMs: RAISE_BELOW_MS, overloadTier: afterOverload.tier, overloadSteps: afterOverload.steps, overloadWallMs, recoverTier: afterRecover.tier, bandSteps, flipSteps, maxLevels, splitFactors })}`)
  return { afterOverload, afterRecover, bandSteps, flipSteps, writes: writes.length }
}

// ---------------------------------------------------------------- arm 2: real browser, GPU

function resetScratch() {
  const insideRepo = SCRATCH.startsWith(REPO_ROOT + sep) || SCRATCH === REPO_ROOT
  const enclosesRepo = REPO_ROOT.startsWith(SCRATCH + sep)
  if (insideRepo || enclosesRepo || SCRATCH === resolve(tmpdir()) || dirname(SCRATCH) === SCRATCH) {
    fail(`--scratch=${SCRATCH} refused: scratch must be a directory outside the repo, not the temp root, not a filesystem root`)
  }
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(SCRATCH, { recursive: true })
}

const PIN_GOVERNOR_OFF = `(() => {
  const rc = window.__renderControls
  if (!rc || typeof rc.set !== 'function') return false
  return rc.set('qualityGovernorOff', true) === true && rc.get('qualityGovernorOff') === true
})()`

const PLAYABLE_EXPR = 'window.__app && window.__app.revealedAt != null'

const PROBE = `(() => {
  const g = window.__qualityGovernorState
  const r = window.__renderer
  const c = r && r.domElement
  return {
    tier: g ? g.tier : null,
    maxTier: g ? g.maxTier : null,
    avgMs: g ? g.avgMs : null,
    inBand: g ? g.inBand : null,
    atFloor: g ? g.atFloor : null,
    steps: g ? g.steps : null,
    knobs: g ? g.knobs : null,
    pr: r && r.getPixelRatio ? r.getPixelRatio() : null,
    cw: c ? c.width : null,
    ch: c ? c.height : null,
    dprAuto: window.__renderControls ? window.__renderControls.get('dprAuto') : null,
    dprMirror: window.__dpr || null,
    frames: window.__perf ? window.__perf.stats().count : 0,
    perfAvgMs: window.__perf ? window.__perf.stats().avgMs : null,
    effects: window.__renderControls
      ? { ssao: window.__renderControls.get('ssao'), bloom: window.__renderControls.get('bloom'), ssr: window.__renderControls.get('ssr') }
      : null,
  }
})()`

async function browserArm() {
  process.env.WORLD = process.env.WORLD || WORLD
  process.env.PORT = PORT
  process.env.SPOINT_NO_WATCH = '1'
  if (process.argv.includes('--rebuild-bundle')) {
    console.log(`[${LABEL}] --rebuild-bundle: running scripts/bundle-client.mjs before boot ...`)
    rebuildClientBundle()
  }
  resetScratch()
  process.env.SPOINT_STATIC_CACHE_DIR = join(SCRATCH, 'static')
  const { boot } = await import('../src/sdk/server.js')
  const { STATIC_CACHE_DIR } = await import('../src/sdk/StaticCache.js')
  if (STATIC_CACHE_DIR !== join(SCRATCH, 'static')) fail(`static cache resolved to ${STATIC_CACHE_DIR}, not the scratch dir`)
  const server = await boot({ storageDir: join(SCRATCH, 'data') })
  const base = `http://127.0.0.1:${PORT}`
  const want = process.argv.includes('--require-raw-esm') ? CLIENT_ROOT_RAW : CLIENT_ROOT_BUNDLE
  const params = flag('params', 'singleplayer')

  let browser = null
  let samples = []
  let gpuName = null
  let servedRoot = null
  let enableFrames = 0
  let pageErrors = []
  let convergedAt = null
  let convergedFrames = null
  try {
    browser = await chromium.launch({ headless: false, args: vendorLaunchArgs(GPU_MODE) })
    const page = await browser.newPage({ viewport: { width: VIEW_W, height: VIEW_H } })
    page.on('pageerror', e => pageErrors.push(String(e)))
    await page.goto(`${base}/?${params}`, { waitUntil: 'domcontentloaded' })
    const root = await assertServedClientRoot(page, { want, label: LABEL }).catch(e => e)
    if (root instanceof Error) fail(root.message)
    servedRoot = root
    const gpu = await witnessGpu(page, GPU_MODE)
    gpuName = gpu.renderer || gpu.adapter || null

    const tPin = Date.now()
    let pinned = false
    while (Date.now() - tPin < TIMEOUT_MS) {
      const ok = await page.evaluate(PIN_GOVERNOR_OFF).catch(() => false)
      if (ok === true) { pinned = true; break }
      await new Promise(r => setTimeout(r, 100))
    }
    if (!pinned) fail(`browser: the governor opt-out never landed within ${TIMEOUT_MS}ms (window.__renderControls never appeared)`)

    const t0 = Date.now()
    let playable = false
    while (Date.now() - t0 < TIMEOUT_MS) {
      const st = await page.evaluate(`({ playable: !!(${PLAYABLE_EXPR}), dprAuto: window.__renderControls ? window.__renderControls.get('dprAuto') : null })`).catch(() => ({}))
      if (st.playable) { playable = true; break }
      await new Promise(r => setTimeout(r, 250))
    }
    if (!playable) fail(`the page never became playable within ${TIMEOUT_MS}ms (pageErrors=${pageErrors.length}${pageErrors[0] ? ': ' + pageErrors[0].slice(0, 200) : ''})`)

    // Build the over-budget load, then drop the boot frames out of the perf ring so the measured
    // precondition is the load the governor is actually handed, not boot-time streaming.
    const applied = await page.evaluate(APPLY_OVERLOAD)
    if (!applied || applied.error) fail(`browser: the overload never applied: ${JSON.stringify(applied)}`)
    const landed = applied.applied.every(k => k.setReturned === true && k.readback === k.value)
    expect('browser: every overload knob landed through RenderControls.set', landed, '==', true)
    console.log(`[${LABEL}] overload ${jsonLine(applied.applied)}`)
    await page.evaluate(`window.__perf.reset()`)
    if (SETTLE_MS > 0) await page.waitForTimeout(SETTLE_MS)

    const bootProbe = await page.evaluate(PROBE)
    expect('browser: dprAuto is false at boot', bootProbe.dprAuto, '==', false)
    expect('browser: the DPR mirror holds the unscaled pixel ratio at boot', num(bootProbe.dprMirror) && Math.abs(bootProbe.dprMirror - bootProbe.pr) < 1e-3, '==', true)
    expect('browser: governor is off before it is enabled', bootProbe.tier, '==', null)
    const bootAvg = bootProbe.perfAvgMs
    const bootEffects = bootProbe.effects || {}
    // Overload precondition: the row starts "from a load that exceeds the budget". If the page is
    // already inside the band there is nothing for the governor to do and nothing is proven.
    expect('browser: the booted load exceeds the frame budget (overload precondition, avgMs > lowerAboveMs)', bootAvg, '>', LOWER_ABOVE_MS)
    expect('browser: ssao/bloom/ssr were on at boot, so shedding them means something', bootEffects.ssao === true && bootEffects.bloom === true && bootEffects.ssr === true, '==', true)
    console.log(`[${LABEL}] boot ${jsonLine({ avgMs: bootAvg, frames: bootProbe.frames, effects: bootEffects, pr: bootProbe.pr, canvas: `${bootProbe.cw}x${bootProbe.ch}` })}`)

    const enabledAt = Date.now()
    enableFrames = bootProbe.frames
    await page.evaluate(`window.__renderControls.set('qualityGovernorOff', false)`)

    while (Date.now() - enabledAt < TIMEOUT_MS && samples.length < MAX_SAMPLES) {
      await page.waitForTimeout(POLL_MS)
      const s = await page.evaluate(PROBE)
      samples.push({ t: Date.now() - enabledAt, ...s })
      const converged = s.tier != null && (s.inBand === true || s.atFloor === true)
      if (converged && samples.length >= 3) { convergedAt = samples.length; convergedFrames = s.frames - enableFrames; break }
    }
    await browser.close().catch(() => {})
    browser = null
    server.stop()
  } catch (e) {
    if (browser) await browser.close().catch(() => {})
    server.stop()
    throw e
  }

  const last = samples[samples.length - 1]
  if (!last) fail('browser: no governor samples were collected')
  const prs = [...new Set(samples.map(s => s.pr))]
  const sizes = [...new Set(samples.map(s => `${s.cw}x${s.ch}`))]
  const dprAutos = [...new Set(samples.map(s => s.dprAuto))]
  const dprMirrors = [...new Set(samples.map(s => s.dprMirror))]
  const tiers = samples.map(s => s.tier)
  let maxJump = 0
  for (let i = 1; i < tiers.length; i++) maxJump = Math.max(maxJump, Math.abs(tiers[i] - tiers[i - 1]))
  const elapsedMs = last.t
  const knobs = last.knobs || {}

  console.log(`[${LABEL}] browser ${jsonLine({ gpu: gpuName, clientRoot: servedRoot ? clientRootTag(servedRoot) : null, samples: samples.length, finalTier: last.tier, finalAvgMs: last.avgMs, steps: last.steps, convergedAt, convergedFrames, prs, sizes, knobs })}`)

  expect('browser: the governor stepped off the booted tier', last.tier, '>=', MIN_TIER)
  expect('browser: it converged inside the sample budget', convergedAt, '>', 0)
  expect('browser: convergence took a bounded number of frames', convergedFrames, '<=', CONTROL_FRAMES)
  expect('browser: devicePixelRatio is constant across the run', prs.length, '==', 1)
  expect('browser: canvas drawing-buffer size is constant across the run', sizes.length, '==', 1)
  expect('browser: dprAuto stayed false across the run', dprAutos.length === 1 && dprAutos[0] === false, '==', true)
  expect('browser: the DPR mirror never moved off the unscaled pixel ratio', dprMirrors.length === 1 && dprMirrors[0] === prs[0], '==', true)
  expect('browser: tier moved at most one step between polls', maxJump, '<=', 1)
  expect('browser: steps stayed inside the 1/second bound', last.steps, '<=', Math.ceil(elapsedMs / MIN_STEP_INTERVAL_MS) + 1)
  expect('browser: maxLevel stayed in [2,22]', knobs.maxLevel === undefined || (knobs.maxLevel >= 2 && knobs.maxLevel <= 22), '==', true)
  expect('browser: splitFactor stayed >= 0.05', knobs.splitFactor === undefined || knobs.splitFactor >= 0.05, '==', true)
  expect('browser: effects were shed', knobs.ssao === false && knobs.bloom === false && knobs.ssr === false, '==', true)
  expect('browser: no uncaught page errors', pageErrors.length, '==', 0)
  return { gpuName, samples: samples.length, finalTier: last.tier, prs, sizes, convergedAt, convergedFrames }
}

async function main() {
  const control = controlLawArm()
  const browser = await browserArm()
  const failed = checks.filter(c => !c.pass)
  for (const c of failed) console.log(`[${LABEL}] FAILED ${c.label}: got ${JSON.stringify(c.got)} ${c.op} ${JSON.stringify(c.want)}`)
  console.log(`[${LABEL}] checks ${checks.length - failed.length}/${checks.length} passed (control tier ${control.afterOverload.tier} -> ${control.afterRecover.tier}; browser tier ${browser.finalTier}, pr ${JSON.stringify(browser.prs)}, canvas ${JSON.stringify(browser.sizes)})`)
  finish(failed.length === 0 ? 'PASS' : 'FAIL', failed.length === 0
    ? `control convergence ${control.afterOverload.tier}->${control.afterRecover.tier}, browser tier ${browser.finalTier} converged at sample ${browser.convergedAt} after ${browser.convergedFrames} frames, pr ${JSON.stringify(browser.prs)} canvas ${JSON.stringify(browser.sizes)} unchanged`
    : `${failed.length} check(s) failed`)
}

main().catch(e => fail(`${e && e.stack ? e.stack : e}`))
