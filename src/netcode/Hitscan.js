import { buildLiveIndex } from './RewindSpatialIndex.js'

export const DEFAULT_HITBOX = Object.freeze({ centerHeight: 0.9, radiusSq: 0.36, height: 1.8 })

export function normalizeShotDirection(d) {
  if (!Array.isArray(d) || d.length !== 3 || !d.every(Number.isFinite)) return null
  const m = Math.max(Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2]))
  if (!(m > 0)) return null
  const x = d[0] / m, y = d[1] / m, z = d[2] / m, len = Math.hypot(x, y, z)
  return [x / len, y / len, z / len]
}

export function resolveFireRequest(lagComp, shooterId, shooterPosition, msg, hitbox = DEFAULT_HITBOX) {
  const eye = [shooterPosition[0], shooterPosition[1] + hitbox.centerHeight, shooterPosition[2]]
  if (!lagComp) return { origin: eye, viewTick: null }
  const origin = lagComp.validateShotOrigin(shooterPosition, msg.origin, hitbox.centerHeight)
  const viewTick = lagComp.acceptRewind(shooterId) ? lagComp.resolveViewTick(msg.viewTick) : null
  return { origin, viewTick }
}

export function resolveTargetPoint(target, lagComp, viewTick) {
  const rewound = viewTick != null && lagComp ? lagComp.rewindAtTick(target.id, viewTick) : null
  return { tp: rewound ? [...rewound.position] : target.state.position, rewound }
}

export function rayVsCapsule(origin, direction, range, tp, hitbox = DEFAULT_HITBOX) {
  const toTarget = [tp[0] - origin[0], tp[1] + hitbox.centerHeight - origin[1], tp[2] - origin[2]]
  const dot = toTarget[0] * direction[0] + toTarget[1] * direction[1] + toTarget[2] * direction[2]
  if (dot < 0 || dot > range) return null
  const proj = [origin[0] + direction[0] * dot, origin[1] + direction[1] * dot, origin[2] + direction[2] * dot]
  const ddx = proj[0] - tp[0], ddy = proj[1] - (tp[1] + hitbox.centerHeight), ddz = proj[2] - tp[2]
  const d2 = ddx * ddx + ddy * ddy + ddz * ddz
  if (d2 > hitbox.radiusSq) return null
  return { proj, dot }
}

export function hitHeightRatio(proj, tp, hitbox = DEFAULT_HITBOX) {
  return (proj[1] - tp[1]) / hitbox.height
}

function testTarget(target, shot) {
  if (!target || !target.state || target.id === shot.shooterId) return null
  if (shot.isTargetable && !shot.isTargetable(target)) return null
  const resolved = resolveTargetPoint(target, shot.lagComp, shot.viewTick)
  const hit = rayVsCapsule(shot.origin, shot.direction, shot.range, resolved.tp, shot.hitbox || DEFAULT_HITBOX)
  return hit ? { target, tp: resolved.tp, rewound: resolved.rewound, proj: hit.proj, dot: hit.dot } : null
}

export function findHitLinear(players, shot) {
  for (const target of players) {
    const found = testTarget(target, shot)
    if (found) return found
  }
  return null
}

export function findHitSpatial(players, shot, liveIndex = null) {
  const index = liveIndex || buildLiveIndex(players)
  const byId = index.playersById || new Map(players.map(p => [p.id, p]))
  const seen = new Set()
  let nearest = null
  let nearestDot = Infinity
  let nearestOrder = Infinity
  index.queryRay(shot.origin, shot.direction, shot.range, (entry) => {
    if (seen.has(entry.id)) return
    seen.add(entry.id)
    const found = testTarget(byId.get(entry.id), shot)
    if (!found) return
    const order = index.arrayIndexOf ? index.arrayIndexOf(entry.id) : -1
    const closer = found.dot < nearestDot || (found.dot === nearestDot && order < nearestOrder)
    if (!closer) return
    nearest = found
    nearestDot = found.dot
    nearestOrder = order
  })
  return nearest
}

export { buildLiveIndex }
