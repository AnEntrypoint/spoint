#!/usr/bin/env node
// Witness for veg-leaf-off-is-a-distance-not-a-boolean.
//
// The tier-3 global boolean used to strip the foliage off every tree at every distance, including
// the one at 0m, while maxLevel only moved 10 -> 9 -- and nothing on screen named the cause, so a
// user met the degradation only once it was severe. This witness pins the replacement law, all in
// Node and with no GPU:
//
//   A  the parse boundary: vegLeafOff is metres, and every non-number refuses to a no-cutoff 0
//   B  the tier ladder: no cutoff through tier 2, then a strictly shrinking cutoff, always outside
//      the near band, so the near range (including 0m) keeps its leaves at every tier
//   C  the real instancer: per-band leaf counts at each tier cutoff, read off
//      client/core/WebGPULodInstancer.js -- the near band never loses a leaf and the branch counts
//      never move, so shedding foliage never widens the no-mesh band
//   D  the ratchet: shed cadence vs recover cadence after HITCH_STEP_INTERVAL_MS went 200 -> 500
//      and recovery stopped sharing the 1000ms shed floor
//   E  the user-visible cause: the render debug panel's governor line names the leaf cutoff
import * as THREE from 'three'
import { createWebGPULodInstancer } from '../client/core/WebGPULodInstancer.js'
import {
  createQualityGovernor, QUALITY_TIERS, MAX_TIER, leafCutoffM, leafGateM, LEAF_OFF_UNLIMITED_M,
  LEAF_OFF_MID_BAND_EDGE_M,
  HITCH_STEP_INTERVAL_MS, RECOVER_STEP_INTERVAL_MS, MIN_STEP_INTERVAL_MS, FRAME_BUDGET_MS,
  EXCURSION_ABOVE_MS, EXCURSION_WINDOW_FRAMES, EXCURSION_TRIP_COUNT,
} from '../client/core/QualityGovernor.js'
import { governorStatusLine, governorCauseLine, leafPhrase } from '../client/hud/RenderDebugPanel.js'

const LABEL = 'governor-leaf-ladder-witness'
const LF = String.fromCharCode(10)

// D1 (the near LOD edge) is 14m in the shipped default and its threshold carries LOD_HYS = 0.12,
// so anything past 15.68m is already outside the near band. A leaf cutoff must stay beyond it.
const NEAR_BAND_EDGE_M = 16
// D2 caps at 35m, so the MID band ends at 39.2m and the far mesh band runs from there to
// FAR_LOD_SWAP (~46m), past which the shared impostor -- whose atlas already carries foliage --
// takes over. A cutoff inside the mid band is what reads on screen as "medium distance trees have
// no foliage", so every rung has to sit at or beyond this edge.
const MID_BAND_EDGE_M = 39.2
const INSTANCE_COUNT = 96
const INSTANCE_STEP_M = 2
const TIER_KEYS = new Set(['maxLevel', 'splitFactor', 'vegLeafOff', 'ssao', 'bloom', 'ssr'])

function finish(verdict, detail) {
  console.log(`RESULT: ${verdict} label=${LABEL} -- ${String(detail).split(LF).join(' ')}`)
  process.exit(verdict === 'PASS' ? 0 : 1)
}

const num = (x) => typeof x === 'number' && Number.isFinite(x)
const OPS = {
  '==': (got, want) => Object.is(got, want),
  '<=': (got, want) => num(got) && got <= want,
  '>=': (got, want) => num(got) && got >= want,
  '>': (got, want) => num(got) && got > want,
  '<': (got, want) => num(got) && got < want,
  '!=': (got, want) => !Object.is(got, want),
}
const checks = []
function expect(label, got, op, want) {
  const pass = OPS[op](got, want) === true
  checks.push({ label, got, op, want, pass })
  return pass
}
const jsonLine = (o) => JSON.stringify(o)

// --------------------------------------------------------------- arm A: the parse boundary

function parseArm() {
  const cases = [
    [0, 0], [false, 0], [true, 0], [-1, 0], [NaN, 0], [Infinity, 0], ['45', 0], [null, 0],
    [45, 45], [12.5, 12.5], [1e999, 0],
  ]
  const got = cases.map(([v]) => leafCutoffM(v))
  const want = cases.map(([, w]) => w)
  const ok = got.every((g, i) => Object.is(g, want[i]))
  const trace = cases.map(([v, w], i) => `${String(v)}->${got[i]}${Object.is(got[i], w) ? '' : '!want ' + w}`)
  console.log(`[${LABEL}] parse ${jsonLine({ cases: trace })}`)
  expect('parse: every input resolves at the single parse boundary', ok, '==', true)
  expect('parse: the shipped no-cutoff sentinel is 0', LEAF_OFF_UNLIMITED_M, '==', 0)
  expect('parse: a legacy boolean true cannot become a 1m cutoff', leafCutoffM(true), '==', 0)
  return { got, want }
}

