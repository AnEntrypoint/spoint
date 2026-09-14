export const CTRL_INTS_PER_SLOT = 2
export const PAYLOAD_FLOATS_PER_SLOT = 10
const GEN_OFF = 0, PID_OFF = 1
const POS_OFF = 0, ROT_OFF = 3, VEL_OFF = 7

export function isRingAvailable() {
  return typeof globalThis.crossOriginIsolated !== 'undefined' && globalThis.crossOriginIsolated === true &&
    typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined'
}

function ctrlBytes(capacity) { return capacity * CTRL_INTS_PER_SLOT * 4 }
function payloadBytes(capacity) { return capacity * PAYLOAD_FLOATS_PER_SLOT * 8 }

export function allocateRingBuffer(capacity = 64) {
  if (!isRingAvailable()) return null
  const sab = new SharedArrayBuffer(ctrlBytes(capacity) + payloadBytes(capacity))
  return { sab, capacity }
}

function makeViews(sab, capacity) {
  return {
    ctrl: new Int32Array(sab, 0, capacity * CTRL_INTS_PER_SLOT),
    payload: new Float64Array(sab, ctrlBytes(capacity), capacity * PAYLOAD_FLOATS_PER_SLOT)
  }
}

export class TransformRingWriter {
  constructor(sab, capacity) {
    const { ctrl, payload } = makeViews(sab, capacity)
    this._ctrl = ctrl
    this._payload = payload
    this._capacity = capacity
    this._slotOf = new Map()
    this._free = []
    for (let i = capacity - 1; i >= 0; i--) this._free.push(i)
    for (let i = 0; i < capacity; i++) Atomics.store(this._ctrl, i * CTRL_INTS_PER_SLOT + PID_OFF, -1)
  }

  assign(playerId) {
    if (this._slotOf.has(playerId)) return this._slotOf.get(playerId)
    const slot = this._free.pop()
    if (slot === undefined) return -1
    this._slotOf.set(playerId, slot)
    return slot
  }

  release(playerId) {
    const slot = this._slotOf.get(playerId)
    if (slot === undefined) return
    const cbase = slot * CTRL_INTS_PER_SLOT
    const gen = Atomics.load(this._ctrl, cbase + GEN_OFF)
    Atomics.store(this._ctrl, cbase + GEN_OFF, gen + 1)
    Atomics.store(this._ctrl, cbase + PID_OFF, -1)
    Atomics.store(this._ctrl, cbase + GEN_OFF, gen + 2)
    this._slotOf.delete(playerId)
    this._free.push(slot)
  }

  write(playerId, position, rotation, velocity) {
    let slot = this._slotOf.get(playerId)
    if (slot === undefined) { slot = this.assign(playerId); if (slot === -1) return false }
    const cbase = slot * CTRL_INTS_PER_SLOT, pbase = slot * PAYLOAD_FLOATS_PER_SLOT
    const gen = Atomics.load(this._ctrl, cbase + GEN_OFF)
    Atomics.store(this._ctrl, cbase + GEN_OFF, gen + 1)
    Atomics.store(this._ctrl, cbase + PID_OFF, playerId)
    this._payload[pbase + POS_OFF] = position[0]; this._payload[pbase + POS_OFF + 1] = position[1]; this._payload[pbase + POS_OFF + 2] = position[2]
    this._payload[pbase + ROT_OFF] = rotation[0]; this._payload[pbase + ROT_OFF + 1] = rotation[1]; this._payload[pbase + ROT_OFF + 2] = rotation[2]; this._payload[pbase + ROT_OFF + 3] = rotation[3]
    this._payload[pbase + VEL_OFF] = velocity[0]; this._payload[pbase + VEL_OFF + 1] = velocity[1]; this._payload[pbase + VEL_OFF + 2] = velocity[2]
    Atomics.store(this._ctrl, cbase + GEN_OFF, gen + 2)
    return true
  }
}

export class TransformRingReader {
  constructor(sab, capacity) {
    const { ctrl, payload } = makeViews(sab, capacity)
    this._ctrl = ctrl
    this._payload = payload
    this._capacity = capacity
  }

  readAll(maxRetriesPerSlot = 4) {
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
      } while (gen1 !== gen2 && attempt < maxRetriesPerSlot)
      if (pid === undefined || pid === -1) continue
      const stale = gen1 !== gen2 || (gen1 & 1) === 1
      out.set(pid, { position: [px, py, pz], rotation: [qx, qy, qz, qw], velocity: [vx, vy, vz], stale })
    }
    return out
  }
}
