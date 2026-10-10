export const CTRL_INTS_PER_SLOT = 2
export const PAYLOAD_FLOATS_PER_SLOT = 10
const GEN_OFF = 0, PID_OFF = 1
const POS_OFF = 0, ROT_OFF = 3, VEL_OFF = 7

export function isRingAvailable() {
  return typeof globalThis.crossOriginIsolated !== 'undefined' && globalThis.crossOriginIsolated === true &&
    typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined'
}

export const RING_HEADER_INTS = 4
const RING_MAGIC = 0x54524e47
const MAGIC_OFF = 0, HEADER_CAPACITY_OFF = 1, HEADER_GEN_OFF = 2, HEADER_EPOCH_OFF = 3

const WRITE_LOCK_ATTEMPTS = 64
const SLOT_READ_RETRIES = 4
const RING_CUT_RETRIES = 4

function genLocked(gen) { return (gen & 1) === 1 }

function headerBytes() { return RING_HEADER_INTS * 4 }
function ctrlBytes(capacity) { return capacity * CTRL_INTS_PER_SLOT * 4 }
function payloadBytes(capacity) { return capacity * PAYLOAD_FLOATS_PER_SLOT * 8 }

export function allocateRingBuffer(capacity = 64) {
  if (!isRingAvailable()) return null
  const sab = new SharedArrayBuffer(headerBytes() + ctrlBytes(capacity) + payloadBytes(capacity))
  const header = new Int32Array(sab, 0, RING_HEADER_INTS)
  Atomics.store(header, MAGIC_OFF, RING_MAGIC)
  Atomics.store(header, HEADER_CAPACITY_OFF, capacity)
  Atomics.store(header, HEADER_GEN_OFF, 0)
  Atomics.store(header, HEADER_EPOCH_OFF, 0)
  return { sab, capacity }
}

export function assertRingLayout(sab, capacity) {
  if (!(sab instanceof SharedArrayBuffer)) throw new TypeError('[transform-ring] expected a SharedArrayBuffer')
  const needed = headerBytes() + ctrlBytes(capacity) + payloadBytes(capacity)
  if (sab.byteLength < headerBytes()) throw new RangeError(`[transform-ring] buffer is ${sab.byteLength} bytes, too small for the ${headerBytes()}-byte layout header`)
  const header = new Int32Array(sab, 0, RING_HEADER_INTS)
  const magic = Atomics.load(header, MAGIC_OFF)
  if (magic !== RING_MAGIC) throw new RangeError(`[transform-ring] buffer carries no TransformRing header (magic 0x${(magic >>> 0).toString(16)}), so writer and reader cannot agree on its layout`)
  const stamped = Atomics.load(header, HEADER_CAPACITY_OFF)
  if (stamped !== capacity) throw new RangeError(`[transform-ring] capacity mismatch: buffer holds ${stamped} slots but ${capacity} were requested`)
  if (sab.byteLength !== needed) throw new RangeError(`[transform-ring] buffer is ${sab.byteLength} bytes, expected ${needed} for ${capacity} slots`)
}

function makeViews(sab, capacity) {
  assertRingLayout(sab, capacity)
  return {
    header: new Int32Array(sab, 0, RING_HEADER_INTS),
    ctrl: new Int32Array(sab, headerBytes(), capacity * CTRL_INTS_PER_SLOT),
    payload: new Float64Array(sab, headerBytes() + ctrlBytes(capacity), capacity * PAYLOAD_FLOATS_PER_SLOT)
  }
}

export class TransformRingWriter {
  constructor(sab, capacity) {
    const { header, ctrl, payload } = makeViews(sab, capacity)
    this._header = header
    this._ctrl = ctrl
    this._payload = payload
    this._capacity = capacity
    this._slotOf = new Map()
    this._free = []
    for (let i = capacity - 1; i >= 0; i--) this._free.push(i)
    for (let i = 0; i < capacity; i++) Atomics.store(this._ctrl, i * CTRL_INTS_PER_SLOT + PID_OFF, -1)
  }

  hasSlot(playerId) {
    return this._slotOf.has(playerId)
  }

  slotOf(playerId) {
    const slot = this._slotOf.get(playerId)
    return slot === undefined ? null : slot
  }

  tryAssign(playerId) {
    if (this._slotOf.has(playerId)) return
    const slot = this._free.pop()
    if (slot === undefined) return
    this._slotOf.set(playerId, slot)
  }

  _beginWrite() {
    for (let attempt = 0; attempt < WRITE_LOCK_ATTEMPTS; attempt++) {
      const gen = Atomics.load(this._header, HEADER_GEN_OFF)
      if (genLocked(gen)) continue
      if (Atomics.compareExchange(this._header, HEADER_GEN_OFF, gen, gen + 1) === gen) return gen
    }
    return null
  }

  _endWrite(ringGen) {
    Atomics.store(this._header, HEADER_GEN_OFF, ringGen + 2)
  }

