export class LagCompensator {
  constructor(historyWindow = 500) {
    this.historyWindow = historyWindow
    this.playerHistory = new Map()
  }

  recordPlayerPosition(playerId, position, rotation, velocity, tick) {
    if (!this.playerHistory.has(playerId)) {
      this.playerHistory.set(playerId, [])
    }

    const history = this.playerHistory.get(playerId)
    history.push({
      tick,
      timestamp: Date.now(),
      position: [...position],
      rotation: [...rotation],
      velocity: [...velocity]
    })

    const cutoff = Date.now() - this.historyWindow
    while (history.length > 0 && history[0].timestamp < cutoff) {
      history.shift()
    }
  }

  getPlayerStateAtTime(playerId, millisAgo) {
    const history = this.playerHistory.get(playerId)
    if (!history || history.length === 0) return null

    const targetTime = Date.now() - millisAgo
    let best = null

    for (const state of history) {
      if (state.timestamp <= targetTime) {
        best = state
      } else {
        break
      }
    }

    return best
  }

  validateShot(shooterId, targetId, latencyMs) {
    const targetState = this.getPlayerStateAtTime(targetId, latencyMs)
    if (!targetState) return { valid: false, reason: 'no_history' }

    const speed = Math.sqrt(targetState.velocity[0]**2 + targetState.velocity[1]**2 + targetState.velocity[2]**2)

    if (speed > 30) {
      return { valid: true, reason: 'fast_moving_target', state: targetState }
    }

    return { valid: true, reason: 'valid_shot', state: targetState }
  }

  detectTeleport(playerId, newPosition, threshold = 50) {
    const history = this.playerHistory.get(playerId)
    if (!history || history.length < 2) return false

    const lastPos = history[history.length - 1].position
    const dist = Math.sqrt((newPosition[0] - lastPos[0])**2 + (newPosition[1] - lastPos[1])**2 + (newPosition[2] - lastPos[2])**2)

    return dist > threshold
  }

  clearPlayerHistory(playerId) {
    this.playerHistory.delete(playerId)
  }

  getStats() {
    return {
      trackedPlayers: this.playerHistory.size,
      totalSamples: Array.from(this.playerHistory.values()).reduce((sum, h) => sum + h.length, 0)
    }
  }
}