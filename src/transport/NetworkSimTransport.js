import { TransportWrapper } from './TransportWrapper.js'

export class NetworkSimTransport extends TransportWrapper {
  constructor(inner, config = {}) {
    super()
    this.type = `sim(${inner.type})`
    this.inner = inner
    this._closed = false
    this._pending = 0
    this._timers = new Set()
    this._lastScheduledAt = { inbound: 0, outbound: 0 }
    this._pendingQueue = { inbound: [], outbound: [] }

    const base = { lossPct: 0, latencyMs: 0, jitterMs: 0, reorderPct: 0 }
    this.profile = {
      inbound: { ...base, ...(config.inbound || config) },
      outbound: { ...base, ...(config.outbound || config) }
    }

    this.ready = inner.isOpen
    inner.on('message', (data) => this._scheduleInbound(data))
    inner.on('close', () => { this.ready = false; this._closed = true; this.emit('close') })
    inner.on('error', (err) => this.emit('error', err))
    if (!this.ready) inner.on('open', () => {
      if (this._closed) return
      const wasOpen = this.isOpen
      this.ready = true
      if (!wasOpen && this.isOpen) this.emit('open')
    })
  }

  get ready() {
    return !this._closed && this._wrapperOpen && this.inner.isOpen
  }

  set ready(value) {
    this._wrapperOpen = Boolean(value)
  }

  configure(partial) {
    if (partial.inbound || partial.outbound) {
      Object.assign(this.profile.inbound, partial.inbound || {})
      Object.assign(this.profile.outbound, partial.outbound || {})
    } else {
      Object.assign(this.profile.inbound, partial)
      Object.assign(this.profile.outbound, partial)
    }
  }

  getProfile() {
    return { inbound: { ...this.profile.inbound }, outbound: { ...this.profile.outbound } }
  }

  getStats() {
    return { ...this._stats }
  }

  _stats = { inboundSent: 0, inboundDropped: 0, inboundDelivered: 0, inboundReordered: 0,
             outboundSent: 0, outboundDropped: 0, outboundDelivered: 0, outboundReordered: 0 }

  _drawDelay(p) {
    const jitter = p.jitterMs > 0 ? (Math.random() * 2 - 1) * p.jitterMs : 0
    return Math.max(0, p.latencyMs + jitter)
  }

  _schedule(direction, p, deliver, undelivered) {
    const stats = this._stats
    stats[`${direction}Sent`]++
    if (p.lossPct > 0 && Math.random() * 100 < p.lossPct) {
      stats[`${direction}Dropped`]++
      return
    }
    const delay = this._drawDelay(p)
    const entry = { deliver, undelivered }
    const queue = this._pendingQueue[direction]
    queue.push(entry)

    if (p.reorderPct > 0 && queue.length >= 2 && Math.random() * 100 < p.reorderPct) {
      const prev = queue[queue.length - 2]
      const swapped = { deliver: prev.deliver, undelivered: prev.undelivered }
      prev.deliver = entry.deliver
      prev.undelivered = entry.undelivered
      entry.deliver = swapped.deliver
      entry.undelivered = swapped.undelivered
      stats[`${direction}Reordered`]++
    }

    const timer = setTimeout(() => {
      this._timers.delete(timer)
      const idx = queue.indexOf(entry)
      if (idx >= 0) queue.splice(idx, 1)
      if (this._closed) return
      const accepted = entry.deliver()
      if (accepted === false && entry.undelivered !== undefined) {
        this.emit('undelivered', entry.undelivered)
        return
      }
      stats[`${direction}Delivered`]++
    }, delay)
    this._timers.add(timer)
  }

  _scheduleInbound(data) {
    this._schedule('inbound', this.profile.inbound, () => this.emit('message', data))
  }

  send(data, mt) {
    if (!this.isOpen) return false
    this._schedule('outbound', this.profile.outbound, () => this.inner.send(data, mt), { data, mt, unreliable: false })
    return true
  }

  sendUnreliable(data, mt) {
    if (!this.isOpen) return false
    this._schedule('outbound', this.profile.outbound, () => this.inner.sendUnreliable(data, mt), { data, mt, unreliable: true })
    return true
  }

  close() {
    super.close()
    this._closed = true
    for (const t of this._timers) clearTimeout(t)
    this._timers.clear()
    this._pendingQueue.inbound.length = 0
    this._pendingQueue.outbound.length = 0
    this.inner.close()
  }
}

export const NETWORK_SIM_PRESETS = {
  clean: { lossPct: 0, latencyMs: 0, jitterMs: 0, reorderPct: 0 },
  broadbandGood: { lossPct: 0, latencyMs: 20, jitterMs: 5, reorderPct: 0 },
  wifiTypical: { lossPct: 0.5, latencyMs: 40, jitterMs: 15, reorderPct: 0.5 },
  cellular4g: { lossPct: 1, latencyMs: 60, jitterMs: 30, reorderPct: 1 },
  roadmapTarget: { lossPct: 3, latencyMs: 150, jitterMs: 20, reorderPct: 2 },
  degradedWan: { lossPct: 5, latencyMs: 200, jitterMs: 60, reorderPct: 5 },
  brutal: { lossPct: 10, latencyMs: 300, jitterMs: 100, reorderPct: 10 }
}
