import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const { createFireKernel, FIRE_STATE } = await import(pathToFileURL(path.join(ROOT, 'src/shared/fire/fireKernel.js')).href)

const N = 16
const STEP = 30
const UNBURNT = FIRE_STATE.UNBURNT
const BURNING = FIRE_STATE.BURNING
const BURNT = FIRE_STATE.BURNT
const clamp = (v) => (v < 0 ? 0 : v >= N ? N - 1 : v)
const lattice = {
  cellsPerFace: N,
  faceCount: 6,
  walk(face, I, J, di, dj, out) {
    out.face = face
    out.I = clamp(I + di)
    out.J = clamp(J + dj)
    return out
  },
  windInFaceAxes(face, wx, wy, wz, out) {
    out[0] = wx
    out[1] = wy
    return out
  },
}
const classes = [
  { igniteHeat: 0 },
  { igniteHeat: 40, burnRate: 10, heatOut: 250, fuel: 60, spotChance: 0 },
]
const config = {
  lattice,
  fuelClassAt: () => 1,
  classes,
  seed: 7,
  stepTicks: STEP,
  maxTiles: 64,
  softActiveCells: 4096,
  maxActiveCells: 8192,
}
const CENTRE = { face: 0, I: 8, J: 8 }

const build = (extra = {}) => {
  const kernel = createFireKernel({ ...config, ...extra })
  kernel.ignite(0, CENTRE.face, CENTRE.I, CENTRE.J, 1)
  return kernel
}

const stepThrough = (kernel, steps, fromStep = 0, sample = null) => {
  const sums = []
  for (let k = fromStep; k < fromStep + steps; k++) {
    kernel.runStepUnsliced(k * STEP)
    sums.push(kernel.checksum())
    if (sample) sample(kernel, k)
  }
  return sums
}

const spreadOf = (kernel) => {
  let count = 0
  for (let I = 0; I < N; I++) for (let J = 0; J < N; J++) if (kernel.cellState(0, I, J).state !== UNBURNT) count++
  return count
}

{
  const a = build()
  const b = build()
  const sumsA = stepThrough(a, 40)
  const sumsB = stepThrough(b, 40)
  check('two kernels with the same config and events produce the same checksum at every step', sumsA.length === sumsB.length && sumsA.every((v, i) => v === sumsB[i]))
  check('the checksum is an unsigned 32-bit integer at every step', sumsA.every((v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff))
  check('the simulation evolves: the checksum takes more than two distinct values over 40 steps', new Set(sumsA).size > 2, `distinct=${new Set(sumsA).size}`)
}

{
  const k = build()
  const fuelSeq = []
  const stateSeq = []
  stepThrough(k, 12, 0, (kern) => {
    const c = kern.cellState(CENTRE.face, CENTRE.I, CENTRE.J)
    fuelSeq.push(c.fuel)
    stateSeq.push(c.state)
  })
  check('the ignited centre cell is burning after its first step', stateSeq[0] === BURNING, `state=${stateSeq[0]}`)
  let burnDrops = true
  for (let i = 1; i < fuelSeq.length; i++) {
    if (stateSeq[i - 1] === BURNING && stateSeq[i] === BURNING && fuelSeq[i - 1] - fuelSeq[i] !== 10) burnDrops = false
  }
  check('a burning cell loses exactly its burnRate of fuel per step', burnDrops, `fuel=${fuelSeq.join(',')}`)
  check('the centre cell burns out to BURNT once its fuel reaches zero', stateSeq[stateSeq.length - 1] === BURNT && fuelSeq[fuelSeq.length - 1] === 0, `state=${stateSeq[stateSeq.length - 1]} fuel=${fuelSeq[fuelSeq.length - 1]}`)
}

{
  const live = build()
  stepThrough(live, 10)
  const snap = live.snapshot()
  const atSnap = live.checksum()
  const liveSums = stepThrough(live, 15, 10)

  const restored = createFireKernel(config)
  restored.restore(snap)
  check('restore reproduces the checksum taken at snapshot time', restored.checksum() === atSnap, `snapshot=${atSnap} restored=${restored.checksum()}`)
  const restoredSums = stepThrough(restored, 15, 10)
  check('a restored kernel steps to the same checksums as the kernel it was snapshotted from', restoredSums.length === liveSums.length && restoredSums.every((v, i) => v === liveSums[i]))

  const again = createFireKernel(config)
  again.restore(snap)
  const againSums = stepThrough(again, 15, 10)
  check('restoring the same snapshot twice gives the same continuation', againSums.every((v, i) => v === restoredSums[i]))
}

{
  const dry = build()
  stepThrough(dry, 20)
  const wet = build()
  wet.setRain(0, 255, 2)
  const wetFuel = []
  stepThrough(wet, 20, 0, (kern) => wetFuel.push(kern.cellState(CENTRE.face, CENTRE.I, CENTRE.J).fuel))
  check('rain does not stop a burning cell from burning down its fuel', wetFuel[0] === 50 && wetFuel[1] === 40, `fuel=${wetFuel.slice(0, 4).join(',')}`)
  const drySpread = spreadOf(dry)
  const wetSpread = spreadOf(wet)
  check('full rain suppresses spread: fewer cells are touched than in the dry run', wetSpread < drySpread, `wet=${wetSpread} dry=${drySpread}`)
  check('the dry control really spreads beyond its ignition cell', drySpread > 1, `dry=${drySpread}`)
}

{
  const refusals = []
  const tryBuild = (patch, label) => {
    try { createFireKernel({ ...config, ...patch }); refusals.push(`${label}:accepted`) } catch (err) { refusals.push(`${label}:${err.constructor.name}`) }
  }
  tryBuild({ classes: [{ igniteHeat: 0 }] }, 'one-class')
  tryBuild({ stepTicks: 1 }, 'step-one')
  tryBuild({ maxActiveCells: 10, softActiveCells: 20 }, 'max-below-soft')
  check('kernel construction refuses a class list with no fuel class', refusals[0] === 'one-class:TypeError', refusals[0])
  check('kernel construction refuses a stepTicks below 2 with a RangeError', refusals[1] === 'step-one:RangeError', refusals[1])
  check('kernel construction refuses maxActiveCells below softActiveCells with a RangeError', refusals[2] === 'max-below-soft:RangeError', refusals[2])
}

const failed = checks.filter((c) => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`)
  process.exit(1)
}
console.log('RESULT: PASS fire kernel is deterministic, restores from snapshot, and rain suppresses spread without stopping burn-down')
process.exit(0)
