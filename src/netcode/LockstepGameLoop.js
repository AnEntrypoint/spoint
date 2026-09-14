export const DEFAULT_PRUNE_WINDOW_TICKS = 240

export function createLockstepGameLoop({
  tickSystem,
  transport,
  physics,
  tickRate = 60,
  pruneWindowTicks = DEFAULT_PRUNE_WINDOW_TICKS,
  onStalledPeer = null,
  onTickSimulated = null,
  desyncDetector = null,
  localPeerId = null,
  checksumFn = null,
} = {}) {
  if (!tickSystem || typeof tickSystem.onTick !== 'function') {
    throw new Error('[LockstepGameLoop] tickSystem (LockstepTickSystem instance) is required')
  }
  if (!transport || typeof transport.submitLocalInput !== 'function' || typeof transport.waitForTick !== 'function') {
    throw new Error('[LockstepGameLoop] transport (LockstepInputTransport instance) is required')
  }
  if (!physics || typeof physics.step !== 'function') {
    throw new Error('[LockstepGameLoop] physics (PhysicsWorld instance) is required')
  }
  if (desyncDetector && (!localPeerId || typeof checksumFn !== 'function')) {
    throw new Error('[LockstepGameLoop] desyncDetector requires both localPeerId and checksumFn')
  }

  let simulatedTick = 0
  let paused = false
  const _queue = []
  let _draining = false

  const stats = { submitted: 0, stalledWaits: 0, dropped: [], ticksSimulated: 0 }

  let _seeded = false
  function _seedInitialDelayWindow() {
    if (_seeded) return
    _seeded = true
    for (let t = 1; t <= transport.inputDelayTicks; t++) {
      const seedInput = typeof transport.getLocalInput === 'function' ? transport.getLocalInput(t) : {}
      transport.submitLocalInput(t, seedInput)
    }
  }

  function _defaultDropStalled(stalled) {
    for (const { pubkey } of stalled) {
      transport.dropPeer(pubkey)
      stats.dropped.push(pubkey)
    }
  }

  async function _drain() {
    if (_draining) return
    _draining = true
    try {
      while (_queue.length) {
        const { tick, dt } = _queue.shift()
        if (paused) { _queue.unshift({ tick, dt }); break }
        await _processTick(tick, dt)
      }
    } finally {
      _draining = false
    }
  }

  async function _processTick(tick, dt) {
    const targetTick = transport.targetTickFor(tick)
    const localInput = typeof transport.getLocalInput === 'function' ? transport.getLocalInput(tick) : {}
    transport.submitLocalInput(targetTick, localInput)
    stats.submitted++

    if (!transport.isTickReady(tick)) {
      stats.stalledWaits++
      const pollMs = Math.max(1, Math.round((transport.stallTicks / tickRate) * 1000) / 4) || 50
      const pollHandle = setInterval(() => {
        if (transport.isTickReady(tick)) return
        const stalled = transport.getStalledPeers(tick)
        if (stalled.length) {
          if (onStalledPeer) onStalledPeer(stalled, () => _defaultDropStalled(stalled))
          else _defaultDropStalled(stalled)
        }
      }, pollMs)
      if (pollHandle.unref) pollHandle.unref()
      try {
        await transport.waitForTick(tick)
      } finally {
        clearInterval(pollHandle)
      }
    }
    const inputs = await transport.waitForTick(tick)

    physics.step(dt)
    simulatedTick = tick

    if (onTickSimulated) onTickSimulated(tick, dt, inputs)

    if (desyncDetector && desyncDetector.isChecksumTick(tick)) {
      const checksum = checksumFn(tick, physics.snapshotBodies())
      desyncDetector.reportChecksum(tick, localPeerId, checksum)
    }

    if (typeof transport.pruneBefore === 'function' && tick > pruneWindowTicks) {
      transport.pruneBefore(tick - pruneWindowTicks)
    }

    stats.ticksSimulated++
  }

  function _onDriverTick(tick, dt) {
    _queue.push({ tick, dt })
    _drain()
  }

  tickSystem.onTick(_onDriverTick)

  return {
    start() { paused = false; _seedInitialDelayWindow(); tickSystem.start() },
    stop() { tickSystem.stop() },
    pause() { paused = true },
    resume() { paused = false; _drain() },
    get paused() { return paused },
    get simulatedTick() { return simulatedTick },
    get driverTick() { return tickSystem.getTick() },
    get stalledBehind() { return tickSystem.getTick() - simulatedTick },
    getStats() { return { ...stats, dropped: [...stats.dropped], queueDepth: _queue.length } },
  }
}
