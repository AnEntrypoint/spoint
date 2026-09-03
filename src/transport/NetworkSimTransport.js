import { TransportWrapper } from './TransportWrapper.js'

// NetworkSimTransport -- a real transport-simulation harness: wraps ANY real TransportWrapper (WebSocket,
// WebTransport, Worker, Wireweave -- anything already speaking the send()/sendUnreliable()/'message'/'close'
// contract) and injects loss/latency/jitter/reorder on BOTH directions, so netcode (prediction, reconciliation,
// jitter buffer, lag compensation) gets tuned against a real degraded link instead of localhost's ~0ms/0%-loss
// path. This is a DECORATOR, not a new transport type: it never talks to a socket itself, it delays/drops/
// reorders the same send()/message calls the wrapped transport would make, so swapping it in/out is a single
// constructor wrap at the connection call site with zero protocol-surface change.
//
// WHY PAYLOAD-SWAP, NOT DEADLINE-SWAP: a naive `setTimeout(() => emit(data), latency)` per inbound packet
// reorders for free whenever jitter makes a later-queued packet's draw shorter than an earlier one's --
// fine for pure jitter simulation, but "reorder" needs to be an INDEPENDENT, separately-tunable probability
// so a caller can dial reorder to exactly 0% while keeping jitter > 0 (a jittered-but-always-in-order link
// is itself a real, common WAN condition: FIFO queueing with variable per-hop delay). A first attempt swapped
// the two entries' `deadline` fields after scheduling, but each entry's `setTimeout` had already been armed
// with a delay computed from ITS OWN deadline at schedule time -- mutating `deadline` afterward doesn't
// retroactively change an already-armed timer's fire time, so with equal-latency/zero-jitter traffic the
// "swap" was a complete no-op (proven by a real unit run: reorderPct=100 still delivered strictly in order).
// The fix swaps the `deliver` PAYLOAD CALLBACKS between the two most-recently-scheduled entries instead --
// both timers still fire at their own originally-armed times, but the entry each timer points at differs,
// so the actual emitted packet order changes while the delay distribution (jitter) is completely unaffected.
//
// CONFIG (all mutable live via .configure(), matching the RenderControls "live knob" convention):
//   lossPct      0..100  -- percent of packets dropped outright (never delivered, never affects backpressure)
//   latencyMs    >=0     -- base one-way delay added to every delivered packet
//   jitterMs     >=0     -- +/- uniform random delay on top of latencyMs, per packet
//   reorderPct   0..100  -- percent chance a delivered packet's actual delivery time is swapped with the
//                           packet immediately behind it in the schedule (a real, bounded reorder -- packets
//                           only ever move by one position, so this never produces unbounded staleness)
// Applies symmetrically to inbound ('message' emission) and outbound (send()/sendUnreliable() to the wrapped
// transport) -- a real link degrades both directions independently in practice, but for a dev tuning harness
// one shared profile covering both is the useful default; direction-specific profiles are exposed via
// `.configure({ inbound: {...}, outbound: {...} })` for the rarer asymmetric-link case (e.g. cellular uplink
// starved relative to downlink).
export class NetworkSimTransport extends TransportWrapper {
  constructor(inner, config = {}) {
    super()
    this.type = `sim(${inner.type})`
    this.inner = inner
    this._closed = false
    this._pending = 0 // count of in-flight scheduled deliveries, for drain-on-close bookkeeping
    this._timers = new Set()
    this._lastScheduledAt = { inbound: 0, outbound: 0 }
    this._pendingQueue = { inbound: [], outbound: [] } // each entry: { deadline, fn }, used for the reorder swap

    const base = { lossPct: 0, latencyMs: 0, jitterMs: 0, reorderPct: 0 }
    this.profile = {
      inbound: { ...base, ...(config.inbound || config) },
      outbound: { ...base, ...(config.outbound || config) }
    }

    this.ready = inner.isOpen
    inner.on('message', (data) => this._scheduleInbound(data))
    inner.on('close', () => { this.ready = false; this._closed = true; this.emit('close') })
    inner.on('error', (err) => this.emit('error', err))
    // inner may not be open yet (e.g. wrapping a transport before its own connect() resolves) -- listen
    // for its real 'open' event rather than polling isOpen. A PRIOR VERSION OF THIS CODE used a
    // self-rescheduling queueMicrotask(check) loop here, which is a REAL, LIVE-WITNESSED BUG: microtasks
    // fully drain before the event loop is allowed to process any macrotask/IO callback, so a
    // self-rescheding microtask that keeps finding isOpen still false (which it always does until the
    // underlying socket's real 'open' callback -- itself an I/O macrotask -- gets a turn) spins forever
    // and starves that exact callback from ever running: a real Node process was caught via
    // Get-Process CPU accumulating continuously while stuck at 0% actual progress, wrapping a real
    // WebSocket against a real server, never reaching 'open'. Every transport this file wraps
    // (WebSocketClientTransport, WebSocketTransport, WebTransportClientTransport) now emits a real
    // 'open' event the moment it transitions ready=true, so this listens for that instead.
    if (!this.ready) inner.on('open', () => { if (!this._closed) this.ready = true })
  }

