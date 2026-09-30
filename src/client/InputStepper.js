const MAX_CATCH_UP_MS = 250

export function createInputStepper({ getPeriodMs, onStep }) {
  let nextDue = 0, timer = null, running = false
  function loop() {
    if (timer) { clearTimeout(timer); timer = null }
    if (!running) return
    const period = getPeriodMs()
    const maxSteps = Math.max(1, Math.ceil(MAX_CATCH_UP_MS / period))
    let now = performance.now()
    if (!nextDue) nextDue = now
    if (now - nextDue > MAX_CATCH_UP_MS) nextDue = now - MAX_CATCH_UP_MS
    let steps = 0
    while (running && now >= nextDue && steps < maxSteps) {
      try { onStep(nextDue, period) } catch (e) { queueMicrotask(() => { throw e }) }
      nextDue += period
      steps++
      now = performance.now()
    }
    if (running) timer = setTimeout(loop, Math.max(0, nextDue - performance.now()))
  }
  return {
    start() { if (running) return; running = true; nextDue = 0; loop() },
    stop() { running = false; if (timer) { clearTimeout(timer); timer = null } },
    pump() { if (running && nextDue && performance.now() >= nextDue) loop() },
    get running() { return running }
  }
}
