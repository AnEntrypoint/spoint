export function counterSpan(before, after) {
  const out = {}
  for (const key of Object.keys(after)) out[key] = after[key] - before[key]
  return out
}

export function cpuPerThousand(cpuMs, units) {
  return Number.isFinite(units) && units > 0 ? (cpuMs / units) * 1000 : null
}

export function movedUp(small, large, key) {
  return large[key] > small[key] && small[key] > 0
}
