export function summarize(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return { n: 0, mean: null, p50: null, p95: null, p99: null, max: null }
  const at = q => v[Math.min(v.length - 1, Math.max(0, Math.ceil(v.length * q) - 1))]
  const mean = v.reduce((s, x) => s + x, 0) / v.length
  return { n: v.length, mean, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: v[v.length - 1] }
}

export function stdev(values) {
  if (values.length < 2) return 0
  const m = values.reduce((s, x) => s + x, 0) / values.length
  return Math.sqrt(values.reduce((s, x) => s + (x - m) * (x - m), 0) / (values.length - 1))
}

export function dist3(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) }

export function createTruthTrack() {
  const t = [], x = [], y = [], z = []
  return {
    push(time, p) { t.push(time); x.push(p[0]); y.push(p[1]); z.push(p[2]) },
    get length() { return t.length },
    at(time, out = [0, 0, 0]) {
      const n = t.length
      if (!n) return null
      if (time <= t[0]) { out[0] = x[0]; out[1] = y[0]; out[2] = z[0]; return out }
      if (time >= t[n - 1]) { out[0] = x[n - 1]; out[1] = y[n - 1]; out[2] = z[n - 1]; return out }
      let lo = 0, hi = n - 1
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] <= time) lo = m; else hi = m }
      const f = (time - t[lo]) / (t[hi] - t[lo] || 1)
      out[0] = x[lo] + (x[hi] - x[lo]) * f; out[1] = y[lo] + (y[hi] - y[lo]) * f; out[2] = z[lo] + (z[hi] - z[lo]) * f
      return out
    },
    span() { return t.length ? [t[0], t[t.length - 1]] : [0, 0] }
  }
}

export function effectiveDelay(samples, truth, maxDelayMs = 600, stepMs = 2) {
  const tmp = [0, 0, 0]
  const [t0] = truth.span()
  const usable = samples.filter(s => s.t - maxDelayMs > t0)
  if (!usable.length) return null
  let best = { delayMs: 0, mean: Infinity }
  const errAt = d => {
    let sum = 0
    for (const s of usable) sum += dist3(s.p, truth.at(s.t - d, tmp))
    return sum / usable.length
  }
  for (let d = 0; d <= maxDelayMs; d += stepMs) {
    const e = errAt(d)
    if (e < best.mean) best = { delayMs: d, mean: e }
  }
  const errsBest = usable.map(s => dist3(s.p, truth.at(s.t - best.delayMs, tmp)))
  const errsPresent = usable.map(s => dist3(s.p, truth.at(s.t, tmp)))
  return { delayMs: best.delayMs, errAtDelay: summarize(errsBest), errVsPresent: summarize(errsPresent) }
}

export function detectPops(frames, thresholdM = 0.01) {
  let pops = 0, maxBack = 0
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1], b = frames[i]
    const vx = b.v[0], vz = b.v[2]
    const vh = Math.hypot(vx, vz)
    if (vh < 1) continue
    const back = -((b.p[0] - a.p[0]) * vx + (b.p[2] - a.p[2]) * vz) / vh
    if (back > thresholdM) { pops++; if (back > maxBack) maxBack = back }
  }
  return { pops, maxBackM: maxBack }
}

export function fmt(v, d = 1) { return v == null || !Number.isFinite(v) ? '-' : v.toFixed(d) }
