export class TerrainMarkError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TerrainMarkError'
    this.reasonCode = code
  }
}

const KINDS = Object.freeze(['sea', 'lake', 'river', 'flatten', 'path'])

const clamp01 = (v) => Math.min(1, Math.max(0, v))
const smooth = (t) => t * t * (3 - 2 * t)

function circleWeight(dist, radius, falloff) {
  if (dist <= radius) return 1
  if (!(falloff > 0) || dist >= radius + falloff) return 0
  return 1 - smooth((dist - radius) / falloff)
}

function nearestOnSegment(px, pz, a, b) {
  const dx = b[0] - a[0]
  const dz = b[1] - a[1]
  const len2 = dx * dx + dz * dz
  const t = len2 > 0 ? clamp01(((px - a[0]) * dx + (pz - a[1]) * dz) / len2) : 0
  return { t, dist: Math.hypot(px - (a[0] + dx * t), pz - (a[1] + dz * t)) }
}

function nearestOnPolyline(px, pz, points) {
  let best = null
  for (let i = 0; i + 1 < points.length; i += 1) {
    const hit = nearestOnSegment(px, pz, points[i], points[i + 1])
    if (best === null || hit.dist < best.dist) best = { ...hit, i }
  }
  return best
}

function levelAt(a, b, t) {
  const la = a[2] ?? 0
  const lb = b[2] ?? 0
  return la + (lb - la) * t
}

function refuse(mark) {
  throw new TerrainMarkError('terrain-mark-unknown-kind', `terrain mark kind ${JSON.stringify(mark?.kind)} is not one of ${KINDS.join(', ')}`)
}

function compileMark(mark) {
  if (!KINDS.includes(mark?.kind)) refuse(mark)
  if (mark.kind === 'sea') {
    const level = mark.level ?? 0
    return { surface: () => level, height: (x, z, h) => h, path: () => false }
  }
  if (mark.kind === 'lake') {
    const level = mark.level ?? 0
    const depth = mark.depth ?? 0
    const { x: cx, z: cz } = mark.at
    const radius = mark.radius
    const inside = (x, z) => Math.hypot(x - cx, z - cz) <= radius
    return {
      surface: (x, z) => (inside(x, z) ? level : null),
      height: (x, z, h) => (inside(x, z) && depth > 0 ? Math.min(h, level - depth) : h),
      path: () => false,
    }
  }
  if (mark.kind === 'river') {
    const points = mark.points
    const half = mark.width * 0.5
    const depth = mark.depth ?? 0
    const near = (x, z) => nearestOnPolyline(x, z, points)
    const inChannel = (hit) => hit !== null && hit.dist <= half
    return {
      surface: (x, z) => {
        const hit = near(x, z)
        return inChannel(hit) ? levelAt(points[hit.i], points[hit.i + 1], hit.t) : null
      },
      height: (x, z, h) => {
        const hit = near(x, z)
        if (!inChannel(hit) || !(depth > 0)) return h
        return Math.min(h, levelAt(points[hit.i], points[hit.i + 1], hit.t) - depth)
      },
      path: () => false,
    }
  }
  if (mark.kind === 'flatten') {
    const { x: cx, z: cz } = mark.center
    const radius = mark.shape.radius
    const falloff = mark.falloff ?? 0
    return {
      surface: () => null,
      height: (x, z, h) => {
        const w = circleWeight(Math.hypot(x - cx, z - cz), radius, falloff)
        return h + (mark.height - h) * w
      },
      path: () => false,
    }
  }
  const half = mark.width * 0.5
  return {
    surface: () => null,
    height: (x, z, h) => h,
    path: (x, z) => {
      const hit = nearestOnPolyline(x, z, mark.points)
      return hit !== null && hit.dist <= half
    },
  }
}

export function createTerrainMarks(marks = []) {
  const compiled = Object.values(marks).map(compileMark)
  return {
    heightAt(x, z, base) {
      let h = base
      for (const m of compiled) h = m.height(x, z, h)
      return h
    },
    waterLevelAt(x, z, base) {
      const ground = this.heightAt(x, z, base)
      let level = null
      for (const m of compiled) {
        const s = m.surface(x, z)
        if (s !== null && s > ground && (level === null || s > level)) level = s
      }
      return level
    },
    onPath(x, z) {
      return compiled.some((m) => m.path(x, z))
    },
  }
}
