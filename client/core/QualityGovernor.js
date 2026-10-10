import { RenderControls } from './RenderControls.js'

// Dynamic quality governor: holds the frame budget by shedding NON-RESOLUTION cost only.
// It writesRenderControls keys and never writes devicePixelRatio, canvas size, or any
// render-target size, so no pixel doubling occurs. Off unless `qualityGovernor` is set true.

export const FRAME_BUDGET_MS = 16.67
const DEAD_BAND_UPPER_MS = 1.0
const DEAD_BAND_LOWER_MS = 3.0
export const LOWER_ABOVE_MS = FRAME_BUDGET_MS + DEAD_BAND_UPPER_MS
export const RAISE_BELOW_MS = FRAME_BUDGET_MS - DEAD_BAND_LOWER_MS
const FRAMES_PER_WINDOW = 30
const WINDOWS_BEFORE_STEP = 2
export const MIN_STEP_INTERVAL_MS = 1000

// Resolution keys the governor is FORBIDDEN to write. Present so a future edit that adds one
// to QUALITY_TIERS fails loudly at construction instead of silently rescaling the frame.
export const RESOLUTION_KEYS = new Set([
  'dprAuto', 'dprOff', 'dpr', 'vdrsAuto', 'vdrsOff', 'vdrs', 'vdrsScale',
  'terrainVdrs', 'threeVdrs', 'threeVdrsScale', 'threeVdrsAuto', 'threeVdrsOff',
  'threeVdrsState', 'threeVdrsSharpness', 'fsr1', 'fsr1Sharpness',
  'vdrsUpscaleFsr1', 'vdrsUpscaleFsr1Sharpness', 'halfResWater',
  'bloomResolutionScale',
])

// Every knob the governor drives, with its LIVE consumer and its enable bit (silent-no-op check).
export const GOVERNED_KNOBS = [
  { key: 'ssao', type: 'boolean',
    consumer: 'client/core/SSAO.js:249 (shouldRun: RenderControls.get(\'ssao\') === true && !!ctx.ssao), :260',
    enableBit: 'live per-frame render-graph node gate; false skips the pass entirely. Default false, so shedding it only bites where a preset turned it on.' },
  { key: 'bloom', type: 'boolean',
    consumer: 'client/core/Bloom.js:207, :218 (shouldRun: RenderControls.get(\'bloom\') === true && !!ctx.bloom)',
    enableBit: 'live per-frame render-graph node gate; false skips the pass entirely. Default false.' },
  { key: 'ssr', type: 'boolean',
    consumer: 'client/core/SSR.js:320 (shouldRun: RenderControls.get(\'ssr\') === true && !!ctx.ssr && RenderControls.get(\'ssao\') === true)',
    enableBit: 'live per-frame gate, additionally gated on ssao === true, so ssao:false already disables it.' },
  { key: 'vegLeafOff', type: 'boolean',
    consumer: 'client/core/Vegetation.js:666 (per-frame loop inside update(): if (window.__vegLeafOff) rec.leaf.visible = false)',
    enableBit: 'live per-frame read; hides every leaf mesh. Branches/trunks and the shared impostor stay.' },
  { key: 'maxLevel', type: 'number',
    consumer: 'packages/mapspinner/src/tsl/planet-tsl.js:162-163 (writeQuads, clamped [2,22]); packages/mapspinner/src/planet-orchestrator.js:196-197 (frame())',
    enableBit: 'live per-frame read; an explicit value also disables the altitude deck cap and high-altitude LOD drop in planet-orchestrator.js:205-207, so the governor clamps it below the booted value instead of raising it.' },
  { key: 'splitFactor', type: 'number',
    consumer: 'packages/mapspinner/src/tsl/planet-tsl.js:159-160 (writeQuads, floored at 0.05); packages/mapspinner/src/planet-orchestrator.js (frame())',
    enableBit: 'live per-frame read. Smaller = quads split only when nearer the camera = coarser mesh = cheaper, so the governor only ever lowers it.' },
]

// Tier ladder, index = tier. Tier 0 restores the booted snapshot; each higher tier is strictly
// cheaper. Numbers are ceilings: resolveTier() takes min(booted, tier) so a low-tier preset is
// never pushed to more work than it booted with.
export const QUALITY_TIERS = [
  { maxLevel: 11, splitFactor: 0.25, vegLeafOff: false },
  { maxLevel: 11, splitFactor: 0.25, vegLeafOff: false },
  { maxLevel: 10, splitFactor: 0.20, vegLeafOff: false },
  { maxLevel: 9, splitFactor: 0.15, vegLeafOff: true },
  { maxLevel: 8, splitFactor: 0.10, vegLeafOff: true },
  { maxLevel: 7, splitFactor: 0.07, vegLeafOff: true },
]
export const MAX_TIER = QUALITY_TIERS.length - 1
const EFFECT_KEYS = ['ssao', 'bloom', 'ssr']

function _num(v, fallback) { return Number.isFinite(v) ? v : fallback }

