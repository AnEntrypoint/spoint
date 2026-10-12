#!/usr/bin/env node
// quality-governor-tier-ladder-witness
//
// WHAT IT MEASURES: the real client/core/QualityGovernor.js control law, driven in Node with an
// injected clock, an injected read map and a write sink, from a load that exceeds the frame
// budget. Every assertion is a count: tier steps taken, knob writes issued, distinct keys
// written, ladder position held.
//
// WHAT IT DOES NOT MEASURE: no frame is rendered, no frame is timed on a GPU, and this witness
// cannot say the live page converges inside the budget. The browser arm of
// quality-governor-witness.mjs is the one that measures real frame time; this is the arm that
// measures what the governor does with a frame time once it has one.
//
// Distinct from governor-hitch-response-witness.mjs, which pins the hitch latch: its response
// bound, the smallest visible hitch, the p95 path and the enable bit. This witness pins the
// sustained-load behaviour that witness does not reach: convergence and recovery, the dead band
// held flat, resistance to an alternating slow/fast load, the one-step-per-second bound over the
// whole overload, ladder clamps on every write, effects-before-geometry ordering and the refusal
// to raise cost above the booted snapshot.
import {
  createQualityGovernor, QUALITY_TIERS, MAX_TIER, GOVERNED_KNOBS, RESOLUTION_KEYS,
  FRAME_BUDGET_MS, LOWER_ABOVE_MS, RAISE_BELOW_MS, MIN_STEP_INTERVAL_MS,
} from '../client/core/QualityGovernor.js'

const LABEL = 'quality-governor-tier-ladder'

const CONTROL_FRAMES = 2010
const RECOVER_FRAMES = 2010
const BAND_FRAMES = 900
const FLIP_WINDOWS = 20
const FLIP_WINDOW_FRAMES = 30
const OVERLOAD_MS = 40
const RECOVER_MS = 8
const BAND_MS = 16.0
const FLIP_SLOW_MS = 25
const FLIP_FAST_MS = 8
const BOOT_MAX_LEVEL = 20
const BOOT_SPLIT_FACTOR = 1.2
const MIN_TIER = 1

function flag(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? dflt : hit.slice(name.length + 3)
}
const MUTATE = flag('mutate', 'none')
const KNOWN_MUTATIONS = new Set(['none', 'flat-load', 'band-outside', 'flip-sustained'])
if (!KNOWN_MUTATIONS.has(MUTATE)) {
  console.log(`RESULT: FAIL ${LABEL} -- --mutate=${MUTATE} is not one of ${[...KNOWN_MUTATIONS].join(', ')}`)
  process.exit(1)
}

const LINES = []
const say = (...s) => { const line = s.join(' '); LINES.push(line); process.stdout.write(line + '\n') }
const failures = []
function expect(ok, detail) {
  if (!ok) failures.push(detail)
  say((ok ? 'PASS ' : 'FAIL ') + detail)
  return ok
}

const GOVERNED_KEYS = GOVERNED_KNOBS.map((k) => k.key)
const PERMITTED_KEYS = new Set([...GOVERNED_KEYS, 'qualityGovernorState'])