// --------------------------------------------------------------- arm A2: the mid-band floor

function floorArm() {
  const cases = [
    [0, 0], [false, 0], [true, 0], [-1, 0], [NaN, 0], ['20', 0],
    [20, MID_BAND_EDGE_M], [32, MID_BAND_EDGE_M], [39.2, 39.2], [40, 40], [45, 45],
  ]
  const got = cases.map(([v]) => leafGateM(v, MID_BAND_EDGE_M))
  const want = cases.map(([, w]) => w)
  console.log(`[${LABEL}] floor ${jsonLine({ edgeM: MID_BAND_EDGE_M, cases: cases.map(([v, w], i) => `${String(v)}->${got[i]}${Object.is(got[i], w) ? '' : '!want ' + w}`) })}`)
  expect('floor: every input resolves through the floor', got.every((g, i) => Object.is(g, want[i])), '==', true)
  expect('floor: a cutoff inside the mid band is floored to that band\'s far edge', leafGateM(20, MID_BAND_EDGE_M), '==', MID_BAND_EDGE_M)
  expect('floor: no cutoff is not floored into a cutoff', leafGateM(0, MID_BAND_EDGE_M), '==', 0)
  expect('floor: a cutoff beyond the band is untouched', leafGateM(45, MID_BAND_EDGE_M), '==', 45)
  expect('floor: an unusable edge falls back to the shipped one', leafGateM(20, NaN), '==', LEAF_OFF_MID_BAND_EDGE_M)
  expect('floor: with no edge argument the shipped edge applies', leafGateM(20), '>=', LEAF_OFF_MID_BAND_EDGE_M)
  // The floor is a backstop, not the thing holding the ladder up: if a rung needs rescuing the
  // ladder itself is wrong, and that has to be fixed at the table rather than papered over.
  expect('floor: every declared rung is already legal, so the floor never has to rescue one',
    QUALITY_TIERS.every(t => leafGateM(t.vegLeafOff, MID_BAND_EDGE_M) === leafCutoffM(t.vegLeafOff)), '==', true)
  return { got }
}

// --------------------------------------------------------------- arm B: the tier ladder

function ladderArm() {
  const reads = new Map([['maxLevel', 20], ['splitFactor', 1.2], ['vegLeafOff', 0], ['ssao', true], ['bloom', true], ['ssr', true]])
  let simNow = 0
  const gov = createQualityGovernor({
    enabled: () => true, now: () => simNow, read: (k) => reads.get(k),
    write: (k, v) => { reads.set(k, v) },
  })
  for (let i = 0; i < 90; i++) { simNow += 8; gov.tick(8) }
  const ladder = []
  for (let t = 0; t <= MAX_TIER; t++) {
    gov.setTier(t)
    const st = gov.state()
    ladder.push({ tier: t, leafOffM: st.leafOffM, maxLevel: st.knobs.maxLevel })
  }
  console.log(`[${LABEL}] ladder ${jsonLine(ladder)}`)

  for (let t = 0; t <= 2; t++) {
    expect(`ladder: tier ${t} holds every leaf (no cutoff)`, ladder[t].leafOffM, '==', 0)
  }
  for (let t = 3; t <= MAX_TIER; t++) {
    expect(`ladder: tier ${t} drops leaves beyond a positive distance`, ladder[t].leafOffM, '>', 0)
  }
  for (let t = 4; t <= MAX_TIER; t++) {
    expect(`ladder: tier ${t} is strictly more aggressive than tier ${t - 1}`, ladder[t].leafOffM, '<', ladder[t - 1].leafOffM)
  }
  const cutoffs = ladder.slice(3).map(l => l.leafOffM)
  expect('ladder: no cutoff ever reaches into the near band, so 0m keeps its leaves',
    cutoffs.every(c => c > NEAR_BAND_EDGE_M), '==', true)
  // The mid band is where the user met the degradation: a 32m or 20m gate leaves 18 of 20 mid-band
  // trees as bare branches. Pin the EDGE, not the rung values, so a later lane cannot walk the
  // ladder back down into the band.
  expect('ladder: no cutoff reaches into the mid band, so medium distance keeps its foliage',
    cutoffs.every(c => c >= MID_BAND_EDGE_M), '==', true)
  expect('ladder: the mid-band edge the ladder is pinned against is the one Vegetation derives',
    LEAF_OFF_MID_BAND_EDGE_M, '>=', MID_BAND_EDGE_M)
  // The old law flipped a global boolean at tier 3, where maxLevel only moved 10 -> 9.
  expect('ladder: maxLevel still moves one step per tier', ladder[2].maxLevel - ladder[3].maxLevel, '==', 1)
  const declared = QUALITY_TIERS.map(t => leafCutoffM(t.vegLeafOff))
  expect('ladder: the declared table matches the resolved one',
    declared.every((c, i) => Object.is(c, ladder[i].leafOffM)), '==', true)
  return { ladder }
}

