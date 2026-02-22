export class LagCompensator {
  constructor(historyWindow = 500) {
    this.historyWindow = historyWindow
    this.playerHistory = new Map()
  }

  recordPlayerPosition(playerId, position, rotation, velocity, tick) {
    if (!this.playerHistory.has(playerId)) {
      this.playerHistory.set(playerId, { buf: new Array(128), head: 0, len: 0 })
    }

    const ring = this.playerHistory.get(playerId)
    const idx = (ring.head + ring.len) % 128
    if (!ring.buf[idx]) ring.buf[idx] = { tick: 0, timestamp: 0, position: [0,0,0], rotation: [0,0,0,1], velocity: [0,0,0] }
    const entry = ring.buf[idx]
    entry.tick = tick; entry.timestamp = Date.now()
    entry.position[0] = position[0]; entry.position[1] = position[1]; entry.position[2] = position[2]
    entry.rotation[0] = rotation[0]; entry.rotation[1] = rotation[1]; entry.rotation[2] = rotation[2]; entry.rotation[3] = rotation[3]
    entry.velocity[0] = velocity[0]; entry.velocity[1] = velocity[1]; entry.velocity[2] = velocity[2]
    if (ring.len < 128) ring.len++
    else ring.head = (ring.head + 1) % 128

    const cutoff = Date.now() - this.historyWindow
    while (ring.len > 0 && ring.buf[ring.head].timestamp < cutoff) {
      ring.head = (ring.head + 1) % 128; ring.len--
    }
  }

  getPlayerStateAtTime(playerId, millisAgo) {
    const ring = this.playerHistory.get(playerId)
    if (!ring || ring.len === 0) return null

    const targetTime = Date.now() - millisAgo
    let best = null

    for (let i = 0; i < ring.len; i++) {
      const entry = ring.buf[(ring.head + i) % 128]
      if (entry.timestamp <= targetTime) best = entry
      else break
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
    const ring = this.playerHistory.get(playerId)
    if (!ring || ring.len < 2) return false

    const lastPos = ring.buf[(ring.head + ring.len - 1) % 128].position
    const dist = Math.sqrt((newPosition[0] - lastPos[0])**2 + (newPosition[1] - lastPos[1])**2 + (newPosition[2] - lastPos[2])**2)

    return dist > threshold
  }

  clearPlayerHistory(playerId) {
    this.playerHistory.delete(playerId)
  }

  getStats() {
    let total = 0
    for (const ring of this.playerHistory.values()) total += ring.len
    return { trackedPlayers: this.playerHistory.size, totalSamples: total }
  }
}