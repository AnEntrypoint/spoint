const SPIN_ITERATIONS = 4_000_000
const SPIN_SAMPLES = 3
const CONTESTED_SLOWDOWN = 1.35

const round = (v, n = 2) => Math.round(v * 10 ** n) / 10 ** n

let bestSpinMs = Infinity

function spin() {
  let s = 0
  for (let i = 1; i <= SPIN_ITERATIONS; i++) s += Math.sqrt(i)
  return s
}

export function spinMs(samples = SPIN_SAMPLES) {
  spin()
  const taken = []
  for (let k = 0; k < samples; k++) {
    const t0 = performance.now()
    spin()
    taken.push(performance.now() - t0)
  }
  taken.sort((a, b) => a - b)
  const median = round(taken[Math.floor(taken.length / 2)], 2)
  if (median < bestSpinMs) bestSpinMs = median
  return median
}

export function contentionWatch() {
  return { beforeMs: spinMs(), midMs: null }
}

export function contentionMark(watch) {
  const ms = spinMs()
  if (watch.midMs === null || ms > watch.midMs) watch.midMs = ms
  return ms
}

export function contentionVerdict(watch, threshold = CONTESTED_SLOWDOWN) {
  const afterMs = spinMs()
  const peakMs = Math.max(watch.beforeMs, afterMs, watch.midMs === null ? 0 : watch.midMs)
  const slowdown = round(peakMs / bestSpinMs, 2)
  return {
    beforeMs: watch.beforeMs,
    midMs: watch.midMs,
    afterMs: round(afterMs, 2),
    peakMs: round(peakMs, 2),
    bestMs: bestSpinMs,
    slowdown,
    contested: slowdown >= threshold,
  }
}

export function formatContention(c) {
  const mid = c.midMs === null || c.midMs === undefined ? '' : `, mid ${c.midMs}`
  const verdict = c.contested
    ? `CONTESTED (x${c.slowdown} of this run's cleanest ${c.bestMs} ms): this arm shared the box, so its wall-clock figures are inflated -- re-run alone before quoting them`
    : `clean (x${c.slowdown} of this run's cleanest ${c.bestMs} ms)`
  return `host contention ${c.beforeMs} ->${mid} ${c.afterMs} ms per fixed spin, ${verdict}`
}