// --------------------------------------------------------------- arm C: the real instancer

function instancerArm(ladder) {
  const scene = new THREE.Scene()
  const geo = new THREE.BoxGeometry(1, 1, 1)
  const mat = new THREE.MeshBasicMaterial()
  const lv = (d) => ({ geometry: geo, material: mat, distance: d })
  const levels = [lv(0), lv(14), lv(35)]
  const branch = createWebGPULodInstancer(scene, levels, 512, {}, { hysteresis: 0.12, host: null })
  const leaf = createWebGPULodInstancer(scene, levels, 512, {}, { hysteresis: 0.12, host: branch })
  for (let i = 0; i < INSTANCE_COUNT; i++) {
    const put = (rec) => { rec.position.set(i * INSTANCE_STEP_M, 0, 0); rec.scale.setScalar(1) }
    branch.addInstances(1, put)
    leaf.addInstances(1, put)
  }
  const eye = new THREE.Vector3(0, 0, 0)
  const frustum = new THREE.Frustum()
  const sweep = () => branch.updateLOD(eye, frustum, true)
  const counts = (im) => im.tierIds.map(t => t.length)
  const bandsOf = (im) => counts(im)

  branch.setLeafDrawDistance(Infinity)
  sweep()
  const base = { branch: bandsOf(branch), leaf: bandsOf(leaf) }
  console.log(`[${LABEL}] instancer ${jsonLine({ instances: INSTANCE_COUNT, stepM: INSTANCE_STEP_M, base })}`)
  expect('instancer: with no cutoff every leaf instance draws', base.leaf.reduce((a, b) => a + b, 0), '==', INSTANCE_COUNT)
  expect('instancer: the leaf mirrors the branch when nothing is gated',
    base.leaf.every((n, i) => n === base.branch[i]), '==', true)

  const rows = []
  for (const step of ladder) {
    branch.setLeafDrawDistance(step.leafOffM > 0 ? step.leafOffM : Infinity)
    sweep()
    const b = bandsOf(branch), l = bandsOf(leaf)
    rows.push({
      tier: step.tier, cutoffM: step.leafOffM,
      branch: b, leaf: l,
      branchTotal: b.reduce((a, x) => a + x, 0),
      leafTotal: l.reduce((a, x) => a + x, 0),
      nearLeaf: l[0], nearBranch: b[0],
      midLeaf: l[1] || 0, midBranch: b[1] || 0,
      farLeaf: l[l.length - 1], farBranch: b[b.length - 1],
    })
  }
  console.log(`[${LABEL}] per-tier ${jsonLine(rows)}`)

  for (const r of rows) {
    // Counted work unit: the near band's leaf count, per tier. This is the number the old boolean
    // drove to 0 at tier 3 and the number that is invisible to frame time and to draw counts.
    expect(`instancer: tier ${r.tier} keeps every leaf in the near band (0..14m)`, r.nearLeaf, '==', r.nearBranch)
    expect(`instancer: tier ${r.tier} keeps every leaf instance inside its cutoff`,
      r.cutoffM > 0 ? r.nearLeaf : r.nearLeaf, '>', 0)
    // The reported regression: medium distance trees with no foliage. The mid band's leaf count is
    // the number that went to 2 of 20 when the gate sat inside the band.
    expect(`instancer: tier ${r.tier} keeps every leaf in the mid band (14-35m)`, r.midLeaf, '==', r.midBranch)
    // Shedding foliage must never widen the no-mesh band: the branch ladder is untouched.
    expect(`instancer: tier ${r.tier} leaves the branch ladder untouched (no new no-mesh band)`,
      r.branch.every((n, i) => n === base.branch[i]), '==', true)
    expect(`instancer: tier ${r.tier} never hides a whole tree`, r.branchTotal, '==', base.branch.reduce((a, x) => a + x, 0))
  }
  const shedRows = rows.filter(r => r.cutoffM > 0)
  for (let i = 1; i < shedRows.length; i++) {
    expect(`instancer: tier ${shedRows[i].tier} draws strictly fewer leaf instances than tier ${shedRows[i - 1].tier}`,
      shedRows[i].leafTotal, '<', shedRows[i - 1].leafTotal)
  }
  for (const r of shedRows) {
    expect(`instancer: tier ${r.tier} actually shed leaf instances`, r.leafTotal, '<', base.leaf.reduce((a, x) => a + x, 0))
  }
  // The old law: one boolean, every distance at once.
  expect('instancer: even the floor tier keeps the near-band foliage', rows[MAX_TIER].nearLeaf, '>', 0)
  expect('instancer: the floor tier still draws fewer leaves than no cutoff', rows[MAX_TIER].leafTotal, '<', INSTANCE_COUNT)
  return { base, rows }
}

