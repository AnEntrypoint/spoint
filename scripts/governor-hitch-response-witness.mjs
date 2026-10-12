#!/usr/bin/env node
import {
  createQualityGovernor, FRAME_BUDGET_MS, LOWER_ABOVE_MS, RAISE_BELOW_MS, MIN_STEP_INTERVAL_MS,
  RESOLUTION_KEYS, MAX_TIER, HITCH_ABOVE_MS, HITCH_STEP_INTERVAL_MS, HITCH_RESPONSE_BOUND_FRAMES,
} from '../client/core/QualityGovernor.js'
import { RenderControls } from '../client/core/RenderControls.js'
import { numericFlag, parseArgs } from './lib/witness-args.mjs'

const LABEL = 'governor-hitch-response-witness'
const LF = String.fromCharCode(10)

const args = parseArgs(process.argv.slice(2))
const BASELINE_MS = numericFlag(args, 'baselineMs', 8)
const SETTLE_FRAMES = numericFlag(args, 'settleFrames', 210)
const SETTLE_AFTER_FRAMES = numericFlag(args, 'settleAfterFrames', 600)
const SPIKE_MS = numericFlag(args, 'spikeMs', 40)
const HITCH_MS = numericFlag(args, 'hitchMs', 100)
const SUSTAIN_FRAMES = numericFlag(args, 'sustainFrames', 400)
const BURST_CAP = numericFlag(args, 'burstCap', 80)
const TRAIN_WINDOWS = numericFlag(args, 'trainWindows', 60)

