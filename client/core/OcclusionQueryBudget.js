export function createOcclusionQueryBudget(opts = {}) {
  const fastFrameSkipMs = opts.fastFrameSkipMs ?? 6
  const slowFrameMs = opts.slowFrameMs ?? 20
  const maxTotalBudget = opts.maxTotalBudget ?? 96
  const minTotalBudget = opts.minTotalBudget ?? 24
  const perConsumerFloor = opts.perConsumerFloor ?? 4

  const _consumers = new Map()
  let _lastFrameMs = 0
  let _lastTotalBudget = 0

  function _ensure(name) {
    let c = _consumers.get(name)
    if (!c) { c = { candidates: 0, lastAllocated: 0 }; _consumers.set(name, c) }
    return c
  }

  function reportCandidates(name, count) {
    _ensure(name).candidates = Number.isFinite(count) && count > 0 ? count : 0
  }

  function reportFrameTime(ms) {
    if (Number.isFinite(ms) && ms >= 0) _lastFrameMs = ms
  }

  function _computeTotalBudget() {
    if (_lastFrameMs < fastFrameSkipMs) return 0
    if (_lastFrameMs >= slowFrameMs) return maxTotalBudget
    const span = slowFrameMs - fastFrameSkipMs
    const t = span > 0 ? (_lastFrameMs - fastFrameSkipMs) / span : 1
    return Math.round(minTotalBudget + (maxTotalBudget - minTotalBudget) * t)
  }

  function apply(name, setBudgetFn) {
    const self = _ensure(name)
    const totalBudget = _computeTotalBudget()
    _lastTotalBudget = totalBudget
    let allocated
    if (totalBudget <= 0) {
      allocated = 0
    } else {
      let totalCandidates = 0
      for (const c of _consumers.values()) totalCandidates += c.candidates
      const floorSum = _consumers.size * perConsumerFloor
      const remaining = Math.max(0, totalBudget - floorSum)
      if (totalCandidates <= 0) {
        allocated = Math.min(perConsumerFloor, totalBudget)
      } else {
        const share = self.candidates / totalCandidates
        allocated = perConsumerFloor + Math.round(remaining * share)
      }
      allocated = Math.min(allocated, totalBudget)
    }
    self.lastAllocated = allocated
    if (typeof setBudgetFn === 'function') setBudgetFn(allocated)
    return allocated
  }

  function getStats() {
    const per = {}
    let sumAllocated = 0, sumCandidates = 0
    for (const [name, c] of _consumers) {
      per[name] = { candidates: c.candidates, allocated: c.lastAllocated }
      sumAllocated += c.lastAllocated
      sumCandidates += c.candidates
    }
    return {
      frameMs: _lastFrameMs,
      totalBudget: _lastTotalBudget,
      maxTotalBudget, minTotalBudget, fastFrameSkipMs, slowFrameMs,
      perConsumerFloor, consumers: per, sumAllocated, sumCandidates,
      skipped: _lastTotalBudget <= 0,
    }
  }

  function unregister(name) { _consumers.delete(name) }

  return { reportCandidates, reportFrameTime, apply, getStats, unregister }
}