// --------------------------------------------------------------- arm D: the ratchet

function ratchetArm() {
  function harness() {
    const reads = new Map([['maxLevel', 20], ['splitFactor', 1.2], ['vegLeafOff', 0], ['ssao', true], ['bloom', true], ['ssr', true]])
    const writes = []
    let simNow = 0, frame = 0
    const gov = createQualityGovernor({
      enabled: () => true, now: () => simNow, read: (k) => reads.get(k),
      write: (k, v) => { writes.push({ frame, ms: simNow, key: k, value: v }); reads.set(k, v) },
    })
    const feed = (ms, frames) => { for (let i = 0; i < frames; i++) { simNow += ms; frame++; gov.tick(ms) } }
    return { gov, writes, feed, now: () => simNow, frame: () => frame }
  }

  const shed = harness()
  shed.feed(8, 90)
  const shedFrom = shed.writes.length
  const shedT0 = shed.now()
  let shedFrames = 0
  for (let i = 0; i < 4000 && shed.gov.tier < MAX_TIER; i++) { shed.feed(40, 1); shedFrames++ }
  const hitFloor = shed.gov.tier === MAX_TIER
  const shedWrites = shed.writes.slice(shedFrom).filter(w => TIER_KEYS.has(w.key))
  const shedMs = shed.now() - shedT0

  const recT0 = shed.now()
  let recFrames = 0
  for (let i = 0; i < 4000 && shed.gov.tier > 0; i++) { shed.feed(8, 1); recFrames++ }
  const recMs = shed.now() - recT0

  const ratio = shedMs > 0 ? recMs / shedMs : Infinity
  console.log(`[${LABEL}] ratchet ${jsonLine({ budgetMs: FRAME_BUDGET_MS, hitchStepIntervalMs: HITCH_STEP_INTERVAL_MS, recoverStepIntervalMs: RECOVER_STEP_INTERVAL_MS, minStepIntervalMs: MIN_STEP_INTERVAL_MS, shedMs, shedFrames, recoverMs: recMs, recoverFrames: recFrames, ratio: +ratio.toFixed(3), endTier: shed.gov.tier })}`)

  expect('ratchet: recovery no longer shares the 1000ms shed floor', RECOVER_STEP_INTERVAL_MS, '<', MIN_STEP_INTERVAL_MS)
  expect('ratchet: the latch shed interval was lengthened off 200ms', HITCH_STEP_INTERVAL_MS, '>', 200)
  expect('ratchet: a 40ms load still reaches the floor', hitFloor, '==', true)
  expect('ratchet: a sustained overload still sheds inside 5s', shedMs, '<=', 5000)
  expect('ratchet: returning headroom still recovers to the booted tier', shed.gov.tier, '==', 0)
  // The old law made every recovery step wait MIN_STEP_INTERVAL_MS, so five steps back cost more
  // than five tiers' worth of the shed floor even though the shed itself had taken under a second.
  expect('ratchet: recovery no longer costs a shed-floor interval per step', recMs, '<', MAX_TIER * MIN_STEP_INTERVAL_MS)
  expect('ratchet: recovery is not 5x slower than the shed any more', ratio, '<=', 4)
  expect('ratchet: one tier write per step, six keys per tier', shedWrites.length, '==', MAX_TIER * 6)
  return { shedMs, recMs, ratio, shedFrames, recFrames }
}