  release(playerId) {
    const slot = this._slotOf.get(playerId)
    if (slot === undefined) return false
    const ringGen = this._beginWrite()
    if (ringGen === null) return false
    const cbase = slot * CTRL_INTS_PER_SLOT
    const gen = Atomics.load(this._ctrl, cbase + GEN_OFF)
    Atomics.store(this._ctrl, cbase + GEN_OFF, gen + 1)
    Atomics.store(this._ctrl, cbase + PID_OFF, -1)
    Atomics.store(this._ctrl, cbase + GEN_OFF, gen + 2)
    Atomics.add(this._header, HEADER_EPOCH_OFF, 1)
    this._endWrite(ringGen)
    this._slotOf.delete(playerId)
    this._free.push(slot)
    return true
  }

  write(playerId, position, rotation, velocity) {
    let slot = this.slotOf(playerId)
    if (slot === null) { this.tryAssign(playerId); slot = this.slotOf(playerId) }
    if (slot === null) return false
    const ringGen = this._beginWrite()
    if (ringGen === null) return false
    const cbase = slot * CTRL_INTS_PER_SLOT, pbase = slot * PAYLOAD_FLOATS_PER_SLOT
    const gen = Atomics.load(this._ctrl, cbase + GEN_OFF)
    Atomics.store(this._ctrl, cbase + GEN_OFF, gen + 1)
    Atomics.store(this._ctrl, cbase + PID_OFF, playerId)
    this._payload[pbase + POS_OFF] = position[0]; this._payload[pbase + POS_OFF + 1] = position[1]; this._payload[pbase + POS_OFF + 2] = position[2]
    this._payload[pbase + ROT_OFF] = rotation[0]; this._payload[pbase + ROT_OFF + 1] = rotation[1]; this._payload[pbase + ROT_OFF + 2] = rotation[2]; this._payload[pbase + ROT_OFF + 3] = rotation[3]
    this._payload[pbase + VEL_OFF] = velocity[0]; this._payload[pbase + VEL_OFF + 1] = velocity[1]; this._payload[pbase + VEL_OFF + 2] = velocity[2]
    Atomics.store(this._ctrl, cbase + GEN_OFF, gen + 2)
    this._endWrite(ringGen)
    return true
  }
}

export class TransformRingReader {
  constructor(sab, capacity) {
    const { header, ctrl, payload } = makeViews(sab, capacity)
    this._header = header
    this._ctrl = ctrl
    this._payload = payload
    this._capacity = capacity
  }

  _readSlots() {
    const out = new Map()
    for (let i = 0; i < this._capacity; i++) {
      const cbase = i * CTRL_INTS_PER_SLOT, pbase = i * PAYLOAD_FLOATS_PER_SLOT
      let attempt = 0, gen1 = 0, gen2 = -1, pid, px, py, pz, qx, qy, qz, qw, vx, vy, vz
      do {
        gen1 = Atomics.load(this._ctrl, cbase + GEN_OFF)
        if (gen1 & 1) { attempt++; continue }
        pid = Atomics.load(this._ctrl, cbase + PID_OFF)
        px = this._payload[pbase + POS_OFF]; py = this._payload[pbase + POS_OFF + 1]; pz = this._payload[pbase + POS_OFF + 2]
        qx = this._payload[pbase + ROT_OFF]; qy = this._payload[pbase + ROT_OFF + 1]; qz = this._payload[pbase + ROT_OFF + 2]; qw = this._payload[pbase + ROT_OFF + 3]
        vx = this._payload[pbase + VEL_OFF]; vy = this._payload[pbase + VEL_OFF + 1]; vz = this._payload[pbase + VEL_OFF + 2]
        gen2 = Atomics.load(this._ctrl, cbase + GEN_OFF)
        attempt++
      } while (gen1 !== gen2 && attempt < SLOT_READ_RETRIES)
      if (pid === undefined || pid === -1) continue
      if (gen1 !== gen2 || genLocked(gen1)) continue
      out.set(pid, { position: [px, py, pz], rotation: [qx, qy, qz, qw], velocity: [vx, vy, vz], stale: false })
    }
    return out
  }

  readCut(maxRetries = RING_CUT_RETRIES) {
    let players = null
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const generation = Atomics.load(this._header, HEADER_GEN_OFF)
      if (genLocked(generation)) continue
      const epoch = Atomics.load(this._header, HEADER_EPOCH_OFF)
      players = this._readSlots()
      if (Atomics.load(this._header, HEADER_GEN_OFF) === generation) return { generation, epoch, players, consistent: true }
    }
    const sampled = players ?? this._readSlots()
    for (const entry of sampled.values()) entry.stale = true
    return { generation: -1, epoch: -1, players: sampled, consistent: false }
  }

  readAll(maxRetries = RING_CUT_RETRIES) {
    return this.readCut(maxRetries).players
  }
}
