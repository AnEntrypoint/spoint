#!/usr/bin/env node
import {
  createQualityGovernor, FRAME_BUDGET_MS, LOWER_ABOVE_MS, RAISE_BELOW_MS, MIN_STEP_INTERVAL_MS,
} from '../client/core/QualityGovernor.js'
import { RenderControls } from '../client/core/RenderControls.js'

const LABEL = 'governor-hitch-response-witness'
const LF = String.fromCharCode(10)

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
const BASELINE_MS = 8
const SETTLE_FRAMES = 210
const SPIKE_MS = 40

function harness() {
  const reads = new Map([
    ['maxLevel', 20], ['splitFactor', 1.2], ['vegLeafOff', false],
    ['ssao', true], ['bloom', true], ['ssr', true],
  ])
  const writes = []
  let simNow = 0
  let frame = 0
  const gov = createQualityGovernor({
    enabled: () => true,
    now: () => simNow,
    read: (k) => reads.get(k),
    write: (k, v) => { writes.push({ frame, ms: simNow, key: k, value: v }); reads.set(k, v) },
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
  let simNow = 0
  const feedUntilTierMoves = (gov, ms, frames) => {
    for (let i = 0; i < frames; i++) { simNow += ms; gov.tick(ms); if (gov.tier > 0) return i + 1 }
    return null
  }

  const shipped = createQualityGovernor({ now: () => simNow })
  const shippedFrames = feedUntilTierMoves(shipped, SPIKE_MS, 600)
  const shippedSteps = shipped.state().steps

  const woken = createQualityGovernor({ enabled: () => true, now: () => simNow })
  const wokenFrames = feedUntilTierMoves(woken, SPIKE_MS, 600)
  const wokenTier = woken.tier
  const wokenKnobs = woken.state().knobs
  const wokenBase = woken.base()

  console.log(`[${LABEL}] enable-bit ${jsonLine({ bootDefault, bootDefaultOff, shippedFrames, shippedTier: shipped.tier, shippedSteps, wokenFrames, wokenTier, wokenKnobs, wokenBase })}`)

  expect('enable-bit: the registry default of qualityGovernor is false', bootDefault, '==', false)
  expect('enable-bit: the registry default of qualityGovernorOff is false', bootDefaultOff, '==', false)
  expect('enable-bit: with the shipped defaults a 40ms load never moves the governor', shippedFrames, '==', null)
  expect('enable-bit: with the shipped defaults the tier stays at the booted snapshot', shipped.tier, '==', 0)
  expect('enable-bit: with the shipped defaults it takes zero steps', shippedSteps, '==', 0)
  expect('enable-bit: forcing the enable bit on is what wakes it', wokenFrames, '>', 0)
  expect('enable-bit: once woken it still needs 60 frames', wokenFrames, '==', 60)
  expect('enable-bit: on the shipped defaults the first shed step writes the booted values back unchanged', JSON.stringify(wokenKnobs), '==', JSON.stringify(wokenBase))
  return { bootDefault, shippedFrames, shippedSteps, wokenFrames, wokenTier }
}

function responseArm() {
  const sustained = {}
  for (const spikeMs of [17.7, 25, 33.34, 50]) {
    const h = harness()
    h.feed(BASELINE_MS, SETTLE_FRAMES)
    const from = h.writes.length
    const ms0 = h.now()
    const f0 = h.frame()
    h.feed(spikeMs, 400)
    const first = h.pending(from)[0]
    sustained[spikeMs] = first ? { frames: first.frame - f0, ms: +(first.ms - ms0).toFixed(1) } : null
  }

  const hitch = {}
  for (const hitchMs of [50, 100, 200]) {
    const h = harness()
    h.feed(BASELINE_MS, SETTLE_FRAMES)
    const from = h.writes.length
    h.feed(hitchMs, 1)
    h.feed(BASELINE_MS, 600)
    hitch[hitchMs] = h.pending(from).length
  }

  function burstTrips(k) {
    const h = harness()
    h.feed(BASELINE_MS, SETTLE_FRAMES)
    const from = h.writes.length
    h.feed(SPIKE_MS, k)
    h.feed(BASELINE_MS, 900)
    return h.pending(from).length > 0
  }
  let minBurstFrames = null
  for (let k = 1; k <= 80 && minBurstFrames === null; k++) if (burstTrips(k)) minBurstFrames = k

  function train(hitchMs, windows = 60) {
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
    }
  }

  const train100 = train(100)
  let minVisibleHitchMs = null
  for (let hitchMs = 50; hitchMs <= 400 && minVisibleHitchMs === null; hitchMs++) if (train(hitchMs).steps > 0) minVisibleHitchMs = hitchMs
  const trainVisible = minVisibleHitchMs === null ? null : train(minVisibleHitchMs)

  console.log(`[${LABEL}] control ${jsonLine({ budgetMs: FRAME_BUDGET_MS, lowerAboveMs: LOWER_ABOVE_MS, raiseBelowMs: RAISE_BELOW_MS, sustained, hitch, minBurstFrames, train100, minVisibleHitchMs, trainVisible })}`)

  for (const spikeMs of Object.keys(sustained)) {
    expect(`control: a ${spikeMs}ms sustained spike takes 60 frames to move the governor`, sustained[spikeMs] && sustained[spikeMs].frames, '==', 60)
    expect(`control: that ${spikeMs}ms spike is answered after at least one second`, sustained[spikeMs] && sustained[spikeMs].ms, '>=', MIN_STEP_INTERVAL_MS)
  }
  expect('control: a single 50ms hitch produces no governor write', hitch[50], '==', 0)
  expect('control: a single 100ms hitch produces no governor write', hitch[100], '==', 0)
  expect('control: a single 200ms hitch produces no governor write', hitch[200], '==', 0)
  expect('control: the shortest over-budget burst that trips the governor is 40 frames', minBurstFrames, '==', 40)
  expect('control: a 39-frame burst does not trip it', burstTrips(39), '==', false)
  expect('control: one 100ms hitch per 30-frame window is never answered', train100.steps, '==', 0)
  expect('control: that hitch train is reported as headroom, below raiseBelowMs', train100.avgMs, '<', RAISE_BELOW_MS)
  expect('control: the smallest hitch the governor can see at all is 299ms', minVisibleHitchMs, '==', 299)
  expect('control: a 298ms hitch per window stays invisible', train(298).steps, '==', 0)
  expect('control: a visible hitch train is still answered only after 60 frames', trainVisible.firstFrames, '==', 60)
  expect('control: the 100ms train hides a 100ms frame behind a 11ms reading', train100.avgMs, '<', 12)
  return { sustained, hitch, minBurstFrames, train100, minVisibleHitchMs, trainVisible }
}

function main() {
  const enableBit = enableBitArm()
  const control = responseArm()
  const failed = checks.filter(c => !c.pass)
  for (const c of failed) console.log(`[${LABEL}] FAILED ${c.label}: got ${JSON.stringify(c.got)} ${c.op} ${JSON.stringify(c.want)}`)
  console.log(`[${LABEL}] checks ${checks.length - failed.length}/${checks.length} passed`)
  finish(failed.length === 0 ? 'PASS' : 'FAIL', failed.length === 0
    ? `qualityGovernor registry default ${enableBit.bootDefault}: a 40ms load produced ${enableBit.shippedSteps} steps and never left tier 0; forced on, it moved at frame ${enableBit.wokenFrames}. min trigger ${control.minBurstFrames} frames, sustained response 60 frames, single hitch 0 steps, 100ms hitch train 0 steps (reads ${control.train100.avgMs}ms < raiseBelow ${RAISE_BELOW_MS}ms), smallest visible hitch ${control.minVisibleHitchMs}ms answered after ${control.trainVisible.firstFrames} frames`
    : `${failed.length} check(s) failed`)
}

main()
