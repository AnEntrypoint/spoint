import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const moduleArg = process.argv.find((a) => a.startsWith('--module='))
const modulePath = resolve(moduleArg ? moduleArg.slice('--module='.length) : join(ROOT, 'src', 'terrain', 'PlanetFrame.js'))

const RADIUS_M = 2000
const X = 1000
const Z = 0
const BAD_TOLERANCES = [
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['0', 0],
  ['-1', -1],
  ['NaN', NaN],
  ['null', null],
  ['the string "1e-4"', '1e-4'],
]

const PASS = []
const FAIL = []

function expect(label, cond, detail) {
  if (cond) { PASS.push(label); console.log(`  [PASS] ${label}${detail ? ' -- ' + detail : ''}`) }
  else { FAIL.push(label); console.log(`  [FAIL] ${label}${detail ? ' -- ' + detail : ''}`) }
}

function finish() {
  console.log(`  passed ${PASS.length}, failed ${FAIL.length}`)
  console.log(`[surface-solve-tolerance-witness] RESULT: ${FAIL.length === 0 ? 'PASS' : 'FAIL'}`)
  process.exitCode = FAIL.length === 0 ? 0 : 1
}

const field = { radius: RADIUS_M, hashVersion: 1, heightAt: (d) => 40 * Math.sin(3 * d[0]) + 25 * Math.cos(2 * d[2]) + 10 * d[1] }

const EXPECTATIONS = [
  '(a) solveSurfaceY with the default toleranceM returns a finite height and spends at least 1 evaluation',
  '(a) solveSurfaceY with the explicit SURFACE_SOLVE_TOLERANCE_M returns the default-tolerance height exactly',
  '(b) the real caller frame.groundHeightLocal still returns a finite height',
  ...BAD_TOLERANCES.map(([name]) => `(c) toleranceM ${name} is refused at entry: SolveToleranceError, 0 sampler call(s), 0 solve(s) and 0 evaluation(s) recorded`),
  '(d) SolveToleranceError is not a SurfaceSolveError, so guardedGroundHeight cannot turn it into NO_GROUND_HEIGHT',
  '(e) SolveToleranceError names the rejected value in its message',
]

function checks(mod) {
  const { createPlanetFrame, SURFACE_SOLVE_TOLERANCE_M, SolveToleranceError, guardedGroundHeight, surfaceSolveStats, resetSurfaceSolveStats } = mod
  const frame = createPlanetFrame({ sampler: field, anchorDir: [0, 1, 0], offsetY: 0 })

  resetSurfaceSolveStats()
  let yDefault = NaN
  try { yDefault = frame.solveSurfaceY(X, Z, (d) => field.heightAt(d)) } catch (e) { yDefault = NaN }
  const statsDefault = surfaceSolveStats()
  expect(EXPECTATIONS[0], Number.isFinite(yDefault) && statsDefault.solves === 1 && statsDefault.evaluations >= 1, `y=${yDefault}, solves=${statsDefault.solves}, evaluations=${statsDefault.evaluations}`)

  let yExplicit = NaN
  try { yExplicit = frame.solveSurfaceY(X, Z, (d) => field.heightAt(d), SURFACE_SOLVE_TOLERANCE_M) } catch (e) { yExplicit = NaN }
  expect(EXPECTATIONS[1], yExplicit === yDefault, `explicit y=${yExplicit}, default y=${yDefault}`)

  let yGround = NaN
  try { yGround = frame.groundHeightLocal(X, Z) } catch (e) { yGround = NaN }
  expect(EXPECTATIONS[2], Number.isFinite(yGround), `groundHeightLocal=${yGround}`)

  const exported = SolveToleranceError != null
  let named = false
  BAD_TOLERANCES.forEach(([name, tol], i) => {
    resetSurfaceSolveStats()
    let calls = 0
    const counting = (d) => { calls++; return field.heightAt(d) }
    let thrown = null
    try { frame.solveSurfaceY(X, Z, counting, tol) } catch (e) { thrown = e }
    const s = surfaceSolveStats()
    const ok = exported && thrown instanceof SolveToleranceError && calls === 0 && s.solves === 0 && s.evaluations === 0
    if (ok && String(thrown.message).includes(String(tol))) named = true
    expect(EXPECTATIONS[3 + i], ok, exported ? `threw ${thrown ? thrown.name : 'nothing'}, sampler calls=${calls}, solves=${s.solves}, evaluations=${s.evaluations}` : 'the module exports no SolveToleranceError')
  })

  const tail = 3 + BAD_TOLERANCES.length
  let escaped = null
  try { guardedGroundHeight('surface-solve-tolerance-witness', () => { throw new SolveToleranceError(0) })(X, Z) } catch (e) { escaped = e }
  expect(EXPECTATIONS[tail], exported && escaped instanceof SolveToleranceError, exported ? `guardedGroundHeight rethrew ${escaped ? escaped.name : 'nothing'}` : 'the module exports no SolveToleranceError')
  expect(EXPECTATIONS[tail + 1], named, exported ? 'every rejected value appears in its SolveToleranceError message' : 'the module exports no SolveToleranceError')
}

async function main() {
  console.log(`[surface-solve-tolerance-witness] module ${modulePath}`)
  console.log('EXPECT (recorded before any measurement):')
  for (const e of EXPECTATIONS) console.log(`  EXPECT ${e}`)
  if (!existsSync(modulePath)) { expect(`module path exists: ${modulePath}`, false, 'no such file'); return }
  let mod
  try { mod = await import(pathToFileURL(modulePath).href) } catch (e) { expect(`module imports: ${modulePath}`, false, e.message); return }
  try { checks(mod) } catch (e) { expect('witness body completes', false, e.message) }
}

await main()
finish()
