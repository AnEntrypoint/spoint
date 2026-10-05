export function yawOfQuat(q) {
  return 2 * Math.atan2(q[1], q[3])
}

export function setYawQuat(q, yaw) {
  const half = yaw / 2
  q[0] = 0; q[1] = Math.sin(half); q[2] = 0; q[3] = Math.cos(half)
  return q
}

export function reexpressYawQuat(transfer, q) {
  return setYawQuat(q, transfer.look(yawOfQuat(q), 0).yaw)
}

export function reexpressLook(transfer, holder, yawKey = 'yaw', pitchKey = 'pitch') {
  const hasYaw = Number.isFinite(holder[yawKey]), hasPitch = Number.isFinite(holder[pitchKey])
  if (!hasYaw && !hasPitch) return holder
  const look = transfer.look(hasYaw ? holder[yawKey] : 0, hasPitch ? holder[pitchKey] : 0)
  if (hasYaw) holder[yawKey] = look.yaw
  if (hasPitch) holder[pitchKey] = look.pitch
  return holder
}

const TILT_BOUND_MARGIN = 1.1
const TILT_BOUND_FLOOR_MPS = 1e-3

export function clampTiltInducedUpward(transfer, v) {
  if (!(v[1] > 0)) return false
  const bound = Math.hypot(v[0], v[2]) * transfer.tiltRad * TILT_BOUND_MARGIN + TILT_BOUND_FLOOR_MPS
  if (v[1] > bound) return false
  v[1] = 0
  return true
}

const SAME_CHART_EPS = 1e-12

export function sameChart(a, b) {
  const near = (u, v) => u.every((c, i) => Math.abs(c - v[i]) <= SAME_CHART_EPS)
  return a.radius === b.radius && a.anchorHeight === b.anchorHeight && a.offsetY === b.offsetY && near(a.east, b.east) && near(a.up, b.up) && near(a.north, b.north)
}

export function createReexpressPass(transfer) {
  const seen = new Set()
  const first = target => {
    if (seen.has(target)) return false
    seen.add(target)
    return true
  }
  return {
    transfer,
    get distinctTargets() { return seen.size },
    point(p) { if (p && first(p)) transfer.point(p, p) },
    vector(v) { if (v && first(v)) transfer.vec(v, v) },
    rotation(q) { if (q && first(q)) transfer.quat(q, q) },
    yawRotation(q) { if (q && first(q)) reexpressYawQuat(transfer, q) },
    look(holder, yawKey, pitchKey) { if (holder && first(holder)) reexpressLook(transfer, holder, yawKey, pitchKey) },
    clear(list) { if (list && first(list)) list.length = 0 },
  }
}
