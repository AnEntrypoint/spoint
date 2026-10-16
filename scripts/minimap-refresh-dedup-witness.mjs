#!/usr/bin/env node
// Prices the minimap-refresh deduplication and proves it does not move a height.
//
// A minimap refresh re-solves the whole BUFFER_CELLS^2 grid. Before the fix the grid origin was the
// pose, so a drift-triggered refresh asked the ground sampler for every cell at a slightly
// different (x,z) than the refresh before it: none of that work was recognisable as work already
// done, and the sampler re-solved ~84% of the grid for nothing. client/hud/MinimapHUD.js now snaps
// the origin to a world-aligned multiple of the cell size and blits the overlapping window of the
// previous grid forward.
//
// Two claims, both measured against the real mapspinner CPU sampler and the real PlanetFrame:
//   1. PRICE: how many cells a drift refresh re-solves with and without the carry, and how much
//      sampler time that is.
//   2. PARITY: a carried cell is a byte copy of the value the previous refresh solved for that
//      exact (x,z), so the carry cannot move it. What CAN differ is the value a fresh solve would
//      have returned, because solveSurfaceY is seeded by the previous cell in the row and a skipped
//      cell changes that seed. That delta is measured, and it is bounded by the solver's own
//      reproducibility (1.57e-4 m over a 10 m seed nudge, scripts/ground-height-quantum-parity-witness.mjs).
//
// Nothing here writes to the repo.
import Module from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { flagNumber } from './lib/witness-args.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_URL = pathToFileURL(`${REPO}/`).href

// client/hud/MinimapPlacements.js imports '/src/...' by root-absolute specifier, which the ESM
// resolver reads as a path from the filesystem root.
const resolverUrl = new URL('./lib/src-specifier-resolver.mjs', import.meta.url)
const mapSrc = (specifier) => (specifier.startsWith('/src/') ? new URL(specifier.slice(1), REPO_URL).href : null)
if (typeof Module.registerHooks === 'function') {
  Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const url = mapSrc(specifier)
      return url ? { url, shortCircuit: true } : nextResolve(specifier, context)
    },
  })
} else if (typeof Module.register === 'function') {
  Module.register(resolverUrl.href, import.meta.url)
} else {
  console.log('RESULT: FAIL (uncaught) -- this node exposes neither module.registerHooks nor module.register, so the /src/ specifiers under client/hud cannot be resolved')
  process.exit(1)
}

const argv = process.argv.slice(2)
const ARGS = new Map()
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const eq = a.indexOf('=')
  if (eq > 0) ARGS.set(a.slice(2, eq), a.slice(eq + 1))
  else ARGS.set(a.slice(2), (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[i + 1] : true)
}
const flag = (n, d) => (ARGS.has(n) ? ARGS.get(n) : d)

const RADIUS = flagNumber(flag, 'radius', 63600, argv)
const SEED = flagNumber(flag, 'seed', 1337, argv)
const DRIFT_M = flagNumber(flag, 'drift', 0, argv) // 0 == the drift the HUD itself triggers
const NO_CARRY = ARGS.has('nocarry')

// The solver's own reproducibility, measured by scripts/ground-height-quantum-parity-witness.mjs:
// nudging solveSurfaceY's seed by up to 10 m moves its answer by at most this much. A reuse whose
// delta stayed under it would be inside the solver's own error bar; this one is expected to be
// exactly zero for carried cells and small for the cells that follow them.
const SOLVER_REPRO_BOUND_M = 2e-4

const failures = []
const measurements = []
function expect(name, got, predicate) {
  measurements.push(name)
  let ok = false
  try { ok = Boolean(predicate(got)) } catch { ok = false }
  if (!ok) failures.push(`${name}=${JSON.stringify(got)}`)
  return got
}
const finite = (v) => Number.isFinite(v)

function pct(list, p) {
  if (!list.length) return NaN
  const s = list.slice().sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}

