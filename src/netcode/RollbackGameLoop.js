const DEFAULT_FLUSH_DEBOUNCE_MS = 30
const DEFAULT_STALL_TICKS = 180

export function createRollbackGameLoop({
  tickSystem,
  transport,
  rollback,
  detector,
  playerManager,
  localPeerId,
  getLocalInput = null,
  flushDebounceMs = DEFAULT_FLUSH_DEBOUNCE_MS,
  onStalledPeer = null,
  onMisprediction = null,
} = {}) {
  if (!tickSystem || typeof tickSystem.onTick !== 'function') {
    throw new Error('[RollbackGameLoop] tickSystem is required')
  }
  if (!transport || typeof transport.submitLocalInput !== 'function') {
    throw new Error('[RollbackGameLoop] transport (RollbackInputTransport instance) is required')
  }
  if (!rollback || typeof rollback.resimulateFrom !== 'function' || typeof rollback.save !== 'function') {
    throw new Error('[RollbackGameLoop] rollback (RollbackLoop instance) is required')
  }
  if (!detector || typeof detector.recordPredicted !== 'function' || typeof detector.onRemoteInputArrived !== 'function') {
    throw new Error('[RollbackGameLoop] detector (MispredictionDetector instance) is required')
  }
  if (!playerManager || typeof playerManager.getConnectedPlayers !== 'function') {
    throw new Error('[RollbackGameLoop] playerManager is required')
  }
  if (!localPeerId) throw new Error('[RollbackGameLoop] localPeerId is required')

  let currentTick = 0
  let currentDt = 0
  const stats = { ticksSimulated: 0, predicted: 0, mispredictions: 0, resimulates: 0, finalFlushes: 0, dropped: [] }

  let _flushTimer = null
  let _pendingFromTick = null
  let _pendingToTick = null

  function _scheduleFinalFlush(fromTick, toTick) {
    _pendingFromTick = _pendingFromTick == null ? fromTick : Math.min(_pendingFromTick, fromTick)
    _pendingToTick = _pendingToTick == null ? toTick : Math.max(_pendingToTick, toTick)
    if (_flushTimer) clearTimeout(_flushTimer)
    _flushTimer = setTimeout(() => {
      _flushTimer = null
      const from = _pendingFromTick, to = Math.max(_pendingToTick, currentTick)
      _pendingFromTick = null; _pendingToTick = null
      if (!rollback.has(from)) return
      const result = rollback.resimulateFrom(from, currentDt, () => null, to, { suppressEmissions: false })
      stats.finalFlushes++
      if (onMisprediction) onMisprediction({ finalFlush: true, fromTick: from, toTick: to }, result)
    }, flushDebounceMs)
    if (_flushTimer.unref) _flushTimer.unref()
  }

  function _onRemoteInput(peerId, tick, arrivedInput) {
    const detection = detector.onRemoteInputArrived(peerId, tick, arrivedInput, currentTick)
    if (!detection) return
    stats.mispredictions++
    if (!rollback.has(detection.fromTick)) return
    const result = rollback.resimulateFrom(detection.fromTick, currentDt, detection.correctedInputs, detection.toTick, { suppressEmissions: true })
    stats.resimulates++
    if (onMisprediction) onMisprediction(detection, result)
    _scheduleFinalFlush(detection.fromTick, detection.toTick)
  }
  transport.onRemoteInput = _onRemoteInput

  function _defaultDropStalled(stalled) {
    for (const { pubkey } of stalled) {
      transport.dropPeer(pubkey)
      stats.dropped.push(pubkey)
    }
  }

  function _predictRemoteInputs(tick) {
    const players = playerManager.getConnectedPlayers()
    for (const p of players) {
      if (p.id === localPeerId) continue
      const predicted = p.lastInput ?? null
      detector.recordPredicted(p.id, tick, predicted)
      stats.predicted++
    }
  }

  function _tick(tick, dt) {
    currentTick = tick
    currentDt = dt

    _predictRemoteInputs(tick)

    const localInput = getLocalInput ? getLocalInput(tick) : {}
    transport.submitLocalInput(tick, localInput)

    rollback.save(tick)
    stats.ticksSimulated++

    const stalled = transport.getStalledPeers(tick)
    if (stalled.length) {
      if (onStalledPeer) onStalledPeer(stalled, () => _defaultDropStalled(stalled))
      else _defaultDropStalled(stalled)
    }
  }

  tickSystem.onTick(_tick)

  return {
    start() { tickSystem.start() },
    stop() { tickSystem.stop(); if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null } },
    get currentTick() { return currentTick },
    getStats() { return { ...stats, dropped: [...stats.dropped], pendingFlush: _flushTimer != null } },
  }
}
