import { TransportWrapper } from '../../src/transport/TransportWrapper.js'
import { unpack } from '../../src/protocol/msgpack.js'
import { isUnreliable } from '../../src/protocol/MessageTypes.js'

const COALESCE_SENTINEL = 0xff
const LEN_PREFIX_BYTES = 4
const MIN_RETRANSMIT_PENALTY_MS = 20
const SPIN_THRESHOLD_MS = 3

export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function createPreciseScheduler() {
  const heap = []
  let seq = 0, armed = false, stopped = false
  const less = (a, b) => a.at < b.at || (a.at === b.at && a.seq < b.seq)
  function push(item) {
    heap.push(item)
    let i = heap.length - 1
    while (i > 0) { const p = (i - 1) >> 1; if (!less(heap[i], heap[p])) break; [heap[i], heap[p]] = [heap[p], heap[i]]; i = p }
  }
  function pop() {
    const top = heap[0], last = heap.pop()
    if (heap.length) {
      heap[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1, r = l + 1
        let m = i
        if (l < heap.length && less(heap[l], heap[m])) m = l
        if (r < heap.length && less(heap[r], heap[m])) m = r
        if (m === i) break
        ;[heap[i], heap[m]] = [heap[m], heap[i]]; i = m
      }
    }
    return top
  }
  function run() {
    armed = false
    if (stopped) return
    const now = performance.now()
    while (heap.length && heap[0].at <= now) pop().fn()
    arm()
  }
  function arm() {
    if (armed || stopped || !heap.length) return
    armed = true
    const wait = heap[0].at - performance.now()
    if (wait > SPIN_THRESHOLD_MS) setTimeout(run, wait - SPIN_THRESHOLD_MS)
    else setImmediate(run)
  }
  return {
    at(atMs, fn) { push({ at: atMs, seq: seq++, fn }); arm() },
    every(periodMs, fn) {
      let next = performance.now() + periodMs
      let live = true
      const tick = () => { if (!live) return; fn(performance.now()); next += periodMs; const now = performance.now(); if (next < now) next = now; this.at(next, tick) }
      this.at(next, tick)
      return () => { live = false }
    },
    stop() { stopped = true; heap.length = 0 }
  }
}

function splitParts(bytes) {
  if (bytes.length === 0 || bytes[0] !== COALESCE_SENTINEL) return [bytes]
  const out = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let off = 1
  while (off + LEN_PREFIX_BYTES <= bytes.length) {
    const len = view.getUint32(off, true); off += LEN_PREFIX_BYTES
    if (off + len > bytes.length) break
    out.push(bytes.subarray(off, off + len)); off += len
  }
  return out
}

function partIsUnreliable(part) {
  try { return isUnreliable(unpack(part).type) } catch { return false }
}

function createLane(profile, rng, scheduler) {
  let orderedAt = 0
  const halfNormal = () => { let u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng(); return Math.abs(Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)) }
  const drawDelay = () => profile.latencyMs + (profile.jitterMs > 0 ? profile.jitterMs * halfNormal() : 0)
  const lost = () => profile.lossPct > 0 && rng() * 100 < profile.lossPct
  const retransmitPenalty = () => Math.max(MIN_RETRANSMIT_PENALTY_MS, 2 * profile.latencyMs + profile.jitterMs)
  return {
    stats: { sent: 0, dropped: 0, retransmitted: 0, delivered: 0 },
    ordered(deliver) {
      this.stats.sent++
      let at = performance.now() + drawDelay()
      if (lost()) { at += retransmitPenalty(); this.stats.retransmitted++ }
      at = Math.max(at, orderedAt)
      orderedAt = at
      scheduler.at(at, () => { this.stats.delivered++; deliver() })
    },
    datagram(deliver) {
      this.stats.sent++
      if (lost()) { this.stats.dropped++; return }
      scheduler.at(performance.now() + drawDelay(), () => { this.stats.delivered++; deliver() })
    }
  }
}

export class ConditionedTransport extends TransportWrapper {
  constructor(inner, profile, scheduler, meter, seed = 1) {
    super()
    this.type = `conditioned(${inner.type})`
    this.inner = inner
    this.profile = { latencyMs: 0, jitterMs: 0, lossPct: 0, channel: 'ws', ...profile }
    this.meter = meter
    this._closed = false
    this._in = createLane(this.profile, mulberry32(seed * 2 + 1), scheduler)
    this._out = createLane(this.profile, mulberry32(seed * 2 + 2), scheduler)
    this.ready = inner.isOpen
    inner.on('message', data => this._inbound(data))
    inner.on('close', () => { this.ready = false; this._closed = true; this.emit('close') })
    inner.on('error', err => this.emit('error', err))
    if (!this.ready) inner.on('open', () => { if (!this._closed) this.ready = true })
  }

  get isOpen() { return this.inner.isOpen }

  _deliverIn(bytes) {
    if (this._closed) return
    this.meter.inBytes += bytes.length
    this.meter.inMsgs++
    this.emit('message', bytes)
  }

  _inbound(data) {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data
    if (this.profile.channel === 'ws') { this._in.ordered(() => this._deliverIn(bytes)); return }
    for (const part of splitParts(bytes)) {
      if (partIsUnreliable(part)) this._in.datagram(() => this._deliverIn(part))
      else this._in.ordered(() => this._deliverIn(part))
    }
  }

  _outbound(data, unreliable) {
    if (!this.isOpen) return false
    this.meter.outBytes += data.length
    this.meter.outMsgs++
    const deliver = () => { if (!this._closed) this.inner.send(data) }
    if (this.profile.channel === 'udp' && unreliable) this._out.datagram(deliver)
    else this._out.ordered(deliver)
    return true
  }

  send(data) { return this._outbound(data, false) }
  sendUnreliable(data) { return this._outbound(data, true) }

  getStats() { return { inbound: { ...this._in.stats }, outbound: { ...this._out.stats } } }

  close() {
    super.close()
    this._closed = true
    this.inner.close()
  }
}