// The HUD's terrain phase, mirrored. It is mirrored rather than imported because the phase lives
// inside createMinimapHUD's closure over its canvas layers; the grid geometry it uses comes from
// the HUD's own MINIMAP_GRID export, and the sampler it calls is the real sampleMinimapCell.
function runTerrainPhase({ frame, sampleMinimapCell, cells, cellMeters, left, top, heights, land, biome, filled, cellsPerCheck, raw }) {
  const cellRgb = [0, 0, 0, 0, NaN]
  let solved = 0
  let row = 0, col = 0
  let rowGuess = NaN
  while (row < cells) {
    const z = top + (row + 0.5) * cellMeters
    const end = Math.min(cells, col + cellsPerCheck)
    for (let i = col; i < end; i++) {
      const idx = row * cells + i
      if (filled && filled[idx] && Number.isFinite(heights[idx])) { rowGuess = heights[idx]; continue }
      let h = NaN
      try {
        h = sampleMinimapCell(frame, null, left + (i + 0.5) * cellMeters, z, cellRgb, rowGuess) ?? NaN
      } catch (e) {
        h = NaN
      }
      heights[idx] = h
      if (raw) raw[idx] = h
      solved++
      rowGuess = Number.isFinite(h) && Number.isFinite(cellRgb[4]) ? cellRgb[4] : NaN
      land[idx] = cellRgb[3]
      biome[idx * 3] = cellRgb[0]; biome[idx * 3 + 1] = cellRgb[1]; biome[idx * 3 + 2] = cellRgb[2]
    }
    if (end < cells) col = end
    else { col = 0; row++; rowGuess = NaN }
  }
  return solved
}

