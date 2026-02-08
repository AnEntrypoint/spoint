export class StateInspector {
  constructor() {
    this.snapshots = []
    this.delays = []
    this.corrections = []
    this.maxSnapshots = 100
  }

  recordSnapshot(snap) {
    this.snapshots.push({ ...snap, timestamp: Date.now() })
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.shift()
    }
  }

  recordSnapshotDelay(delay) {
    this.delays.push(delay)
    if (this.delays.length > this.maxSnapshots) {
      this.delays.shift()
    }
  }

  recordCorrection(playerId, oldState, newState, deviationMs) {
    this.corrections.push({ playerId, newState, deviationMs, timestamp: Date.now() })
    if (this.corrections.length > this.maxSnapshots) {
      this.corrections.shift()
    }
  }

  getStats() {
    const avgDelay = this.delays.length > 0
      ? this.delays.reduce((a, b) => a + b, 0) / this.delays.length
      : 0
    return {
      snapshots: this.snapshots.length,
      delays: this.delays.length,
      avgDelay,
      corrections: this.corrections.length,
      lastSnapshot: this.snapshots[this.snapshots.length - 1] || null
    }
  }
}
