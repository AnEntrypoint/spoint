import { RenderControls } from './RenderControls.js'

export const FRAME_BUDGET_MS = 16.67
const DEAD_BAND_UPPER_MS = 1.0
const DEAD_BAND_LOWER_MS = 3.0
export const LOWER_ABOVE_MS = FRAME_BUDGET_MS + DEAD_BAND_UPPER_MS
export const RAISE_BELOW_MS = FRAME_BUDGET_MS - DEAD_BAND_LOWER_MS
const FRAMES_PER_WINDOW = 30
const WINDOWS_BEFORE_STEP = 2
export const MIN_STEP_INTERVAL_MS = 1000
// Recovery used to share the shed path's 1000ms floor, so a tier shed in 200ms took >=1000ms to
// come back -- a 5:1 ratchet that only ever walked down. Raising is gated on 2 clean 30-frame
// windows anyway, so the interval is what decides how fast a recovered frame budget is given back.
export const RECOVER_STEP_INTERVAL_MS = 400
export const HITCH_ABOVE_MS = 2 * FRAME_BUDGET_MS
// 200ms let the latch shed a full tier every 12 frames at 60Hz: a single dropped frame on every
// other tick walked the ladder to the floor while nothing on screen said why. 500ms still answers
// a sustained stall inside 2 windows but leaves the ladder legible.
export const HITCH_STEP_INTERVAL_MS = 500
export const HITCH_RESPONSE_BOUND_FRAMES = 1
const WINDOW_P95_Q = 0.95

// The per-frame latch only sees a frame above HITCH_ABOVE_MS (2 x budget), so a SUSTAINED overrun
// in the 17.67-33.34ms band -- the load a player feels as the game running badly rather than as one
// discrete hitch -- was answered only by the 30-frame mean: 2 windows + MIN_STEP_INTERVAL_MS,
// measured 60 frames / 1062-2000ms. Lowering hitchAboveMs to the budget instead would make every
// frame marginally over budget trip the latch and the ladder would oscillate, so the band is
// governed by a COUNT: a frame over EXCURSION_ABOVE_MS is one excursion, and EXCURSION_TRIP_COUNT
// of the last EXCURSION_WINDOW_FRAMES frames must be excursions before a tier is shed. One
// over-budget frame is one excursion out of 12 and can never reach the count, so a spike does not
// shed; a sustained overrun reaches it inside EXCURSION_TRIP_COUNT frames.
export const EXCURSION_ABOVE_MS = LOWER_ABOVE_MS
export const EXCURSION_WINDOW_FRAMES = 12
export const EXCURSION_TRIP_COUNT = 8

// vegLeafOff is a DISTANCE, not a boolean: leaf meshes are dropped at or beyond it, so the near
// range (including 0m) keeps its foliage at every tier. 0 means "no cutoff".
export const LEAF_OFF_UNLIMITED_M = 0

export const RESOLUTION_KEYS = new Set([
  'dprAuto', 'dprOff', 'dpr', 'vdrsAuto', 'vdrsOff', 'vdrs', 'vdrsScale',
  'terrainVdrs', 'threeVdrs', 'threeVdrsScale', 'threeVdrsAuto', 'threeVdrsOff',
  'threeVdrsState', 'threeVdrsSharpness', 'fsr1', 'fsr1Sharpness',
  'vdrsUpscaleFsr1', 'vdrsUpscaleFsr1Sharpness', 'halfResWater',
  'bloomResolutionScale',
])

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
  { key: 'vegLeafOff', type: 'number',
    consumer: 'client/core/Vegetation.js (per-frame loop inside update(): rec.branch.setLeafDrawDistance(leafCutoffM(window.__vegLeafOff)), gated per instance inside WebGPULodInstancer.js mirrorTier)',
    enableBit: 'live per-frame read; metres at/beyond which leaf meshes stop drawing. Near trees keep their leaves at every tier; the trunk/branch mesh and the shared impostor are untouched, so nothing gains a no-mesh band.' },
  { key: 'maxLevel', type: 'number',
    consumer: 'packages/mapspinner/src/tsl/planet-tsl.js:162-163 (writeQuads, clamped [2,22]); packages/mapspinner/src/planet-orchestrator.js:196-197 (frame())',
    enableBit: 'live per-frame read; an explicit value also disables the altitude deck cap and high-altitude LOD drop in planet-orchestrator.js:205-207, so the governor clamps it below the booted value instead of raising it.' },
  { key: 'splitFactor', type: 'number',
    consumer: 'packages/mapspinner/src/tsl/planet-tsl.js:159-160 (writeQuads, floored at 0.05); packages/mapspinner/src/planet-orchestrator.js (frame())',
    enableBit: 'live per-frame read. Smaller = quads split only when nearer the camera = coarser mesh = cheaper, so the governor only ever lowers it.' },
]