function finish(verdict, detail) {
  console.log(`RESULT: ${verdict} label=${LABEL} -- ${String(detail).split(LF).join(' ')}`)
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

const TIER_KEYS = new Set(['maxLevel', 'splitFactor', 'vegLeafOff', 'ssao', 'bloom', 'ssr'])
const resolutionWrites = []

function harness(opts = {}) {
  const reads = new Map([
    ['maxLevel', 20], ['splitFactor', 1.2], ['vegLeafOff', false],
    ['ssao', true], ['bloom', true], ['ssr', true],
  ])
  const writes = []
  let simNow = 0
  let frame = 0
  const gov = createQualityGovernor({
    enabled: () => opts.off !== true,
    now: () => simNow,
    read: (k) => reads.get(k),
    write: (k, v) => {
      writes.push({ frame, ms: simNow, key: k, value: v })
      if (RESOLUTION_KEYS.has(k)) resolutionWrites.push(k)
      reads.set(k, v)
    },
  })
  const feed = (ms, frames) => {
    for (let i = 0; i < frames; i++) { simNow += ms; frame++; gov.tick(ms) }
  }
  return {
    gov, writes, feed,
    frame: () => frame,
    now: () => simNow,
    pending: (from) => writes.slice(from).filter(w => TIER_KEYS.has(w.key)),
  }
}

function enableBitArm() {
  const bootDefault = RenderControls.get('qualityGovernor')
  const bootDefaultOff = RenderControls.get('qualityGovernorOff')

  function registryArm(optOut) {
    const reads = new Map([
      ['maxLevel', 20], ['splitFactor', 1.2], ['vegLeafOff', false],
      ['ssao', true], ['bloom', true], ['ssr', true],
    ])
    if (optOut) reads.set('qualityGovernorOff', true)
    const writes = []
    let simNow = 0
    const gov = createQualityGovernor({
      now: () => simNow,
      read: (k) => (reads.has(k) ? reads.get(k) : RenderControls.get(k)),
      write: (k, v) => {
        writes.push({ key: k, value: v })
        if (RESOLUTION_KEYS.has(k)) resolutionWrites.push(k)
        reads.set(k, v)
      },
    })
    let movedAt = null
    for (let i = 0; i < 600 && movedAt === null; i++) { simNow += SPIKE_MS; gov.tick(SPIKE_MS); if (gov.tier > 0) movedAt = i + 1 }
    return { gov, movedAt, steps: gov.state().steps, writes: writes.length }
  }

  const shipped = registryArm(false)
  const optedOut = registryArm(true)

  console.log(`[${LABEL}] enable-bit ${jsonLine({ bootDefault, bootDefaultOff, shippedMovedAt: shipped.movedAt, shippedTier: shipped.gov.tier, shippedSteps: shipped.steps, optedOutMovedAt: optedOut.movedAt, optedOutTier: optedOut.gov.tier, optedOutSteps: optedOut.steps, hitchAboveMs: HITCH_ABOVE_MS, responseBoundFrames: HITCH_RESPONSE_BOUND_FRAMES })}`)

  expect('enable-bit: the registry default of qualityGovernor is true', bootDefault, '==', true)
  expect('enable-bit: the registry default of qualityGovernorOff is still false', bootDefaultOff, '==', false)
  expect('enable-bit: with the shipped defaults a 40ms load moves the governor', shipped.movedAt, '>', 0)
  expect('enable-bit: it answers inside the response bound', shipped.movedAt, '<=', HITCH_RESPONSE_BOUND_FRAMES)
  expect('enable-bit: it leaves the booted tier on the shipped defaults', shipped.gov.tier, '>', 0)
  expect('enable-bit: it takes at least one step on the shipped defaults', shipped.steps, '>', 0)
  expect('enable-bit: qualityGovernorOff still pins the tier', optedOut.movedAt, '==', null)
  expect('enable-bit: the opt-out takes zero steps', optedOut.steps, '==', 0)
  return { bootDefault, bootDefaultOff, shippedMovedAt: shipped.movedAt, shippedSteps: shipped.steps, optedOutSteps: optedOut.steps }
}

function responseArm() {
  const sustained = {}
  for (const spikeMs of [17.7, 25, 33.34, 50]) {
    const h = harness()
    h.feed(BASELINE_MS, SETTLE_FRAMES)
    const from = h.writes.length
    const ms0 = h.now()
    const f0 = h.frame()
    h.feed(spikeMs, SUSTAIN_FRAMES)
    const first = h.pending(from)[0]
    sustained[spikeMs] = first ? { frames: first.frame - f0, ms: +(first.ms - ms0).toFixed(1) } : null
  }

  function singleHitch(hitchMs) {
    const h = harness()
    h.feed(BASELINE_MS, SETTLE_FRAMES)
    const from = h.writes.length
    const f0 = h.frame()
    h.feed(hitchMs, 1)
    h.feed(BASELINE_MS, SETTLE_AFTER_FRAMES)
    const first = h.pending(from)[0]
    return { steps: h.pending(from).length, frames: first ? first.frame - f0 : null }
  }
  const hitch = {}
  for (const hitchMs of [50, 100, 200]) hitch[hitchMs] = singleHitch(hitchMs).steps
  const hitch100 = singleHitch(HITCH_MS)

  function burstTrips(k) {
    const h = harness()
    h.feed(BASELINE_MS, SETTLE_FRAMES)
    const from = h.writes.length
    h.feed(SPIKE_MS, k)
    h.feed(BASELINE_MS, 900)
    return h.pending(from).length > 0
  }
  let minBurstFrames = null
  for (let k = 1; k <= BURST_CAP && minBurstFrames === null; k++) if (burstTrips(k)) minBurstFrames = k

  function train(hitchMs, windows = TRAIN_WINDOWS) {
    const h = harness()
    h.feed(BASELINE_MS, SETTLE_FRAMES)
    const from = h.writes.length
    const f0 = h.frame()
    const ms0 = h.now()
    for (let w = 0; w < windows; w++) { h.feed(hitchMs, 1); h.feed(BASELINE_MS, 29) }
    const first = h.pending(from)[0]
    return {
      steps: h.pending(from).length,
      firstFrames: first ? first.frame - f0 : null,
      firstMs: first ? +(first.ms - ms0).toFixed(1) : null,
      avgMs: h.gov.state().avgMs,
      winP95Ms: h.gov.state().winP95Ms,
      winMaxMs: h.gov.state().winMaxMs,
      endTier: h.gov.tier,
    }
  }

  function p95Only() {
    const h = harness()
    h.feed(BASELINE_MS, SETTLE_FRAMES)
    const from = h.writes.length
    const f0 = h.frame()
    for (let w = 0; w < 40; w++) { h.feed(16.0, 28); h.feed(20, 2) }
    const first = h.pending(from)[0]
    return { steps: h.pending(from).length, firstFrames: first ? first.frame - f0 : null, avgMs: h.gov.state().avgMs, winP95Ms: h.gov.state().winP95Ms }
  }
  const p95Arm = p95Only()

  const train100 = train(HITCH_MS)
  let minVisibleHitchMs = null
  for (let hitchMs = 1; hitchMs <= 400 && minVisibleHitchMs === null; hitchMs++) if (train(hitchMs).steps > 0) minVisibleHitchMs = hitchMs
  const trainVisible = minVisibleHitchMs === null ? null : train(minVisibleHitchMs)
  let singleMinHitchMs = null
  for (let hitchMs = 1; hitchMs <= 400 && singleMinHitchMs === null; hitchMs++) if (singleHitch(hitchMs).steps > 0) singleMinHitchMs = hitchMs

  console.log(`[${LABEL}] control ${jsonLine({ budgetMs: FRAME_BUDGET_MS, lowerAboveMs: LOWER_ABOVE_MS, raiseBelowMs: RAISE_BELOW_MS, hitchAboveMs: HITCH_ABOVE_MS, hitchStepIntervalMs: HITCH_STEP_INTERVAL_MS, sustained, hitch, hitch100, minBurstFrames, p95Arm, train100, minVisibleHitchMs, trainVisible, singleMinHitchMs })}`)

  for (const spikeMs of [17.7, 25, 33.34]) {
    expect(`control: a ${spikeMs}ms sustained spike stays on the window path and takes 60 frames`, sustained[spikeMs] && sustained[spikeMs].frames, '==', 60)
    expect(`control: that ${spikeMs}ms spike is answered after at least one second`, sustained[spikeMs] && sustained[spikeMs].ms, '>=', MIN_STEP_INTERVAL_MS)
  }
  expect('control: a 50ms sustained spike is above hitchAboveMs and is caught by the latch', sustained[50] && sustained[50].frames, '<=', HITCH_RESPONSE_BOUND_FRAMES)
  expect('control: the latch answer does not wait for the window-driven one-second floor', sustained[50] && sustained[50].ms, '<', MIN_STEP_INTERVAL_MS)

  for (const hitchMs of [50, 100, 200]) {
    expect(`control: a single ${hitchMs}ms hitch produces a governor write`, hitch[hitchMs], '>', 0)
  }
  expect('control: a single 100ms hitch is answered inside the response bound', hitch100.frames, '<=', HITCH_RESPONSE_BOUND_FRAMES)
  expect('control: a single 100ms hitch is answered on the frame it lands', hitch100.frames, '==', 1)
  expect('control: the shortest over-budget burst that trips the governor is 1 frame', minBurstFrames, '==', 1)
  expect('control: one 100ms hitch per 30-frame window is now answered', train100.steps, '>', 0)
  expect('control: that train sheds once per tier and never raises back', train100.steps, '==', MAX_TIER * 6)
  expect('control: that train ends at the ladder floor', train100.endTier, '==', MAX_TIER)
  expect('control: a load whose mean sits in the dead band but whose p95 is over budget is caught', p95Arm.steps, '>', 0)
  expect('control: that p95-only load reads as in-band on the mean', p95Arm.avgMs, '<', LOWER_ABOVE_MS)
  expect('control: the p95 that caught it is over the budget', p95Arm.winP95Ms, '>', LOWER_ABOVE_MS)
  expect('control: a 20ms frame is below hitchAboveMs, so only the window path can see it', 20, '<', HITCH_ABOVE_MS)
  expect('control: that hitch train still reads as headroom on the mean', train100.avgMs, '<', RAISE_BELOW_MS)
  expect('control: the window p95 does not hide the hitch either', train100.winP95Ms, '<', RAISE_BELOW_MS)
  expect('control: the window max records the hitch the mean hides', train100.winMaxMs, '>=', HITCH_MS)
  expect('control: the smallest hitch the governor can see at all is 34ms', minVisibleHitchMs, '==', 34)
  expect('control: a 33ms hitch per window stays invisible to the latch', train(33).steps, '==', 0)
  expect('control: a visible hitch train is answered inside the response bound', trainVisible.firstFrames, '<=', HITCH_RESPONSE_BOUND_FRAMES)
  expect('control: the smallest single hitch that produces any action is 34ms', singleMinHitchMs, '==', 34)
  expect('control: a 33ms single hitch produces no action', singleHitch(33).steps, '==', 0)
  expect('control: the governor never writes a resolution key', resolutionWrites.length, '==', 0)
  return { sustained, hitch, hitch100, minBurstFrames, train100, minVisibleHitchMs, trainVisible, singleMinHitchMs }
}

function main() {
  const enableBit = enableBitArm()
  const control = responseArm()
  const failed = checks.filter(c => !c.pass)
  for (const c of failed) console.log(`[${LABEL}] FAILED ${c.label}: got ${JSON.stringify(c.got)} ${c.op} ${JSON.stringify(c.want)}`)
  console.log(`[${LABEL}] checks ${checks.length - failed.length}/${checks.length} passed`)
  console.log(`[${LABEL}] summary qualityGovernor registry default ${enableBit.bootDefault} (opt-out default ${enableBit.bootDefaultOff}): a 40ms load moved the governor at frame ${enableBit.shippedMovedAt} and took ${enableBit.shippedSteps} step(s); pinned by qualityGovernorOff it took ${enableBit.optedOutSteps}. single 100ms hitch answered after ${control.hitch100.frames} frames, min trigger ${control.minBurstFrames} frame(s), 100ms hitch train ${control.train100.steps} step(s) (mean reads ${control.train100.avgMs}ms < raiseBelow ${RAISE_BELOW_MS}ms, window max ${control.train100.winMaxMs}ms), smallest visible hitch ${control.minVisibleHitchMs}ms answered after ${control.trainVisible.firstFrames} frames, smallest single hitch ${control.singleMinHitchMs}ms, ${resolutionWrites.length} resolution key(s) written`)
  finish(failed.length === 0 ? 'PASS' : 'FAIL', failed.length === 0
    ? `${checks.length - failed.length}/${checks.length} check(s) passed`
    : `${failed.length} check(s) failed`)
}

main()
