export class SequenceTracker {
  constructor(windowSize = 256) {
    this.windowSize = windowSize
    this.nextExpected = 0
    this.received = new Set()
    this.outOfOrder = []
    this.totalReceived = 0
    this.totalExpected = 0
    this.gaps = 0
  }

  track(seq) {
    this.totalReceived++
    if (seq === this.nextExpected) {
      this.nextExpected = (this.nextExpected + 1) & 0xFFFF
      this._drainOutOfOrder()
      return { inOrder: true, gap: 0 }
    }
    const gap = (seq - this.nextExpected + 0x10000) & 0xFFFF
    if (gap > this.windowSize) {
      this.nextExpected = (seq + 1) & 0xFFFF
      this.outOfOrder = []
      this.received.clear()
      return { inOrder: true, gap: 0, reset: true }
    }
    this.gaps++
    this.outOfOrder.push(seq)
    this.outOfOrder.sort((a, b) => {
      const da = (a - this.nextExpected + 0x10000) & 0xFFFF
      const db = (b - this.nextExpected + 0x10000) & 0xFFFF
      return da - db
    })
    this.received.add(seq)
    return { inOrder: false, gap }
  }

  _drainOutOfOrder() {
    while (this.outOfOrder.length > 0 && this.outOfOrder[0] === this.nextExpected) {
      this.outOfOrder.shift()
      this.received.delete(this.nextExpected)
      this.nextExpected = (this.nextExpected + 1) & 0xFFFF
    }
  }

  getPacketLoss() {
    if (this.totalReceived === 0) return 0
    const expected = this.nextExpected
    if (expected === 0) return 0
    const lost = expected - this.totalReceived
    return Math.max(0, lost / expected)
  }

  getStats() {
    return {
      nextExpected: this.nextExpected,
      totalReceived: this.totalReceived,
      outOfOrderCount: this.outOfOrder.length,
      gapEvents: this.gaps,
      packetLoss: this.getPacketLoss()
    }
  }

  reset() {
    this.nextExpected = 0
    this.received.clear()
    this.outOfOrder = []
    this.totalReceived = 0
    this.totalExpected = 0
    this.gaps = 0
  }
}
