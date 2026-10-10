import { TransportWrapper } from './TransportWrapper.js'

const SIM_MAX_DELAY_MS = 2147483647

const SIM_PROFILE_RANGES = Object.assign(Object.create(null), {
  lossPct: [0, 100],
  latencyMs: [0, SIM_MAX_DELAY_MS],
  jitterMs: [0, SIM_MAX_DELAY_MS],
  reorderPct: [0, 100]
})

const SIM_PROFILE_KEYS = Object.keys(SIM_PROFILE_RANGES)

const SIM_PROFILE_BASE = Object.freeze(SIM_PROFILE_KEYS.reduce((base, key) => {
  base[key] = SIM_PROFILE_RANGES[key][0]
  return base
}, {}))

function describe(value) {
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

function assertSimProfile(profile, label) {
  for (const key of Object.keys(profile)) {
    const range = SIM_PROFILE_RANGES[key]
    if (!range) {
      throw new TypeError(`[network-sim] ${label}: unknown profile field "${key}", expected one of ${SIM_PROFILE_KEYS.join(', ')}`)
    }
    const value = profile[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < range[0] || value > range[1]) {
      throw new TypeError(`[network-sim] ${label}: ${key} must be a finite number in [${range[0]}, ${range[1]}], got ${describe(value)}`)
    }
  }
  const delay = (profile.latencyMs || 0) + (profile.jitterMs || 0)
  if (delay > SIM_MAX_DELAY_MS) {
    throw new TypeError(`[network-sim] ${label}: latencyMs + jitterMs must be <= ${SIM_MAX_DELAY_MS}, got ${delay}`)
  }
  return profile
}

function pickSides(spec, label) {
  if (spec === null || typeof spec !== 'object') {
    throw new TypeError(`[network-sim] ${label}: profile must be an object, got ${describe(spec)}`)
  }
  const directional = spec.inbound !== undefined || spec.outbound !== undefined
  if (!directional) return { inbound: spec, outbound: spec }
  for (const key of Object.keys(spec)) {
    if (key !== 'inbound' && key !== 'outbound') {
      throw new TypeError(`[network-sim] ${label}: unknown profile field "${key}", expected inbound/outbound or one of ${SIM_PROFILE_KEYS.join(', ')}`)
    }
  }
  for (const side of ['inbound', 'outbound']) {
    const value = spec[side]
    if (value !== undefined && (value === null || typeof value !== 'object')) {
      throw new TypeError(`[network-sim] ${label}: ${side} must be an object, got ${describe(value)}`)
    }
  }
  return { inbound: spec.inbound, outbound: spec.outbound }
}

export class NetworkSimTransport extends TransportWrapper {
  constructor(inner, config = {}) {
    super()
    this.type = `sim(${inner.type})`
    this.inner = inner
    this._closed = false
    this._timers = new Set()
    this._pendingQueue = { inbound: [], outbound: [] }

    const sides = pickSides(config, 'constructor')
    this.profile = {
      inbound: assertSimProfile({ ...SIM_PROFILE_BASE, ...sides.inbound }, 'constructor.inbound'),
      outbound: assertSimProfile({ ...SIM_PROFILE_BASE, ...sides.outbound }, 'constructor.outbound')
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
    const sides = pickSides(partial, 'configure')
    const next = {}
    for (const side of ['inbound', 'outbound']) {
      if (sides[side] === undefined) continue
      next[side] = assertSimProfile({ ...this.profile[side], ...sides[side] }, `configure.${side}`)
    }
    for (const side of Object.keys(next)) this.profile[side] = next[side]
  }

  getProfile() {
    return { inbound: { ...this.profile.inbound }, outbound: { ...this.profile.outbound } }
  }

  getStats() {
    return { ...this._stats }
  }

  _stats = { inboundSent: 0, inboundDropped: 0, inboundDelivered: 0, inboundReordered: 0,
             outboundSent: 0, outboundDropped: 0, outboundDelivered: 0, outboundReordered: 0 }

  _sendIndex = { inbound: 0, outbound: 0 }

  _lastDeliveredIndex = { inbound: 0, outbound: 0 }

  _drawDelay(p) {
    const jitter = p.jitterMs > 0 ? (Math.random() * 2 - 1) * p.jitterMs : 0
    return Math.max(0, p.latencyMs + jitter)
  }

  _schedule(direction, p, deliver, undelivered) {
    const stats = this._stats
    stats[`${direction}Sent`]++
    const sendIndex = ++this._sendIndex[direction]
    if (p.lossPct > 0 && Math.random() * 100 < p.lossPct) {
      stats[`${direction}Dropped`]++
      return
    }
    const delay = this._drawDelay(p)
    const entry = { sendIndex, deliver, undelivered }
    const queue = this._pendingQueue[direction]
    queue.push(entry)

    if (p.reorderPct > 0 && queue.length >= 2 && Math.random() * 100 < p.reorderPct) {
      const prev = queue[queue.length - 2]
      const swapped = { sendIndex: prev.sendIndex, deliver: prev.deliver, undelivered: prev.undelivered }
      prev.sendIndex = entry.sendIndex
      prev.deliver = entry.deliver
      prev.undelivered = entry.undelivered
      entry.sendIndex = swapped.sendIndex
      entry.deliver = swapped.deliver
      entry.undelivered = swapped.undelivered
    }

    const timer = setTimeout(() => {
      this._timers.delete(timer)
      const idx = queue.indexOf(entry)
      if (idx >= 0) queue.splice(idx, 1)
      if (this._closed) return
      const deliveredIndex = entry.sendIndex
      if (deliveredIndex < this._lastDeliveredIndex[direction]) stats[`${direction}Reordered`]++
      if (deliveredIndex > this._lastDeliveredIndex[direction]) this._lastDeliveredIndex[direction] = deliveredIndex
      const accepted = entry.deliver(deliveredIndex)
      if (accepted === false && entry.undelivered !== undefined) {
        this.emit('undelivered', entry.undelivered)
        return
      }
      stats[`${direction}Delivered`]++
    }, delay)
    this._timers.add(timer)
  }

  _scheduleInbound(data) {
    this._schedule('inbound', this.profile.inbound, (sendIndex) => this.emit('message', data, { sendIndex }))
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

for (const [name, preset] of Object.entries(NETWORK_SIM_PRESETS)) {
  assertSimProfile({ ...SIM_PROFILE_BASE, ...preset }, `NETWORK_SIM_PRESETS.${name}`)
}
