import { createChartTransfer } from '../src/shared/chartTransfer.js'
import { createReexpressPass } from '../src/shared/chartReexpress.js'
import { createEntityMigrator } from '../src/sdk/chartState/migrateEntities.js'

const TOL = 1e-9
const RADIUS_M = 6371000
const POINT_TOL = TOL + 8 * Number.EPSILON * RADIUS_M
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1]

function matMul(a, b) {
  const out = new Array(9)
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
  }
  return out
}

function rotX(t) { const c = Math.cos(t), s = Math.sin(t); return [1, 0, 0, 0, c, -s, 0, s, c] }
function rotY(t) { const c = Math.cos(t), s = Math.sin(t); return [c, 0, s, 0, 1, 0, -s, 0, c] }
function rotZ(t) { const c = Math.cos(t), s = Math.sin(t); return [c, -s, 0, s, c, 0, 0, 0, 1] }

function chartOf(R, anchorHeight, offsetY) {
  return {
    radius: RADIUS_M,
    anchorHeight,
    offsetY,
    east: [R[0], R[3], R[6]],
    up: [R[1], R[4], R[7]],
    north: [R[2], R[5], R[8]],
  }
}

function axisAngleQuat(axis, angle) {
  const n = Math.hypot(...axis)
  const s = Math.sin(angle / 2) / n
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)]
}

function rotateVec(q, v) {
  const [qx, qy, qz, qw] = q
  const tx = 2 * (qy * v[2] - qz * v[1])
  const ty = 2 * (qz * v[0] - qx * v[2])
  const tz = 2 * (qx * v[1] - qy * v[0])
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ]
}

const FORWARD = [0, 0, -1]

function maxAbsDiff(a, b) {
  return Math.max(...a.map((v, i) => Math.abs(v - b[i])))
}

function makeRuntime(entities) {
  return {
    entities: new Map(entities.map(e => [e.id, e])),
    getPlayers: () => [],
    _attachments: new Map(),
    _physics: null,
    apps: new Map(),
    contexts: new Map(),
    _behaviours: new Map(),
    _markDirty() {},
    _staticVersion: 0,
    _snapshotEncCache: new Map(),
    _staticXf: new Map(),
    _playerIndex: { insert() {} },
    _safeCall() {},
    _logAppError() {},
  }
}

function freshEntities() {
  return [
    {
      id: 'static-root',
      bodyType: 'static',
      position: [12.5, 40.25, -310.75],
      velocity: [1.5, -2.25, 0.75],
      rotation: axisAngleQuat([0.3, 0.8, -0.5], 0.9),
      _spawnPosition: [11, 40, -300],
    },
    {
      id: 'dynamic-root',
      bodyType: 'dynamic',
      position: [-88.5, 17.125, 402.5],
      velocity: [-3.25, 0.5, 2.125],
      rotation: axisAngleQuat([-0.6, 0.2, 0.7], 2.1),
      _spawnPosition: [-90, 17, 400],
    },
  ]
}

const chartA = chartOf(IDENTITY, 0, 0)
const chartB = chartOf(matMul(matMul(rotZ(0.7), rotX(-0.4)), rotY(1.1)), 3, 0.5)
const fwd = createChartTransfer(chartA, chartB)
const inv = createChartTransfer(chartB, chartA)

const originals = freshEntities()
const entities = freshEntities()
const runtime = makeRuntime(entities)
const migrateEntities = createEntityMigrator({ appRuntime: runtime, staticBudgetMs: 1 })
migrateEntities({ epoch: 1, transfer: fwd, from: chartA, to: chartB }, createReexpressPass(fwd))

let failures = 0
const report = (entityId, check, err, tol = TOL) => {
  const ok = err <= tol
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${entityId} ${check} maxAbsErr=${err.toExponential(3)} tol=${tol.toExponential(3)}`)
}

for (const original of originals) {
  const after = entities.find(e => e.id === original.id)
  report(original.id, 'one-way position invariant', maxAbsDiff(inv.point(after.position), original.position), POINT_TOL)
  report(original.id, 'one-way spawn position invariant', maxAbsDiff(inv.point(after._spawnPosition), original._spawnPosition), POINT_TOL)
  report(original.id, 'one-way velocity invariant', maxAbsDiff(inv.vec(after.velocity), original.velocity))
  report(original.id, 'one-way forward invariant', maxAbsDiff(inv.vec(rotateVec(after.rotation, FORWARD)), rotateVec(original.rotation, FORWARD)))
}

migrateEntities({ epoch: 2, transfer: inv, from: chartB, to: chartA }, createReexpressPass(inv))

for (const original of originals) {
  const after = entities.find(e => e.id === original.id)
  report(original.id, 'round-trip position', maxAbsDiff(after.position, original.position), POINT_TOL)
  report(original.id, 'round-trip spawn position', maxAbsDiff(after._spawnPosition, original._spawnPosition), POINT_TOL)
  report(original.id, 'round-trip velocity', maxAbsDiff(after.velocity, original.velocity))
  report(original.id, 'round-trip forward', maxAbsDiff(rotateVec(after.rotation, FORWARD), rotateVec(original.rotation, FORWARD)))
}

console.log(failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures} checks above tolerance)`)
process.exit(failures === 0 ? 0 : 1)
