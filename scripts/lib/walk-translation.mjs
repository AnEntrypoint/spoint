export const LOCAL_POSITION_EXPR = `(() => {
  const c = window.__client && window.__client.getLocalState ? window.__client.getLocalState() : null
  const v = c && c.position
  if (!v) return null
  if (Array.isArray(v)) return [v[0], v[1], v[2]]
  if (typeof v.x === 'number') return [v.x, v.y, v.z]
  return null
})()`

export function asXYZ(v) {
  if (!v) return null
  if (Array.isArray(v)) {
    if (!Number.isFinite(v[0]) || !Number.isFinite(v[1])) return null
    return [v[0], v[1], Number.isFinite(v[2]) ? v[2] : 0]
  }
  if (typeof v.x === 'number' && typeof v.y === 'number') return [v.x, v.y, typeof v.z === 'number' ? v.z : 0]
  return null
}

export async function readLocalPosition(page) {
  const v = await page.evaluate(LOCAL_POSITION_EXPR).catch(() => null)
  return asXYZ(v)
}

export function walkExcursion(samples) {
  const pts = []
  for (const s of samples || []) {
    const p = asXYZ(s)
    if (p) pts.push(p)
  }
  if (!pts.length) return { samples: 0, maxExcursionM: null, pathM: null, netM: null }
  const a = pts[0]
  let maxExcursionM = 0
  let pathM = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const d = Math.hypot(p[0] - a[0], p[1] - a[1], p[2] - a[2])
    if (Number.isFinite(d) && d > maxExcursionM) maxExcursionM = d
    if (i > 0) {
      const q = pts[i - 1]
      const step = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
      if (Number.isFinite(step)) pathM += step
    }
  }
  const last = pts[pts.length - 1]
  const netM = Math.hypot(last[0] - a[0], last[1] - a[1], last[2] - a[2])
  return { samples: pts.length, maxExcursionM, pathM, netM }
}

const fmt = (v) => (v === null || v === undefined ? 'null' : (Number.isFinite(v) ? v.toFixed(2) : String(v)))

export function walkFloorFailure(samples, minM, what = 'the walk') {
  const e = walkExcursion(samples)
  if (e.samples < 2) return `${what} took ${e.samples} position sample(s), so its displacement was never read; an unread displacement is not a walk`
  if (!(e.maxExcursionM >= minM)) {
    return `${what} carried the player ${fmt(e.maxExcursionM)} m from where it started (path ${fmt(e.pathM)} m, net ${fmt(e.netM)} m over ${e.samples} sample(s)), under the ${minM} m floor -- a walk that does not translate is an idle window wearing the wrong label, so this figure is refused, not published`
  }
  return null
}
