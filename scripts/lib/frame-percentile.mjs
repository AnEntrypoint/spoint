export function percentile(sorted, p) {
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

export function summarizeFrames(deltas) {
  const sorted = deltas.slice().sort((a, b) => a - b)
  const p50 = percentile(sorted, 0.5)
  return {
    count: sorted.length,
    minMs: +sorted[0].toFixed(2),
    p50Ms: +p50.toFixed(2),
    p95Ms: +percentile(sorted, 0.95).toFixed(2),
    p99Ms: +percentile(sorted, 0.99).toFixed(2),
    maxMs: +percentile(sorted, 1).toFixed(2),
    fps: +(1000 / Math.max(0.001, p50)).toFixed(1),
  }
}
