const TRAIL_CAPACITY = 4

export function createStepTrail() {
  const times = new Float64Array(TRAIL_CAPACITY)
  const points = new Float64Array(TRAIL_CAPACITY * 3)
  let head = 0, count = 0

  function slot(i) { return (head + i) % TRAIL_CAPACITY }

  function push(t, x, y, z) {
    if (count > 0 && !(t > times[slot(count - 1)])) { count = 0; head = 0 }
    if (count === TRAIL_CAPACITY) { head = (head + 1) % TRAIL_CAPACITY; count-- }
    const s = slot(count)
    times[s] = t; points[s * 3] = x; points[s * 3 + 1] = y; points[s * 3 + 2] = z
    count++
  }

  function shift(dx, dy, dz) {
    for (let i = 0; i < count; i++) { const s = slot(i) * 3; points[s] += dx; points[s + 1] += dy; points[s + 2] += dz }
  }

  function sample(t, out) {
    if (count < 2 || !Number.isFinite(t)) return false
    let b = count - 1
    while (b > 1 && times[slot(b - 1)] > t) b--
    const sa = slot(b - 1), sb = slot(b)
    const span = times[sb] - times[sa]
    const u = Math.min(1, Math.max(0, (t - times[sa]) / span))
    out[0] = points[sa * 3] + (points[sb * 3] - points[sa * 3]) * u
    out[1] = points[sa * 3 + 1] + (points[sb * 3 + 1] - points[sa * 3 + 1]) * u
    out[2] = points[sa * 3 + 2] + (points[sb * 3 + 2] - points[sa * 3 + 2]) * u
    return true
  }

  function reset() { head = 0; count = 0 }

  return { push, shift, sample, reset, get length() { return count } }
}