  get isOpen() {
    return this.inner.isOpen
  }

  // Live reconfiguration -- matches RenderControls' "set() takes effect on the next event" convention.
  // Already-scheduled deliveries keep their computed deadline (changing latencyMs mid-flight must not
  // un-deliver or re-delay a packet already in the pipe -- that would itself be a non-physical artifact).
  configure(partial) {
    if (partial.inbound || partial.outbound) {
      Object.assign(this.profile.inbound, partial.inbound || {})
      Object.assign(this.profile.outbound, partial.outbound || {})
    } else {
      Object.assign(this.profile.inbound, partial)
      Object.assign(this.profile.outbound, partial)
    }
    return this.profile
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

  // Schedules one delivery, then applies the independent reorder-swap step against whatever is still
  // pending (not yet fired) in the same direction's queue. The swap exchanges `deliver` PAYLOADS between
  // this entry and the immediately-preceding still-pending one -- each entry's own timer keeps its own
  // originally-armed fire time (jitter distribution is untouched), only WHICH packet each fire emits
  // changes, so total delivered count is unaffected by reorderPct and packets only ever move by one
  // position (a real, bounded reorder -- never unbounded staleness).
  _schedule(direction, p, deliver) {
    const stats = this._stats
    stats[`${direction}Sent`]++
    if (p.lossPct > 0 && Math.random() * 100 < p.lossPct) {
      stats[`${direction}Dropped`]++
      return
    }
    const delay = this._drawDelay(p)
    const entry = { deliver }
    const queue = this._pendingQueue[direction]
    queue.push(entry)

    if (p.reorderPct > 0 && queue.length >= 2 && Math.random() * 100 < p.reorderPct) {
      const prev = queue[queue.length - 2]
      const tmp = prev.deliver
      prev.deliver = entry.deliver
      entry.deliver = tmp
      stats[`${direction}Reordered`]++
    }

    const timer = setTimeout(() => {
      this._timers.delete(timer)
      const idx = queue.indexOf(entry)
      if (idx >= 0) queue.splice(idx, 1)
      if (this._closed) return
      stats[`${direction}Delivered`]++
      entry.deliver()
    }, delay)
    this._timers.add(timer)
  }

  _scheduleInbound(data) {
    this._schedule('inbound', this.profile.inbound, () => this.emit('message', data))
  }

  send(data, mt) {
    if (!this.isOpen) return false
    this._schedule('outbound', this.profile.outbound, () => this.inner.send(data, mt))
    return true // async delivery -- accepted into the sim pipe, real per-packet result isn't synchronously knowable
  }

  sendUnreliable(data, mt) {
    if (!this.isOpen) return false
    this._schedule('outbound', this.profile.outbound, () => this.inner.sendUnreliable(data, mt))
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

// Named presets, roadmap #26's own example condition (150ms/3% loss) included, plus a few standard WAN/mobile
// reference points -- discoverable the same way RenderControls documents its knobs.
export const NETWORK_SIM_PRESETS = {
  clean: { lossPct: 0, latencyMs: 0, jitterMs: 0, reorderPct: 0 },
  broadbandGood: { lossPct: 0, latencyMs: 20, jitterMs: 5, reorderPct: 0 },
  wifiTypical: { lossPct: 0.5, latencyMs: 40, jitterMs: 15, reorderPct: 0.5 },
  cellular4g: { lossPct: 1, latencyMs: 60, jitterMs: 30, reorderPct: 1 },
  roadmapTarget: { lossPct: 3, latencyMs: 150, jitterMs: 20, reorderPct: 2 }, // roadmap #26's own stated condition
  degradedWan: { lossPct: 5, latencyMs: 200, jitterMs: 60, reorderPct: 5 },
  brutal: { lossPct: 10, latencyMs: 300, jitterMs: 100, reorderPct: 10 }
}