// vegLeafOff is a leaf-mesh cutoff in metres, shrinking as the tier deepens. Tier 3 used to be a
// global boolean that stripped the foliage off every tree including the one at 0m while maxLevel
// only moved 10 -> 9; the ladder below drops leaves from the OUTSIDE of the mesh band inward.
//
// The cutoff is "no leaf meshes at or beyond N metres", and Vegetation.js draws leaf meshes in
// three bands -- near 0-D1, mid D1-D2, far D2-FAR_LOD_SWAP -- handing everything past
// FAR_LOD_SWAP to the shared impostor, whose baked atlas already carries foliage. D1/D2 cap at
// 14/35 m and LOD_HYS is 0.12, so the mid band ends at 39.2 m: a cutoff inside it reads on screen
// as "medium distance trees have no foliage". Every rung therefore sits AT OR BEYOND that edge and
// sheds only the outer mesh band; Vegetation.js re-floors the value there as well, so no knob
// setting can reach into the mid band.
export const LEAF_OFF_MID_BAND_EDGE_M = 39.2
export const QUALITY_TIERS = [
  { maxLevel: 11, splitFactor: 0.25, vegLeafOff: 0 },
  { maxLevel: 11, splitFactor: 0.25, vegLeafOff: 0 },
  { maxLevel: 10, splitFactor: 0.20, vegLeafOff: 0 },
  { maxLevel: 9, splitFactor: 0.15, vegLeafOff: 45 },
  { maxLevel: 8, splitFactor: 0.10, vegLeafOff: 42 },
  { maxLevel: 7, splitFactor: 0.07, vegLeafOff: 40 },
]
export const MAX_TIER = QUALITY_TIERS.length - 1
const EFFECT_KEYS = ['ssao', 'bloom', 'ssr']

// One parse boundary for the leaf cutoff: metres at/beyond which leaf meshes stop drawing.
// 0 (and every non-number, and every non-finite or negative number) means "no cutoff", so a bad
// or legacy boolean value can never turn into a 1m cutoff that strips the tree you are standing on.
export function leafCutoffM(v) {
  if (typeof v !== 'number') return LEAF_OFF_UNLIMITED_M
  if (!Number.isFinite(v) || v <= 0) return LEAF_OFF_UNLIMITED_M
  return v
}

// The consumer-side floor, applied where the band edges live: Vegetation.js owns D1/D2/LOD_HYS and
// passes the mid band's far edge in, so a cutoff that would strip foliage inside that band is
// floored to it instead of applied. 0 stays 0 -- no cutoff is not a cutoff to be raised.
export function leafGateM(v, midBandEdgeM = LEAF_OFF_MID_BAND_EDGE_M) {
  const c = leafCutoffM(v)
  if (c <= 0) return LEAF_OFF_UNLIMITED_M
  const floor = Number.isFinite(midBandEdgeM) && midBandEdgeM > 0 ? midBandEdgeM : LEAF_OFF_MID_BAND_EDGE_M
  return Math.max(c, floor)
}

// The governor only ever degrades: two cutoffs combine to the SMALLER positive one, and an absent
// cutoff never wins against a real one in either direction.
function _cutoffMin(a, b) {
  if (a > 0 && b > 0) return Math.min(a, b)
  return a > 0 ? a : b
}

