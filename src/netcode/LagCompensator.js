// must be monotonic (Date.now() can jump backward and corrupt the ring's time-order binary search)
const _now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
  ? () => performance.now()
  : () => Date.now()

// process is undefined in the browser singleplayer worker; a bare process.env read here crashes worker init
const _envWindow = () => {
  try { if (typeof process !== 'undefined' && process.env) return Number(process.env.SPOINT_LAG_HISTORY_WINDOW) || 0 } catch {}
  return 0
}

export class LagCompensator {
  constructor(historyWindow = _envWindow() || 1000) {
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
    entry.tick = tick; entry.timestamp = _now()
    entry.position[0] = position[0]; entry.position[1] = position[1]; entry.position[2] = position[2]
    entry.rotation[0] = rotation[0]; entry.rotation[1] = rotation[1]; entry.rotation[2] = rotation[2]; entry.rotation[3] = rotation[3]
    entry.velocity[0] = velocity[0]; entry.velocity[1] = velocity[1]; entry.velocity[2] = velocity[2]
    if (ring.len < 128) ring.len++
    else ring.head = (ring.head + 1) % 128

    const cutoff = _now() - this.historyWindow
    while (ring.len > 0 && ring.buf[ring.head].timestamp < cutoff) {
      ring.head = (ring.head + 1) % 128; ring.len--
    }
  }

  getPlayerStateAtTime(playerId, millisAgo) {
    const ring = this.playerHistory.get(playerId)
    if (!ring || ring.len === 0) return null

    const targetTime = _now() - millisAgo
    let lo = 0, hi = ring.len - 1, bestIdx = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (ring.buf[(ring.head + mid) % 128].timestamp <= targetTime) { bestIdx = mid; lo = mid + 1 }
      else hi = mid - 1
    }

    return bestIdx >= 0 ? ring.buf[(ring.head + bestIdx) % 128] : null
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