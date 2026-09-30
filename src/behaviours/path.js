export function definePath(points) {
  if (!Array.isArray(points) || points.length < 2) throw new TypeError('[path] need >= 2 points')
  const pts = points.map(p => [p[0], p[1], p[2]])
  const n = pts.length
  const segLens = new Array(n - 1)
  const cumulativeDist = new Array(n)
  cumulativeDist[0] = 0
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i], b = pts[i + 1]
    const d = Math.hypot(b[0]-a[0], b[1]-a[1], b[2]-a[2])
    segLens[i] = d
    cumulativeDist[i + 1] = cumulativeDist[i] + d
  }
  const total = cumulativeDist[n - 1]

  const segmentAt = (distance) => {
    let d = Math.max(0, Math.min(total, distance))
    for (let i = 0; i < n - 1; i++) {
      if (d <= cumulativeDist[i + 1] || i === n - 2) {
        const segLen = segLens[i] || 1e-9
        return { index: i, t: Math.max(0, Math.min(1, (d - cumulativeDist[i]) / segLen)) }
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
      if (d < bestD) { bestD = d; bestAlong = cumulativeDist[i] + Math.sqrt(segLen2) * t }
    }
    return total > 0 ? bestAlong / total : 0
  }

  return { length: total, count: n, pointAt, progressAt, nearestIndex, segmentAt, directionAt }
}

export default definePath