// --------------------------------------------------------------- arm E: the user-visible cause

function panelArm() {
  const atFloor = {
    tier: 5, maxTier: 5, avgMs: 21.4, winP95Ms: 40, budgetMs: FRAME_BUDGET_MS,
    hitchAboveMs: 2 * FRAME_BUDGET_MS, overrunMs: 40, steps: 7, leafOffM: 40,
    shedCause: 'hitch',
    knobs: { maxLevel: 7 },
  }
  // A shed taken below hitchAboveMs: no frame was ever over 33.34ms, so the window path did not act
  // and the cause line must say the excursion count did. Without shedCause the panel blames the
  // 30-frame window, whose avg is still 0 because no window has closed yet.
  const byExcursion = {
    tier: 3, maxTier: 5, avgMs: 0, winP95Ms: 0, budgetMs: FRAME_BUDGET_MS,
    hitchAboveMs: 2 * FRAME_BUDGET_MS, overrunMs: 0, steps: 3, leafOffM: 45,
    shedCause: 'excursion', shedExcursions: EXCURSION_TRIP_COUNT,
    excursionWindowFrames: EXCURSION_WINDOW_FRAMES, excursionAboveMs: EXCURSION_ABOVE_MS,
    knobs: { maxLevel: 9 },
  }
  const atRest = { tier: 0, maxTier: 5, avgMs: 12.1, winP95Ms: 14, budgetMs: FRAME_BUDGET_MS, hitchAboveMs: 2 * FRAME_BUDGET_MS, overrunMs: 0, steps: 0, leafOffM: 0, knobs: { maxLevel: 11 } }
  const status = governorStatusLine(atFloor)
  const cause = governorCauseLine(atFloor)
  const excursionCause = governorCauseLine(byExcursion)
  const restCause = governorCauseLine(atRest)
  console.log(`[${LABEL}] panel ${jsonLine({ status, cause, excursionCause, restCause })}`)

  expect('panel: the status line names the tier', /tier 5\/5/.test(status), '==', true)
  expect('panel: the status line names the leaf cutoff in metres', /leaves off beyond 40m/.test(status), '==', true)
  expect('panel: the status line says the near and mid trees keep theirs', /near and mid trees keep theirs/.test(status), '==', true)
  expect('panel: the cause line names what tripped it', /40\.0ms frame tripped the 33\.34ms hitch latch/.test(cause), '==', true)
  expect('panel: the cause line names the leaf cutoff', /leaves off beyond 40m/.test(cause), '==', true)
  expect('panel: a shed below hitchAboveMs names the excursion count',
    new RegExp(`${EXCURSION_TRIP_COUNT} of the last ${EXCURSION_WINDOW_FRAMES} frame\\(s\\) ran over`).test(excursionCause), '==', true)
  expect('panel: that cause line does not blame the 30-frame window, which did not act', /30-frame window/.test(excursionCause), '==', false)
  expect('panel: at rest it says leaves are everywhere', /leaves everywhere/.test(restCause), '==', true)
  expect('panel: with no governor state it says nothing is shedding', /nothing is shedding quality/.test(governorCauseLine(null)), '==', true)
  expect('panel: the leaf phrase for no cutoff is not a distance', leafPhrase(0), '==', 'leaves everywhere')
  return { status, cause }
}

function main() {
  parseArm()
  floorArm()
  const { ladder } = ladderArm()
  instancerArm(ladder)
  ratchetArm()
  panelArm()
  const failed = checks.filter(c => !c.pass)
  for (const c of failed) console.log(`[${LABEL}] FAILED ${c.label}: got ${JSON.stringify(c.got)} ${c.op} ${JSON.stringify(c.want)}`)
  console.log(`[${LABEL}] checks ${checks.length - failed.length}/${checks.length} passed`)
  const r = ladder
  finish(failed.length === 0 ? 'PASS' : 'FAIL', failed.length === 0
    ? `${checks.length - failed.length}/${checks.length} check(s) passed -- leaf cutoff by tier ${r.map(l => l.leafOffM).join('/')}m (0 = leaves everywhere), near and mid bands keep their foliage at every tier`
    : `${failed.length} check(s) failed`)
}

main()