function _num(v, fallback) { return Number.isFinite(v) ? v : fallback }

function _windowPct(buf, n, q) {
  const view = buf.subarray(0, n)
  view.sort()
  return view[Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))]
}

const _declared = k => RenderControls.controls.find(c => c.key === k) || {}
const _declaredDefault = k => { const d = _declared(k).default; return typeof d === 'number' ? d : 0 }
function _inDeclaredRange(k, v) {
  const c = _declared(k)
  return Math.max(c.min == null ? -Infinity : c.min, Math.min(c.max == null ? Infinity : c.max, v))
}

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
  const windowMs = new Float64Array(FRAMES_PER_WINDOW)
  let slowStreak = 0, fastStreak = 0
  let lastStepMs = clock() - MIN_STEP_INTERVAL_MS
  let steps = 0
  let avgMs = 0
  let winMaxMs = 0
  let winOverruns = 0
  let lastWinMaxMs = 0, lastWinP95Ms = 0
  let overrunMs = 0
  let framesSinceOverrun = HITCH_RESPONSE_BOUND_FRAMES
  const excursionRing = new Uint8Array(EXCURSION_WINDOW_FRAMES)
  let excursionAt = 0
  let excursions = 0
  // Which path took the last step, so the debug panel can name it. Without this a shed in the
  // 17.67-33.34ms band reads as "the 30-frame window", which is the one path that did NOT act.
  let shedCause = 'none'
  let shedExcursions = 0
  const applied = {}

  function captureBase() {
    base = {
      maxLevel: _inDeclaredRange('maxLevel', _num(read('maxLevel'), _declaredDefault('maxLevel'))),
      splitFactor: _inDeclaredRange('splitFactor', _num(read('splitFactor'), _declaredDefault('splitFactor'))),
      vegLeafOff: leafCutoffM(read('vegLeafOff')),
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
      maxLevel: _inDeclaredRange('maxLevel', Math.min(base.maxLevel, t.maxLevel)),
      splitFactor: _inDeclaredRange('splitFactor', Math.min(base.splitFactor, t.splitFactor)),
      vegLeafOff: _cutoffMin(base.vegLeafOff, leafCutoffM(t.vegLeafOff)),
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

  const state = { tier: 0, maxTier: MAX_TIER, avgMs: 0, winMaxMs: 0, winP95Ms: 0, overrunMs: 0, excursions: 0, excursionWindowFrames: EXCURSION_WINDOW_FRAMES, excursionTripCount: EXCURSION_TRIP_COUNT, excursionAboveMs: EXCURSION_ABOVE_MS, shedCause: 'none', shedExcursions: 0, budgetMs: FRAME_BUDGET_MS, lowerAboveMs: LOWER_ABOVE_MS, raiseBelowMs: RAISE_BELOW_MS, hitchAboveMs: HITCH_ABOVE_MS, hitchStepIntervalMs: HITCH_STEP_INTERVAL_MS, recoverStepIntervalMs: RECOVER_STEP_INTERVAL_MS, minStepIntervalMs: MIN_STEP_INTERVAL_MS, responseBoundFrames: HITCH_RESPONSE_BOUND_FRAMES, steps: 0, lastStepMs: 0, inBand: false, atCeiling: true, atFloor: false, leafOffM: 0, knobs: null }

  function publish() {
    state.tier = tier
    state.avgMs = +avgMs.toFixed(3)
    state.winMaxMs = +lastWinMaxMs.toFixed(3)
    state.winP95Ms = +lastWinP95Ms.toFixed(3)
    state.overrunMs = +overrunMs.toFixed(3)
    state.excursions = excursions
    state.shedCause = shedCause
    state.shedExcursions = shedExcursions
    state.steps = steps
    state.lastStepMs = lastStepMs
    state.inBand = n === 0 && avgMs > 0 ? avgMs >= RAISE_BELOW_MS && avgMs <= LOWER_ABOVE_MS && lastWinP95Ms <= LOWER_ABOVE_MS : false
    state.atCeiling = tier === 0
    state.atFloor = tier === MAX_TIER
    state.leafOffM = leafCutoffM(applied.vegLeafOff)
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
    const nowMs = clock()

    const excursion = ms > EXCURSION_ABOVE_MS ? 1 : 0
    excursions += excursion - excursionRing[excursionAt]
    excursionRing[excursionAt] = excursion
    excursionAt = (excursionAt + 1) % EXCURSION_WINDOW_FRAMES

    if (ms > HITCH_ABOVE_MS) { overrunMs = ms; winOverruns++; framesSinceOverrun = 0 }
    else if (framesSinceOverrun < HITCH_RESPONSE_BOUND_FRAMES) {
      framesSinceOverrun++
      if (framesSinceOverrun >= HITCH_RESPONSE_BOUND_FRAMES) overrunMs = 0
    }
    windowMs[n] = ms
    if (ms > winMaxMs) winMaxMs = ms
    acc += ms; n++

    if ((framesSinceOverrun < HITCH_RESPONSE_BOUND_FRAMES || excursions >= EXCURSION_TRIP_COUNT)
      && nowMs - lastStepMs >= HITCH_STEP_INTERVAL_MS) {
      const byHitch = framesSinceOverrun < HITCH_RESPONSE_BOUND_FRAMES
      if (step(+1, nowMs)) {
        shedCause = byHitch ? 'hitch' : 'excursion'
        shedExcursions = byHitch ? 0 : excursions
        overrunMs = 0
        framesSinceOverrun = HITCH_RESPONSE_BOUND_FRAMES
        excursionRing.fill(0)
        excursionAt = 0
        excursions = 0
        slowStreak = 0
        fastStreak = 0
      }
    }

    if (n < FRAMES_PER_WINDOW) return tier
    avgMs = acc / n
    lastWinMaxMs = winMaxMs
    lastWinP95Ms = _windowPct(windowMs, n, WINDOW_P95_Q)
    const overruns = winOverruns
    acc = 0; n = 0; winMaxMs = 0; winOverruns = 0

    if (avgMs > LOWER_ABOVE_MS || lastWinP95Ms > LOWER_ABOVE_MS) { slowStreak++; fastStreak = 0 }
    else if (avgMs < RAISE_BELOW_MS && lastWinP95Ms < RAISE_BELOW_MS && overruns === 0) { fastStreak++; slowStreak = 0 }
    else { slowStreak = 0; fastStreak = 0 }
    if (slowStreak >= WINDOWS_BEFORE_STEP) {
      if (nowMs - lastStepMs >= MIN_STEP_INTERVAL_MS && step(+1, nowMs)) { shedCause = 'window'; shedExcursions = 0; slowStreak = 0 }
    } else if (fastStreak >= WINDOWS_BEFORE_STEP) {
      if (nowMs - lastStepMs >= RECOVER_STEP_INTERVAL_MS && step(-1, nowMs)) { shedCause = 'none'; shedExcursions = 0; fastStreak = 0 }
    }
    publish()
    return tier
  }

  function setTier(i) { if (base) apply(Math.max(0, Math.min(MAX_TIER, i | 0))); publish(); return tier }
  function reset() {
    base = null; tier = 0; acc = 0; n = 0
    slowStreak = 0; fastStreak = 0; steps = 0; avgMs = 0
    winMaxMs = 0; winOverruns = 0; lastWinMaxMs = 0; lastWinP95Ms = 0
    overrunMs = 0; framesSinceOverrun = HITCH_RESPONSE_BOUND_FRAMES
    excursionRing.fill(0); excursionAt = 0; excursions = 0
    shedCause = 'none'; shedExcursions = 0
    lastStepMs = clock() - MIN_STEP_INTERVAL_MS
  }
  function snapshot() { return publish() }

  const api = { tick, setTier, reset, state: snapshot, base: () => (base ? { ...base } : null), get tier() { return tier } }
  if (typeof window !== 'undefined') window.__qualityGovernorApi = api
  return api
}
