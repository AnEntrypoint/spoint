import { packQuat, unpackQuat } from '../src/netcode/SnapshotBinFormat.js'
import { flagNumber } from './lib/witness-args.mjs'

const flag = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='))
  return hit ? hit.slice(name.length + 3) : dflt
}
const SEED = flagNumber(flag, 'seed', 20261011, process.argv.slice(2))
const CASES = Math.max(1, flagNumber(flag, 'cases', 3000, process.argv.slice(2)))

function mulberry32(a) {
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = (rng, atoms) => atoms[Math.floor(rng() * atoms.length) % atoms.length]

const QUAT = [0, 1, -1, 0.5, -0.5, 2]
const NONFINITE = [NaN, Infinity, -Infinity]
const QN = QUAT.concat(NONFINITE)
const AXIS_IDX = [0, 1, 2, 3]
const AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 2, -3]]
const PACKED = [0, 1, 511, 512, 535822335, 1073741823, 2147483648, 3221225471, 3756525567, 4294967295]
const BASIS = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]

const LEN_TOL = 0.01
const ORTH_TOL = 0.01
const DET_TOL = 0.05
const SIGN_TOL = 1e-12

const unit = (a, b, c, d) => {
  const n = Math.hypot(a, b, c, d)
  return n > 0 ? [a / n, b / n, c / n, d / n] : [0, 0, 0, 1]
}

function applyTo(q, u) {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3]
  const ux = u[0], uy = u[1], uz = u[2]
  const along = qx * ux + qy * uy + qz * uz
  const normPart = qw * qw - (qx * qx + qy * qy + qz * qz)
  return [
    normPart * ux + 2 * along * qx + 2 * qw * (qy * uz - qz * uy),
    normPart * uy + 2 * along * qy + 2 * qw * (qz * ux - qx * uz),
    normPart * uz + 2 * along * qz + 2 * qw * (qx * uy - qy * ux),
  ]
}

const len = (v) => Math.hypot(v[0], v[1], v[2])
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const det3 = (a, b, c) =>
  a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])
const near3 = (a, b, tol) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol

const roundTrip = (q) => unpackQuat(packQuat(q[0], q[1], q[2], q[3]), [0, 0, 0, 0])
const negated = (q) => [-q[0], -q[1], -q[2], -q[3]]

const unitFrame = (q) => {
  const r = roundTrip(q)
  return BASIS.map((b) => applyTo(r, b))
}

const frameIsRigid = (frame) =>
  frame.every((f) => Math.abs(len(f) - 1) <= LEN_TOL)
  && Math.abs(dot3(frame[0], frame[1])) <= ORTH_TOL
  && Math.abs(dot3(frame[0], frame[2])) <= ORTH_TOL
  && Math.abs(dot3(frame[1], frame[2])) <= ORTH_TOL
  && Math.abs(det3(frame[0], frame[1], frame[2]) - 1) <= DET_TOL

const RELATIONS = [
  {
    id: 'quat-sign-invariant',
    atoms: { a: QUAT, b: QUAT, c: QUAT, d: QUAT, axis: AXIS_IDX },
    prop: (k) => {
      const q = unit(k.a, k.b, k.c, k.d)
      const v = AXES[k.axis]
      return near3(applyTo(roundTrip(q), v), applyTo(roundTrip(negated(q)), v), SIGN_TOL)
    },
  },
  {
    id: 'quat-frame-rigid',
    atoms: { a: QUAT, b: QUAT, c: QUAT, d: QUAT },
    prop: (k) => frameIsRigid(unitFrame(unit(k.a, k.b, k.c, k.d))),
  },
  {
    id: 'quat-wire-frame-rigid',
    atoms: { packed: PACKED },
    prop: (k) => {
      let r
      try { r = unpackQuat(k.packed, [0, 0, 0, 0]) } catch (_e) { return true }
      return frameIsRigid(BASIS.map((b) => applyTo(r, b)))
    },
  },
  {
    id: 'quat-nonfinite-propagates',
    atoms: { a: QN, b: QN, c: QN, d: QN },
    prop: (k) => {
      const poisoned = !Number.isFinite(k.a) || !Number.isFinite(k.b) || !Number.isFinite(k.c) || !Number.isFinite(k.d)
      if (!poisoned) return true
      let r
      try { r = unpackQuat(packQuat(k.a, k.b, k.c, k.d), [0, 0, 0, 0]) } catch (_e) { return true }
      return !r.every(Number.isFinite)
    },
  },
]

