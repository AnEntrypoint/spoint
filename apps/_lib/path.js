// definePath(points) -> an ordered-waypoint path helper: progress-along, nearest-point, point-at-distance.
// Racing checkpoints in order, AI patrol routes, payload tracks, guided-tour cameras all need "where am I
// along this ordered list of points" and "give me the point N metres in". Pure geometry, no ctx needed.
//
// points: [[x,y,z], ...] (>= 2). Returns {
//   length,                       // total path length in m
//   count,                        // number of waypoints
//   pointAt(distance),            // world point `distance` metres along the path (clamped)
//   progressAt(pos),              // 0..1 how far along the path the nearest point to `pos` is
//   nearestIndex(pos),            // index of the nearest waypoint to `pos`
//   segmentAt(distance),          // { index, t } which segment + local 0..1 param at `distance`
//   directionAt(distance),        // unit tangent [dx,dy,dz] at `distance`
// }
export function definePath(points) {
  if (!Array.isArray(points) || points.length < 2) throw new TypeError('[path] need >= 2 points')
  const pts = points.map(p => [p[0], p[1], p[2]])
  const n = pts.length
  // cumulative distance to the START of each segment (segLens[i] = length of segment i)
  const segLens = new Array(n - 1)
  const cum = new Array(n)
  cum[0] = 0
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i], b = pts[i + 1]
    const d = Math.hypot(b[0]-a[0], b[1]-a[1], b[2]-a[2])
    segLens[i] = d
    cum[i + 1] = cum[i] + d
  }
  const total = cum[n - 1]

  const segmentAt = (distance) => {
    let d = Math.max(0, Math.min(total, distance))
    for (let i = 0; i < n - 1; i++) {
      if (d <= cum[i + 1] || i === n - 2) {
        const segLen = segLens[i] || 1e-9
        return { index: i, t: Math.max(0, Math.min(1, (d - cum[i]) / segLen)) }
      }
    }
    return { index: n - 2, t: 1 }
  }
  const pointAt = (distance) => {
    const { index, t } = segmentAt(distance)
    const a = pts[index], b = pts[index + 1]
    return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t]
  }
  const directionAt = (distance) => {
    const { index } = segmentAt(distance)
    const a = pts[index], b = pts[index + 1]
    const dx = b[0]-a[0], dy = b[1]-a[1], dz = b[2]-a[2]
    const l = Math.hypot(dx, dy, dz) || 1
    return [dx/l, dy/l, dz/l]
  }
  const nearestIndex = (pos) => {
    let best = 0, bestD = Infinity
    for (let i = 0; i < n; i++) {
      const p = pts[i]; const dx = p[0]-pos[0], dy = p[1]-pos[1], dz = p[2]-pos[2]
      const d = dx*dx+dy*dy+dz*dz
      if (d < bestD) { bestD = d; best = i }
    }
    return best
  }
  // Project pos onto each segment, take the closest point, return its distance-along / total.
  const progressAt = (pos) => {
    let bestD = Infinity, bestAlong = 0
    for (let i = 0; i < n - 1; i++) {
      const a = pts[i], b = pts[i + 1]
      const abx = b[0]-a[0], aby = b[1]-a[1], abz = b[2]-a[2]
      const segLen2 = abx*abx+aby*aby+abz*abz || 1e-9
      let t = ((pos[0]-a[0])*abx + (pos[1]-a[1])*aby + (pos[2]-a[2])*abz) / segLen2
      t = Math.max(0, Math.min(1, t))
      const cx = a[0]+abx*t, cy = a[1]+aby*t, cz = a[2]+abz*t
      const dx = pos[0]-cx, dy = pos[1]-cy, dz = pos[2]-cz
      const d = dx*dx+dy*dy+dz*dz
      if (d < bestD) { bestD = d; bestAlong = cum[i] + Math.sqrt(segLen2) * t }
    }
    return total > 0 ? bestAlong / total : 0
  }

  return { length: total, count: n, pointAt, progressAt, nearestIndex, segmentAt, directionAt }
}

export default definePath