const reads = new Map([
  ['maxLevel', BOOT_MAX_LEVEL], ['splitFactor', BOOT_SPLIT_FACTOR], ['vegLeafOff', false],
  ['ssao', true], ['bloom', true], ['ssr', true],
])
const writes = []
const resolutionWrites = []
let simNow = 1000
let frame = 0
const governor = createQualityGovernor({
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

function feed(ms, frames) {
  for (let i = 0; i < frames; i++) { simNow += ms; governor.tick(ms) }
}

say(`${LABEL} witness at ${new Date().toISOString()}`)
say(`mutate=${MUTATE} budgetMs=${FRAME_BUDGET_MS} lowerAboveMs=${LOWER_ABOVE_MS} raiseBelowMs=${RAISE_BELOW_MS} ` +
  `minStepIntervalMs=${MIN_STEP_INTERVAL_MS} tiers=${QUALITY_TIERS.length}`)
say(`booted snapshot: maxLevel=${BOOT_MAX_LEVEL} splitFactor=${BOOT_SPLIT_FACTOR} ssao/bloom/ssr on`)
say('')

// phase 1: sustained overload. 'flat-load' swaps the stimulus for one inside the budget, which is
// how a witness that never actually loads the governor would read.
const overloadMs = MUTATE === 'flat-load' ? RECOVER_MS : OVERLOAD_MS
const wall0 = simNow
feed(overloadMs, CONTROL_FRAMES)
const afterOverload = { ...governor.state() }
const overloadWallMs = simNow - wall0
const effectsAfterOverload = { ssao: reads.get('ssao'), bloom: reads.get('bloom'), ssr: reads.get('ssr') }

// phase 2: headroom returns.
feed(RECOVER_MS, RECOVER_FRAMES)
const afterRecover = { ...governor.state() }

// phase 3: the dead band. 'band-outside' moves the stimulus above lowerAboveMs.
const stepsBeforeBand = governor.state().steps
feed(MUTATE === 'band-outside' ? FLIP_SLOW_MS : BAND_MS, BAND_FRAMES)
const bandSteps = governor.state().steps - stepsBeforeBand

// phase 4: alternating slow and fast windows. 'flip-sustained' makes every window slow.
const stepsBeforeFlip = governor.state().steps
for (let w = 0; w < FLIP_WINDOWS; w++) {
  feed(MUTATE === 'flip-sustained' ? FLIP_SLOW_MS : (w % 2 === 0 ? FLIP_SLOW_MS : FLIP_FAST_MS), FLIP_WINDOW_FRAMES)
}
const flipSteps = governor.state().steps - stepsBeforeFlip

const badKnob = writes.find((w) => !PERMITTED_KEYS.has(w.key))
const maxLevels = writes.filter((w) => w.key === 'maxLevel').map((w) => w.value)
const splitFactors = writes.filter((w) => w.key === 'splitFactor').map((w) => w.value)
const effectWrites = writes.filter((w) => w.key === 'ssao').length
const geometryWrites = maxLevels.length + splitFactors.length

let monotonic = true
for (let i = 1; i < maxLevels.length; i++) {
  if (maxLevels[i] > maxLevels[i - 1] && maxLevels[i - 1] > BOOT_MAX_LEVEL - 1e-9) monotonic = false
}

say(`overload ${overloadMs}ms x ${CONTROL_FRAMES} frame(s): tier ${afterOverload.tier}, ` +
  `${afterOverload.steps} step(s), ${writes.length} write(s) over ${overloadWallMs} ms of simulated clock`)
say(`recovery ${RECOVER_MS}ms x ${RECOVER_FRAMES} frame(s): tier ${afterRecover.tier}`)
say(`dead band ${MUTATE === 'band-outside' ? FLIP_SLOW_MS : BAND_MS}ms x ${BAND_FRAMES} frame(s): ${bandSteps} step(s)`)
say(`flip ${FLIP_WINDOWS} window(s) of ${FLIP_WINDOW_FRAMES} frame(s): ${flipSteps} step(s)`)
say(`writes: maxLevel ${JSON.stringify(maxLevels)} splitFactor ${JSON.stringify(splitFactors)} ` +
  `effects(written) ${effectWrites} geometry(written) ${geometryWrites}`)
say('')

expect(QUALITY_TIERS.length > 2, `the ladder has more than one shedding tier: ${QUALITY_TIERS.length} tier(s)`)
expect(afterOverload.tier >= MIN_TIER,
  `a ${overloadMs}ms sustained load shed ${afterOverload.tier} tier(s) off the booted snapshot (min ${MIN_TIER})`)
expect(afterOverload.tier <= MAX_TIER, `it stopped at tier ${afterOverload.tier} and never ran past the floor ${MAX_TIER}`)
expect(afterRecover.tier < afterOverload.tier,
  `headroom brought it back: tier ${afterOverload.tier} under load -> ${afterRecover.tier} with headroom`)
expect(afterRecover.tier === 0, `it rested at the booted snapshot: tier ${afterRecover.tier}`)
expect(bandSteps === 0,
  `${BAND_FRAMES} frame(s) at ${MUTATE === 'band-outside' ? FLIP_SLOW_MS : BAND_MS}ms took ${bandSteps} step(s), ` +
  `inside [${RAISE_BELOW_MS.toFixed(2)}, ${LOWER_ABOVE_MS.toFixed(2)}] the governor must hold`)
expect(flipSteps === 0,
  `${FLIP_WINDOWS} alternating ${FLIP_SLOW_MS}/${FLIP_FAST_MS}ms window(s) took ${flipSteps} step(s); ` +
  `no single window may accumulate a streak`)
expect(afterOverload.steps <= Math.ceil(overloadWallMs / MIN_STEP_INTERVAL_MS) + 1,
  `${afterOverload.steps} step(s) over ${overloadWallMs} ms of simulated clock, inside the 1/${MIN_STEP_INTERVAL_MS}ms bound`)
expect(resolutionWrites.length === 0,
  `no resolution key was ever written (${resolutionWrites.length} of ${writes.length} write(s))`)
expect(badKnob === undefined,
  `no ungoverned key was ever written${badKnob === undefined ? '' : `: ${badKnob.key}`}`)
expect(maxLevels.every((v) => v >= 2 && v <= 22),
  `every maxLevel write stayed in [2,22]: ${JSON.stringify(maxLevels)}`)
expect(splitFactors.every((v) => v >= 0.05),
  `every splitFactor write stayed >= 0.05: ${JSON.stringify(splitFactors)}`)
expect(maxLevels.every((v) => v <= BOOT_MAX_LEVEL),
  `maxLevel never rose above the booted load ${BOOT_MAX_LEVEL}: ${JSON.stringify(maxLevels)}`)
expect(splitFactors.every((v) => v <= BOOT_SPLIT_FACTOR + 1e-9),
  `splitFactor never rose above the booted load ${BOOT_SPLIT_FACTOR}: ${JSON.stringify(splitFactors)}`)
expect(monotonic === true,
  `successive maxLevel writes never raised cost while shedding: ${JSON.stringify(maxLevels)}`)
// The ladder is ordered effects-first: by the time it has shed any tier at all, the three effect
// knobs are off. (Write ORDER within a step is not the claim -- maxLevel is written first --
// the claim is that no tier is shed while an effect is still being paid for.)
expect(afterOverload.tier === 0 || (effectsAfterOverload.ssao === false && effectsAfterOverload.bloom === false && effectsAfterOverload.ssr === false),
  `at tier ${afterOverload.tier} the effects were off: ${JSON.stringify(effectsAfterOverload)}`)
expect(effectWrites >= 1,
  `effects were written during the run: ${effectWrites} ssao write(s) against ${geometryWrites} geometry write(s)`)

const passed = failures.length === 0
say('')
say(`RESULT: ${passed ? 'PASS' : 'FAIL'} -- ${overloadMs}ms sustained load drove tier 0 -> ${afterOverload.tier} ` +
  `in ${afterOverload.steps} step(s) and back to ${afterRecover.tier}; dead band ${bandSteps} step(s), ` +
  `alternating load ${flipSteps} step(s), ${resolutionWrites.length} resolution key(s) written, ` +
  `${effectWrites} effect write(s) and ${geometryWrites} geometry write(s)`)
process.exit(passed ? 0 : 1)