const KNOWN = []

const render = (c) => JSON.stringify(c, (_k, v) => {
  if (typeof v === 'number' && !Number.isFinite(v)) return Number.isNaN(v) ? 'NaN' : v > 0 ? 'Infinity' : '-Infinity'
  return v
})

const shrink = (relation, failing) => {
  let cur = failing
  for (let pass = 0; pass < 8; pass++) {
    let moved = false
    for (const field of Object.keys(relation.atoms)) {
      const atoms = relation.atoms[field]
      const at = atoms.findIndex((a) => Object.is(a, cur[field]))
      for (let i = 0; i < at; i++) {
        const trial = { ...cur, [field]: atoms[i] }
        if (!relation.prop(trial)) { cur = trial; moved = true; break }
      }
    }
    if (!moved) break
  }
  return cur
}

const weight = (c) => Object.keys(c).reduce((n, k) => n + (Number.isFinite(c[k]) && Math.abs(c[k]) <= 1000 ? 0 : 1), 0)
const better = (a, b) => (weight(a) !== weight(b) ? weight(a) < weight(b) : render(a) < render(b))

const canonicalize = (relation, c) => {
  let cur = c
  for (let pass = 0; pass < 8; pass++) {
    let moved = false
    for (const field of Object.keys(relation.atoms)) {
      let bestTrial = null
      for (const atom of relation.atoms[field]) {
        if (Object.is(atom, cur[field])) continue
        const trial = { ...cur, [field]: atom }
        if (relation.prop(trial)) continue
        if (bestTrial === null || better(trial, bestTrial)) bestTrial = trial
      }
      if (bestTrial !== null && better(bestTrial, cur)) { cur = bestTrial; moved = true }
    }
    for (const fa of Object.keys(relation.atoms)) {
      for (const fb of Object.keys(relation.atoms)) {
        if (fa === fb) continue
        for (const aa of relation.atoms[fa]) {
          for (const ab of relation.atoms[fb]) {
            const trial = { ...cur, [fa]: aa, [fb]: ab }
            if (relation.prop(trial)) continue
            if (better(trial, cur)) { cur = trial; moved = true }
          }
        }
      }
    }
    if (!moved) break
  }
  return cur
}

const rng = mulberry32(SEED)
const open = []
for (const r of RELATIONS) {
  let failing = null
  for (let i = 0; i < CASES && failing === null; i++) {
    const c = {}
    for (const field of Object.keys(r.atoms)) c[field] = pick(rng, r.atoms[field])
    if (!r.prop(c)) failing = c
  }
  if (failing === null) {
    console.log('RELATION ' + r.id + ' cases=' + CASES + ' status=held')
    continue
  }
  const minimal = canonicalize(r, shrink(r, failing))
  console.log('RELATION ' + r.id + ' status=open')
  console.log('SHRUNK ' + r.id + ' ' + render(minimal))
  open.push({ id: r.id, shrunk: render(minimal) })
}

const observed = JSON.stringify(open)
const expected = JSON.stringify(KNOWN)
if (observed !== expected) {
  console.log('KNOWN ' + expected)
  console.log('OBSERVED ' + observed)
  console.log('RESULT: FAIL')
  process.exit(1)
}
console.log('OPEN ' + open.length + ' known-minimized')
console.log('RESULT: PASS')
