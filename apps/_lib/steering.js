import { createComponentPool } from './ComponentPool.js'

const MIN_STEER_DIST = 1e-4

const _pool = createComponentPool({ fields: { speed: 'f64', arriveRadius: 'f64', separation: 'f64', clampToTerrain: 'f64', yOffset: 'f64', useNavCost: 'f64' } })
let _speed = _pool.column('speed'), _arriveRadius = _pool.column('arriveRadius'), _separation = _pool.column('separation')
let _clampToTerrain = _pool.column('clampToTerrain'), _yOffset = _pool.column('yOffset'), _useNavCost = _pool.column('useNavCost')
let _epoch = _pool.epoch
function _refreshColumnsIfPoolGrew() {
  if (_epoch === _pool.epoch) return
  _speed = _pool.column('speed'); _arriveRadius = _pool.column('arriveRadius'); _separation = _pool.column('separation')
  _clampToTerrain = _pool.column('clampToTerrain'); _yOffset = _pool.column('yOffset'); _useNavCost = _pool.column('useNavCost')
  _epoch = _pool.epoch
}

function _clampY(slot, appCtx, x, y, z) {
  if (_clampToTerrain[slot] !== 1 || typeof appCtx.terrainHeightAt !== 'function') return y
  const h = appCtx.terrainHeightAt(x, z)
  return (typeof h === 'number' && Number.isFinite(h)) ? h + _yOffset[slot] : y
}

function _stepImpl(slot, appCtx, from, target, dt, peers) {
  _refreshColumnsIfPoolGrew()
  const speed = _speed[slot]
  const arriveRadius = _arriveRadius[slot]
  const separation = _separation[slot]
  const sep2 = separation * separation
  const fx = from[0], fy = from[1], fz = from[2]
  let vx = target[0] - fx, vz = target[2] - fz
  const dist = Math.hypot(vx, vz)
  let sp = speed
  const withinArriveRadius = dist <= arriveRadius
  if (withinArriveRadius) sp = dist > MIN_STEER_DIST ? speed * (dist / arriveRadius) : 0
  if (_useNavCost[slot] === 1 && typeof appCtx.navCostAt === 'function' && dist > MIN_STEER_DIST) {
    const cost = appCtx.navCostAt(fx, fz)
    if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) sp = sp / cost
  }
  if (dist > MIN_STEER_DIST) { vx = (vx / dist) * sp; vz = (vz / dist) * sp } else { vx = 0; vz = 0 }
  if (separation > 0 && peers && peers.length) {
    let sx = 0, sz = 0, n = 0
    for (let i = 0; i < peers.length; i++) {
      const p = peers[i]; const dx = fx - p[0], dz = fz - p[2]; const d2 = dx * dx + dz * dz
      if (d2 > 1e-6 && d2 < sep2) { const d = Math.sqrt(d2); sx += (dx / d) * (1 - d / separation); sz += (dz / d) * (1 - d / separation); n++ }
    }
    if (n) { vx += sx * speed; vz += sz * speed }
  }
  const nx = fx + vx * dt, nz = fz + vz * dt
  const ny = _clampY(slot, appCtx, nx, fy + (vx === 0 && vz === 0 ? 0 : 0), nz)
  return { position: [nx, ny, nz], velocity: [vx, 0, vz], arrived: withinArriveRadius }
}

export function defineSteering(spec = {}, appCtx) {
  if (!appCtx) throw new TypeError('[steering] appCtx is required')
  if (spec.speed != null && (typeof spec.speed !== 'number' || !Number.isFinite(spec.speed) || spec.speed < 0)) {
    throw new TypeError('[steering] speed must be a non-negative finite number')
  }
  const slot = _pool.alloc()
  _refreshColumnsIfPoolGrew()
  _speed[slot] = spec.speed ?? 3
  _arriveRadius[slot] = spec.arriveRadius ?? 0.5
  _separation[slot] = spec.separation ?? 0
  _clampToTerrain[slot] = spec.clampToTerrain ? 1 : 0
  _yOffset[slot] = spec.yOffset ?? 0
  _useNavCost[slot] = spec.useNavCost ? 1 : 0
  let _disposed = false

  const steering = {
    step(from, target, dt, peers) { return _stepImpl(slot, appCtx, from, target, dt, peers) },
    followPath(from, waypoints, dt, state, peers) {
      const st = state || { i: 0 }
      if (!waypoints || st.i >= waypoints.length) return { position: [...from], velocity: [0, 0, 0], done: true, state: st }
      const r = _stepImpl(slot, appCtx, from, waypoints[st.i], dt, peers)
      const arriveRadius = _arriveRadius[slot]
      if (r.arrived && Math.hypot(waypoints[st.i][0] - r.position[0], waypoints[st.i][2] - r.position[2]) <= arriveRadius) st.i++
      return { position: r.position, velocity: r.velocity, done: st.i >= waypoints.length, state: st }
    },
  }
  if (typeof appCtx._registerDisposer === 'function') {
    appCtx._registerDisposer(() => { if (_disposed) return; _disposed = true; _pool.free(slot) })
  }
  return steering
}

export default defineSteering
