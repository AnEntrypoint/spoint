export class RoomHealthError extends Error {
  constructor(reasonCode, message) {
    super(message)
    this.name = 'RoomHealthError'
    this.reasonCode = reasonCode
  }
}

export function createRoomHealth({ tickBudgetMs, windowTicks = 240, startedAt = Date.now(), now = () => Date.now(), memory = () => process.memoryUsage() } = {}) {
  if (!(Number.isFinite(tickBudgetMs) && tickBudgetMs > 0)) {
    throw new RoomHealthError('budget-not-positive-finite', `tickBudgetMs ${JSON.stringify(tickBudgetMs ?? null)} is not a positive finite number`)
  }
  if (!(Number.isInteger(windowTicks) && windowTicks >= 1)) {
    throw new RoomHealthError('window-not-positive-integer', `windowTicks ${JSON.stringify(windowTicks ?? null)} is not a positive integer`)
  }
  const samples = new Float64Array(windowTicks)
  let filled = 0, next = 0, ticks = 0, overBudgetTicks = 0, lastTick = null

  return {
    recordTick(tick, tickMs) {
      if (!Number.isInteger(tick)) throw new RoomHealthError('tick-not-integer', `tick ${JSON.stringify(tick ?? null)} is not an integer`)
      if (!(Number.isFinite(tickMs) && tickMs >= 0)) throw new RoomHealthError('tick-ms-not-finite', `tickMs ${JSON.stringify(tickMs ?? null)} is not a non-negative finite number`)
      samples[next] = tickMs
      next = (next + 1) % windowTicks
      if (filled < windowTicks) filled++
      ticks++
      if (tickMs > tickBudgetMs) overBudgetTicks++
      lastTick = tick
    },
    snapshot({ bodies = null, bodyLimit = null, joltHeapBytes = null, joltHeapLimitBytes = null, players = null } = {}) {
      const window = Array.from(samples.subarray(0, filled)).sort((a, b) => a - b)
      const pick = q => window.length ? window[Math.min(window.length - 1, Math.floor(q * window.length))] : null
      const mem = memory()
      return {
        at: now(),
        uptimeMs: now() - startedAt,
        tick: lastTick,
        ticks,
        players,
        tickBudgetMs,
        tickMs: { p50: pick(0.5), p95: pick(0.95), max: window.length ? window[window.length - 1] : null, window: filled },
        overBudget: { ticks: overBudgetTicks, ratio: ticks ? overBudgetTicks / ticks : 0 },
        memory: { heapUsed: mem.heapUsed, rss: mem.rss, external: mem.external, arrayBuffers: mem.arrayBuffers },
        jolt: {
          bodies, bodyLimit, bodyHeadroom: bodies == null || bodyLimit == null ? null : bodyLimit - bodies,
          heapBytes: joltHeapBytes, heapLimitBytes: joltHeapLimitBytes,
          heapHeadroomBytes: joltHeapBytes == null || joltHeapLimitBytes == null ? null : joltHeapLimitBytes - joltHeapBytes,
        },
      }
    },
  }
}