async function main() {
  const HUD = await import(pathToFileURL(resolve(REPO, 'client', 'hud', 'MinimapHUD.js')).href)
  const { sampleMinimapCell } = await import(pathToFileURL(resolve(REPO, 'src', 'shared', 'MinimapBiome.js')).href)
  const M = await import(pathToFileURL(resolve(REPO, 'src', 'terrain', 'PlanetFrame.js')).href)
  const { createHeightSampler } = await import(pathToFileURL(resolve(REPO, 'node_modules', 'mapspinner', 'src', 'height-cpu.js')).href)

  const G = HUD.MINIMAP_GRID
  if (!G || !Number.isInteger(G.cells)) throw new Error('client/hud/MinimapHUD.js exports no MINIMAP_GRID.cells')
  const CELLS = G.cells
  const SPAN = G.defaultViewSpanM * G.overView
  const CELL_M = SPAN / CELLS
  const DRIFT = DRIFT_M > 0 ? DRIFT_M : G.defaultViewSpanM * G.driftOverView
  console.log(`[minimap-dedup] grid cells=${CELLS} span=${SPAN}m cellMeters=${CELL_M}m drift=${DRIFT}m (${Math.round((DRIFT / CELL_M) * 100) / 100} cells)`)

  const sampler = createHeightSampler({ radius: RADIUS, seed: SEED, reliefScale: 0.01, hashVersion: 2 })
  const frame = M.createPlanetFrame({ sampler, anchorDir: [0, 1, 0], offsetY: 0, reliefScale: 0.01 })
  for (let i = 0; i < 200; i++) frame.groundHeightLocal(i * 3, -i * 2)

  // ---- 1. the blit is exact and never clobbers a source it still has to read -------------------
  const blit = {}
  for (const [dRow, dCol] of [[11, 11], [-11, -11], [11, -11], [-11, 11], [0, 11], [11, 0], [0, 0], [40, 40]]) {
    const cells = 24
    const h = new Float32Array(cells * cells)
    const l = new Uint8Array(cells * cells)
    const b = new Uint8Array(cells * cells * 3)
    for (let i = 0; i < cells * cells; i++) { h[i] = i * 0.25; l[i] = i & 1; b[i * 3] = i & 255 }
    const filled = new Uint8Array(cells * cells)
    const carried = HUD.minimapCarryGrid(dRow, dCol, cells, h, l, b, filled)
    let wrong = 0
    for (let r = 0; r < cells; r++) {
      for (let c = 0; c < cells; c++) {
        const sr = r + dRow, sc = c + dCol
        const di = r * cells + c
        if (sr < 0 || sr >= cells || sc < 0 || sc >= cells) { if (filled[di] !== 0) wrong++; continue }
        const si = sr * cells + sc
        if (h[di] !== si * 0.25 || l[di] !== (si & 1) || b[di * 3] !== (si & 255) || filled[di] !== 1) wrong++
      }
    }
    const expected = Math.max(0, cells - Math.abs(dRow)) * Math.max(0, cells - Math.abs(dCol))
    if (carried !== expected || wrong !== 0) {
      blit[`${dRow},${dCol}`] = { carried, expected, wrong }
    }
  }
  const blitOk = Object.keys(blit).length === 0
  console.log('[minimap-dedup] blit exactness: ' + (blitOk ? 'all 8 shifts exact' : JSON.stringify(blit)))
  expect('blit_exact_allShifts', blitOk, (v) => v === true)

  // A fractional shift means the lattices disagree: nothing may be reused.
  expect('carryShift_fractional_refused', HUD.minimapCarryShift(0, 0, CELL_M * 0.5, 0, CELL_M, CELLS), (v) => v === null)
  expect('carryShift_whole_accepted', JSON.stringify(HUD.minimapCarryShift(0, 0, -CELL_M * 3, -CELL_M * 2, CELL_M, CELLS)), (v) => v === JSON.stringify({ dRow: -2, dCol: -3 }))

  // The grid used to be centred exactly on the pose; snapping it to the lattice moves its centre by
  // up to half a cell. The drawn image follows the grid (front.cx is w.left + span/2), so this is
  // the whole of the registration error, and it is bounded by half a cell by construction.
  let maxOffset = 0
  for (let i = 0; i < 4096; i++) {
    const p = (i * 7.31) % 4000 - 2000
    const o = HUD.minimapGridOrigin(p, SPAN, CELLS).origin
    const d = Math.abs(o - (p - SPAN / 2))
    if (d > maxOffset) maxOffset = d
  }
  console.log(`[minimap-dedup] grid centre vs pose: max ${Math.round(maxOffset * 1000) / 1000}m of a ${CELL_M}m cell`)
  expect('gridOffsetFromPose_leHalfCell', Math.round(maxOffset * 1000) / 1000, (v) => finite(v) && v <= CELL_M / 2 + 1e-6)

  // ---- 2. two refreshes, one drift apart ------------------------------------------------------
  const base = { cells: CELLS, cellMeters: CELL_M, cellsPerCheck: G.cellsPerCheck, frame, sampleMinimapCell }
  const mk = () => ({ heights: new Float32Array(CELLS * CELLS), land: new Uint8Array(CELLS * CELLS), biome: new Uint8Array(CELLS * CELLS * 3), raw: new Float64Array(CELLS * CELLS) })

  const pose1 = { x: 120.5, z: -80.25 }
  const pose2 = { x: pose1.x + DRIFT, z: pose1.z + DRIFT * 0.5 }
  const snap1 = { left: HUD.minimapGridOrigin(pose1.x, SPAN, CELLS).origin, top: HUD.minimapGridOrigin(pose1.z, SPAN, CELLS).origin }
  const snap2 = { left: HUD.minimapGridOrigin(pose2.x, SPAN, CELLS).origin, top: HUD.minimapGridOrigin(pose2.z, SPAN, CELLS).origin }

  M.resetGroundMemoStats(); M.resetSurfaceSolveStats()
  const g1 = mk()
  const t1 = process.hrtime.bigint()
  const solved1 = runTerrainPhase({ ...base, ...snap1, ...g1, filled: null })
  const ms1 = Number(process.hrtime.bigint() - t1) / 1e6
  const arm1 = M.surfaceSolveStats()

  // Arm A: the pre-dedup behaviour -- origin is the pose, no carry.
  M.resetSurfaceSolveStats()
  const gA = mk()
  const tA = process.hrtime.bigint()
  const solvedA = runTerrainPhase({ ...base, left: pose2.x - SPAN / 2, top: pose2.z - SPAN / 2, ...gA, filled: null })
  const msA = Number(process.hrtime.bigint() - tA) / 1e6
  const armA = M.surfaceSolveStats()

  // Arm B: lattice origin + carry of the overlapping window.
  M.resetSurfaceSolveStats()
  const gB = mk()
  gB.heights.set(g1.heights); gB.land.set(g1.land); gB.biome.set(g1.biome); gB.raw.set(g1.raw)
  const filledB = new Uint8Array(CELLS * CELLS)
  const shift = NO_CARRY ? null : HUD.minimapCarryShift(snap1.left, snap1.top, snap2.left, snap2.top, CELL_M, CELLS)
  const carried = shift ? HUD.minimapCarryGrid(shift.dRow, shift.dCol, CELLS, gB.heights, gB.land, gB.biome, filledB) : 0
  // The HUD's heights are Float32Array, so its stored value already rounds to float32. Carry the
  // float64 shadow too: it is what separates "the reuse moved a height" from "float32 storage".
  if (shift) HUD.minimapCarryGrid(shift.dRow, shift.dCol, CELLS, gB.raw, gB.land, gB.biome, null)
  const tB = process.hrtime.bigint()
  const solvedB = runTerrainPhase({ ...base, ...snap2, ...gB, filled: NO_CARRY ? null : filledB })
  const msB = Number(process.hrtime.bigint() - tB) / 1e6
  const armB = M.surfaceSolveStats()

  const solve = M.surfaceSolveStats()
  const evalsA = Math.round((armA.evaluations / Math.max(1, armA.solves)) * 100) / 100
  const evalsB = Math.round((armB.evaluations / Math.max(1, armB.solves)) * 100) / 100
  const evals1 = Math.round((arm1.evaluations / Math.max(1, arm1.solves)) * 100) / 100
  console.log(`[minimap-dedup] refresh1 solves=${solved1} ${Math.round(ms1 * 100) / 100}ms evals/solve=${evals1} | armA(no carry) solves=${solvedA} ${Math.round(msA * 100) / 100}ms evals/solve=${evalsA} | armB(carry) carried=${carried} solves=${solvedB} ${Math.round(msB * 100) / 100}ms evals/solve=${evalsB}`)

  // ---- 3. parity: does a carried cell hold the height a solve produced for that (x,z)? --------
  // Carried cells are a byte copy, so compare each one against the value refresh 1 solved for the
  // same lattice index (exactly equal by construction, asserted) and against a FRESH solve of the
  // same (x,z) with the row-start seed the pre-dedup loop would have used (measured delta).
  const cellX = (left, i) => left + (i + 0.5) * CELL_M
  const cellZ = (top, r) => top + (r + 0.5) * CELL_M
  let cmp = 0, exact = 0
  const deltas = []
  const shiftD = shift || { dRow: 0, dCol: 0 }
  for (let r = 0; r < CELLS; r++) {
    for (let c = 0; c < CELLS; c++) {
      const sr = r + shiftD.dRow, sc = c + shiftD.dCol
      if (sr < 0 || sr >= CELLS || sc < 0 || sc >= CELLS) continue
      const di = r * CELLS + c, si = sr * CELLS + sc
      const x = cellX(snap2.left, c), z = cellZ(snap2.top, r)
      const xPrev = cellX(snap1.left, sc), zPrev = cellZ(snap1.top, sr)
      if (Math.abs(x - xPrev) > 1e-9 || Math.abs(z - zPrev) > 1e-9) continue // lattices disagree: not a carried cell
      cmp++
      if (gB.raw[di] === g1.raw[si]) exact++
      const cellRgb = [0, 0, 0, 0, NaN]
      const fresh = sampleMinimapCell(frame, null, x, z, cellRgb, NaN) ?? NaN
      if (Number.isFinite(fresh) && Number.isFinite(gB.raw[di])) deltas.push(Math.abs(fresh - gB.raw[di]))
    }
  }
  const maxDelta = deltas.length ? Math.max(...deltas) : NaN
  const p99Delta = deltas.length ? pct(deltas, 0.99) : NaN
  console.log(`[minimap-dedup] carried cells compared=${cmp} byte-identical to the previous solve=${exact}; |carried - fresh solve of the same (x,z)| max=${maxDelta} p99=${Math.round(p99Delta * 1e9) / 1e9} over ${deltas.length}`)

  const carryPct = Math.round((carried / (CELLS * CELLS)) * 10000) / 100
  const evalTotal = solve.evaluations
  const usPerSolve = (ms1 / Math.max(1, solved1)) * 1000

  const report = {
    cellsPerRefresh: expect('cellsPerRefresh', CELLS * CELLS, (v) => v === CELLS * CELLS),
    refresh1_solves: expect('refresh1_solves', solved1, (v) => v === CELLS * CELLS),
    refresh2_solves_noCarry: expect('refresh2_solves_noCarry', solvedA, (v) => v === CELLS * CELLS),
    refresh2_carried: expect('refresh2_carried', carried, (v) => Number.isFinite(v) && v >= 0),
    refresh2_solves_carry: expect('refresh2_solves_carry', solvedB, (v) => Number.isFinite(v) && v + carried === CELLS * CELLS),
    carryPct: expect('carryPct', carryPct, (v) => finite(v) && v >= 0 && v <= 100),
    ms_noCarry: expect('ms_noCarry', Math.round(msA * 100) / 100, (v) => finite(v) && v > 0),
    ms_carry: expect('ms_carry', Math.round(msB * 100) / 100, (v) => finite(v) && v > 0),
    usPerSolve: expect('usPerSolve', Math.round(usPerSolve * 100) / 100, (v) => finite(v) && v > 0),
    solveEvaluations: expect('solveEvaluations', evalTotal, (v) => Number.isFinite(v) && v > 0),
  }
  if (NO_CARRY) {
    // Mutation: with the carry disabled the refresh must go back to solving every cell, and the
    // sampler time must come back with it. ms_savedPct is not asserted here -- at 0% carry it is
    // noise around zero by construction.
    expect('mutation_carryDisabled_solvesEveryCell', solvedB, (v) => v === CELLS * CELLS)
    expect('mutation_carryDisabled_carried', carried, (v) => v === 0)
    expect('mutation_msWithinNoiseOf_noCarry', Math.abs(msB - msA) / msA, (v) => finite(v) && v <= 0.25)
  } else {
    expect('carry_isMostOfTheGrid', carryPct, (v) => v >= 60)
    expect('carry_savesMostOfTheSolveTime', Math.round(((msA - msB) / msA) * 10000) / 100, (v) => finite(v) && v >= 50)
    report.ms_savedPct = Math.round(((msA - msB) / msA) * 10000) / 100
    report.parity_cellsCompared = expect('parity_cellsCompared', cmp, (v) => Number.isFinite(v) && v > 0)
    report.parity_byteIdentical = expect('parity_byteIdentical', exact, (v) => v === cmp)
    report.parity_maxAbsDiffM = expect('parity_maxAbsDiffM', Math.round(maxDelta * 1e9) / 1e9, (v) => finite(v) && v >= 0 && v <= SOLVER_REPRO_BOUND_M)
    report.parity_p99AbsDiffM = expect('parity_p99AbsDiffM', Math.round(p99Delta * 1e9) / 1e9, (v) => finite(v) && v >= 0 && v <= SOLVER_REPRO_BOUND_M)
  }

  console.log('[minimap-dedup] measurements ' + JSON.stringify(report, null, 2))
  for (const f of failures) console.log(`FAIL: ${f}`)
  if (failures.length) console.log(`RESULT: FAIL (${failures.length} of ${measurements.length} measurement(s))`)
  else console.log('RESULT: PASS')
  process.exitCode = failures.length ? 1 : 0
}

main().catch((e) => {
  console.error('[minimap-dedup] threw: ' + String((e && e.stack) || e))
  console.log('RESULT: FAIL (1 of 1 measurement(s))')
  process.exitCode = 1
})
