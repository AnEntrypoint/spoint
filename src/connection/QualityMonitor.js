export class QualityMonitor {
  constructor() {
    this.bytesIn = 0
    this.bytesOut = 0
    this.heartbeatsSent = 0
    this.heartbeatsReceived = 0
    this.rttSamples = []
    this.startTime = Date.now()
  }

  recordBytesIn(count) {
    this.bytesIn += count
  }

  recordBytesOut(count) {
    this.bytesOut += count
  }

  recordHeartbeatSent() {
    this.heartbeatsSent++
  }

  recordHeartbeatReceived() {
    this.heartbeatsReceived++
  }

  recordRtt(rtt) {
    this.rttSamples.push(rtt)
    if (this.rttSamples.length > 100) this.rttSamples.shift()
  }

  getStats() {
    const elapsed = Date.now() - this.startTime
    const avgRtt = this.rttSamples.length > 0
      ? this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length
      : 0
    return {
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      heartbeatsSent: this.heartbeatsSent,
      heartbeatsReceived: this.heartbeatsReceived,
      avgRtt,
      uptime: elapsed
    }
  }
}