export function createQualityGovernor(opts = {}) {
  const write = typeof opts.write === 'function' ? opts.write : (k, v) => RenderControls.set(k, v)
  const read = typeof opts.read === 'function' ? opts.read : k => RenderControls.get(k)
  const clock = typeof opts.now === 'function' ? opts.now : () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
  const enabled = typeof opts.enabled === 'function' ? opts.enabled
    : () => read('qualityGovernor') === true && read('qualityGovernorOff') !== true

  for (const t of QUALITY_TIERS) {
    for (const k of Object.keys(t)) {
      if (RESOLUTION_KEYS.has(k)) throw new Error(`[quality-governor] tier table drives resolution key '${k}' -- refused`)
    }
  }
  for (const k of EFFECT_KEYS) {
    if (RESOLUTION_KEYS.has(k)) throw new Error(`[quality-governor] effect key '${k}' is a resolution key -- refused`)
  }

  let base = null
  let tier = 0
  let acc = 0, n = 0
  let slowStreak = 0, fastStreak = 0
  let lastStepMs = clock()
  let steps = 0
  let avgMs = 0
  const applied = {}

  function captureBase() {
    base = {
      maxLevel: Math.max(2, Math.min(22, _num(read('maxLevel'), 11))),
      splitFactor: Math.max(0.05, _num(read('splitFactor'), 0.25)),
      vegLeafOff: read('vegLeafOff') === true,
      ssao: read('ssao') === true,
      bloom: read('bloom') === true,
      ssr: read('ssr') === true,
    }
  }

  function resolveTier(i) {
    if (!base) captureBase()
    if (i <= 0) return { maxLevel: base.maxLevel, splitFactor: base.splitFactor, vegLeafOff: base.vegLeafOff, ssao: base.ssao, bloom: base.bloom, ssr: base.ssr }
    const t = QUALITY_TIERS[Math.min(MAX_TIER, i)]
    const out = {
      maxLevel: Math.max(2, Math.min(22, Math.min(base.maxLevel, t.maxLevel))),
      splitFactor: Math.max(0.05, Math.min(base.splitFactor, t.splitFactor)),
      vegLeafOff: base.vegLeafOff || t.vegLeafOff,
    }
    for (const k of EFFECT_KEYS) out[k] = false
    return out
  }

  function apply(i) {
    const want = resolveTier(i)
    for (const k of Object.keys(want)) {
      if (RESOLUTION_KEYS.has(k)) throw new Error(`[quality-governor] refused to write resolution key '${k}'`)
      applied[k] = want[k]
      write(k, want[k])
    }
    tier = Math.max(0, Math.min(MAX_TIER, i))
    return want
  }

  const state = { tier: 0, maxTier: MAX_TIER, avgMs: 0, budgetMs: FRAME_BUDGET_MS, lowerAboveMs: LOWER_ABOVE_MS, raiseBelowMs: RAISE_BELOW_MS, steps: 0, lastStepMs: 0, inBand: false, atCeiling: true, atFloor: false, knobs: null }

  function publish() {
    state.tier = tier
    state.avgMs = +avgMs.toFixed(3)
    state.steps = steps
    state.lastStepMs = lastStepMs
    state.inBand = n === 0 && avgMs > 0 ? avgMs >= RAISE_BELOW_MS && avgMs <= LOWER_ABOVE_MS : false
    state.atCeiling = tier === 0
    state.atFloor = tier === MAX_TIER
    state.knobs = { ...applied }
    if (typeof window !== 'undefined') window.__qualityGovernorState = state
    write('qualityGovernorState', state)
    return state
  }

  function step(dir, nowMs) {
    const next = Math.max(0, Math.min(MAX_TIER, tier + dir))
    if (next === tier) return false
    apply(next)
    lastStepMs = nowMs
    steps++
    return true
  }

  function tick(ms) {
    if (!enabled()) return tier
    if (!Number.isFinite(ms) || ms < 0) return tier
    if (!base) { captureBase(); apply(0) }
    acc += ms; n++
    if (n < FRAMES_PER_WINDOW) return tier
    avgMs = acc / n; acc = 0; n = 0
    const nowMs = clock()
    if (avgMs > LOWER_ABOVE_MS) { slowStreak++; fastStreak = 0 }
    else if (avgMs < RAISE_BELOW_MS) { fastStreak++; slowStreak = 0 }
    else { slowStreak = 0; fastStreak = 0 }
    if (slowStreak >= WINDOWS_BEFORE_STEP) {
      if (nowMs - lastStepMs >= MIN_STEP_INTERVAL_MS && step(+1, nowMs)) slowStreak = 0
    } else if (fastStreak >= WINDOWS_BEFORE_STEP) {
      if (nowMs - lastStepMs >= MIN_STEP_INTERVAL_MS && step(-1, nowMs)) fastStreak = 0
    }
    publish()
    return tier
  }

  function setTier(i) { if (base) apply(Math.max(0, Math.min(MAX_TIER, i | 0))); publish(); return tier }
  function reset() { base = null; tier = 0; acc = 0; n = 0; slowStreak = 0; fastStreak = 0; steps = 0; avgMs = 0; lastStepMs = clock() }
  function snapshot() { return publish() }

  const api = { tick, setTier, reset, state: snapshot, base: () => (base ? { ...base } : null), get tier() { return tier } }
  if (typeof window !== 'undefined') window.__qualityGovernor = api
  return api
}
