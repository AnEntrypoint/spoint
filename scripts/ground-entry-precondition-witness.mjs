import {
  createPlanetFrame,
  guardedGroundHeight,
  groundMemoStats,
  resetGroundMemoStats,
  NO_GROUND_HEIGHT,
  SurfaceSolveArgumentError,
  SurfaceSolveError,
} from '../src/terrain/PlanetFrame.js'

const RADIUS_M = 63600
const LEGAL_X = 1000
const LEGAL_Z = 0
const SLOT_ZERO_X = 0.1
const SLOT_ZERO_Z = 0.1
const NON_FINITE = [NaN, Infinity, -Infinity]
const REFUSED_TOLERANCES = [NaN, Infinity, -Infinity, 0, -1e-4]

const PASS = []
const FAIL = []

function expect(label, cond, detail) {
  if (cond) { PASS.push(label); console.log(`  [PASS] ${label}`) }
  else { FAIL.push(label); console.log(`  [FAIL] ${label}${detail ? ' -- ' + detail : ''}`) }
}

function refusal(run) {
  try { return { value: run(), err: null } }
  catch (e) { return { value: undefined, err: e } }
}

function observed(r) {
  return r.err ? `threw ${r.err.name}: ${r.err.message}` : `returned ${String(r.value)}`
}

let samplerCalls = 0
const field = {
  radius: RADIUS_M,
  hashVersion: 1,
  heightAt: (d) => { samplerCalls++; return 40 * Math.sin(3 * d[0]) + 25 * Math.cos(2 * d[2]) + 10 * d[1] },
}
let dirCalls = 0
const counted = (d) => { dirCalls++; return field.heightAt(d) }

const frame = createPlanetFrame({ sampler: field, anchorDir: [0, 1, 0], offsetY: 0 })
samplerCalls = 0

for (const arg of ['x', 'z']) {
  for (const v of NON_FINITE) {
    const x = arg === 'x' ? v : LEGAL_X
    const z = arg === 'z' ? v : LEGAL_Z
    dirCalls = 0
    samplerCalls = 0
    const r = refusal(() => frame.solveSurfaceY(x, z, counted))
    expect(`solveSurfaceY refuses ${arg}=${v} at entry, with no height sampled`,
      r.err instanceof SurfaceSolveArgumentError
        && r.err.fnName === 'solveSurfaceY'
        && r.err.arg === arg
        && r.err instanceof RangeError
        && !(r.err instanceof SurfaceSolveError)
        && r.err.message.includes(`requires ${arg} to be a finite number`)
        && dirCalls === 0
        && samplerCalls === 0,
      `${observed(r)}, dirCalls ${dirCalls}, samplerCalls ${samplerCalls}`)
  }
}

for (const tol of REFUSED_TOLERANCES) {
  dirCalls = 0
  samplerCalls = 0
  const r = refusal(() => frame.solveSurfaceY(LEGAL_X, LEGAL_Z, counted, tol))
  expect(`solveSurfaceY refuses toleranceM=${tol} at entry, with no height sampled`,
    r.err !== null
      && r.err.name === 'SolveToleranceError'
      && r.err instanceof RangeError
      && !(r.err instanceof SurfaceSolveError)
      && dirCalls === 0
      && samplerCalls === 0,
    `${observed(r)}, dirCalls ${dirCalls}, samplerCalls ${samplerCalls}`)
}

for (const arg of ['x', 'z']) {
  for (const v of NON_FINITE) {
    const x = arg === 'x' ? v : LEGAL_X
    const z = arg === 'z' ? v : LEGAL_Z
    samplerCalls = 0
    resetGroundMemoStats()
    const r = refusal(() => frame.groundHeightLocal(x, z))
    const stats = groundMemoStats()
    expect(`groundHeightLocal refuses ${arg}=${v} at entry, with no height sampled and no memo write`,
      r.err instanceof SurfaceSolveArgumentError
        && r.err.fnName === 'groundHeightLocal'
        && r.err.arg === arg
        && !(r.err instanceof SurfaceSolveError)
        && samplerCalls === 0
        && stats.misses === 0
        && stats.hits === 0
        && stats.evictions === 0,
      `${observed(r)}, samplerCalls ${samplerCalls}, memo ${JSON.stringify(stats)}`)
  }
}

const guarded = guardedGroundHeight('ground-entry-precondition-witness', frame.groundHeightLocal)
const guardedRefusal = refusal(() => guarded(NaN, 0))
expect('guardedGroundHeight rethrows the entry refusal instead of reporting NO_GROUND_HEIGHT',
  guardedRefusal.err instanceof SurfaceSolveArgumentError && guardedRefusal.value !== NO_GROUND_HEIGHT,
  observed(guardedRefusal))

const noGroundFrame = createPlanetFrame({ sampler: { radius: RADIUS_M, hashVersion: 1, heightAt: () => NaN }, anchorDir: [0, 1, 0], offsetY: 0 })
const guardedNoGround = refusal(() => guardedGroundHeight('ground-entry-precondition-witness', noGroundFrame.groundHeightLocal)(LEGAL_X, LEGAL_Z))
expect('guardedGroundHeight still reports NO_GROUND_HEIGHT where the sampler itself returns no finite height',
  guardedNoGround.err === null && guardedNoGround.value === NO_GROUND_HEIGHT,
  observed(guardedNoGround))

const legalHeight = frame.groundHeightLocal(LEGAL_X, LEGAL_Z)
expect('a legal call still returns a finite ground height', Number.isFinite(legalHeight), String(legalHeight))

const freshFrame = createPlanetFrame({ sampler: field, anchorDir: [0, 1, 0], offsetY: 0 })
expect('a fresh frame returns the same height at the same point', freshFrame.groundHeightLocal(LEGAL_X, LEGAL_Z) === legalHeight,
  `fresh ${freshFrame.groundHeightLocal(LEGAL_X, LEGAL_Z)} vs memoised ${legalHeight}`)

dirCalls = 0
const solved = refusal(() => frame.solveSurfaceY(LEGAL_X, LEGAL_Z, counted))
expect('a legal solveSurfaceY call still samples and converges', solved.err === null && Number.isFinite(solved.value) && dirCalls > 0,
  `${observed(solved)}, dirCalls ${dirCalls}`)

const slotZeroHeight = frame.groundHeightLocal(SLOT_ZERO_X, SLOT_ZERO_Z)
resetGroundMemoStats()
refusal(() => frame.groundHeightLocal(NaN, 0))
refusal(() => frame.groundHeightLocal(0, NaN))
const afterRefusals = frame.groundHeightLocal(SLOT_ZERO_X, SLOT_ZERO_Z)
const refusalStats = groundMemoStats()
expect('two refused calls leave the memo slot they would have poisoned serving the height memoised before them',
  afterRefusals === slotZeroHeight && refusalStats.hits === 1 && refusalStats.misses === 0 && refusalStats.evictions === 0,
  `height ${afterRefusals} vs ${slotZeroHeight}, memo ${JSON.stringify(refusalStats)}`)

console.log(`checks=${PASS.length + FAIL.length} failed=${FAIL.length}`)
console.log(`RESULT: ${FAIL.length === 0 ? 'PASS' : 'FAIL'}`)
process.exitCode = FAIL.length === 0 ? 0 : 1
