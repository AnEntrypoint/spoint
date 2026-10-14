// A walk window is a claim about a player that travelled. On a `?singleplayer` page the
// authoritative player does not advance and the client is corrected back to spawn every server
// tick, so 12 s of a commanded 7 m/s (84 m of route) nets 0.38 m as a 0.7 m sawtooth, while the
// same keys on `?multiplayer` net 37.72 m monotonic with no snap-back (row
// PERF-singleplayer-walk-arms-1013, measured on one page with CDP Input.dispatchKeyEvent KeyW; the
// intended idle arm is `perf-run.mjs --no-walk`, which empties the movement legs).
//
// PATH LENGTH does not separate those two: summing |p[i] - p[i-1]| counts the snap-back as travel,
// so a rubber-banding player reports tens of metres of "travel" while never leaving its spawn --
// `landscape-change-hitch-witness.mjs`'s `travelled > 30` and
// `grass-density-fade-visual-witness.mjs`'s `pathM > 20` both pass on a stationary player. The
// metric that separates them is the EXCURSION: how far the player got from where the window
// started. A snap-back returns to the start, so its excursion is the sawtooth amplitude; a walk
// does not, so its excursion is the route it covered.
//
// NET displacement is the wrong metric in the other direction: a four-leg square route (perf-run's
// KeyW/KeyD/KeyS/KeyA) finishes where it began, so its net is ~0 while it genuinely walked.
// Excursion is measured from the FIRST sample of the window, which is what makes it correct for
// both shapes.

// getLocalState().position is an ARRAY [x, y, z], not {x, y, z}: reading .x off it yields
// undefined and Math.hypot(NaN, NaN) is NaN, so a displacement that prints as a number is really a
// gap. Every read in here goes through asXYZ, which is why it accepts either shape and returns a
// copied 3-tuple of finite numbers or null.
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

// `samples` is the ordered list of reads taken during the walk window.
// maxExcursionM is the farthest any sample got from the FIRST sample -- the number a snap-back
// cannot inflate. pathM and netM are reported alongside it, never used as the floor.
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

// Returns null when the walk translated, or the string to fail the run with when it did not.
// A window that took fewer than 2 samples never read a displacement at all, and an unread
// displacement is not a walk either -- otherwise "no samples" reads as "0 m" and passes a >=0 floor.
export function walkFloorFailure(samples, minM, what = 'the walk') {
  const e = walkExcursion(samples)
  if (e.samples < 2) return `${what} took ${e.samples} position sample(s), so its displacement was never read; an unread displacement is not a walk`
  if (!(e.maxExcursionM >= minM)) {
    return `${what} carried the player ${fmt(e.maxExcursionM)} m from where it started (path ${fmt(e.pathM)} m, net ${fmt(e.netM)} m over ${e.samples} sample(s)), under the ${minM} m floor -- a walk that does not translate is an idle window wearing the wrong label, so this figure is refused, not published`
  }
  return null
}
