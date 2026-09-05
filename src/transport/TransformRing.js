// SharedArrayBuffer-backed transform ring for the in-Worker singleplayer/host path
// (src/sdk/WorkerEntry.js + client/BrowserServer.js). Purpose: let the physics worker publish
// every player's latest position/rotation/velocity directly into shared memory each tick, so the
// main/render thread can read the freshest transform with zero postMessage round-trip -- instead
// of today's per-frame transferable-ArrayBuffer postMessage (WorkerTransport.send), which still
// traverses the async structured-clone message queue once per snapshot even though the ArrayBuffer
// itself is transferred not copied.
//
// This module is intentionally narrow: it only carries the HOT per-tick transform-sync path
// (position/rotation/velocity per player slot). Every other message (spawns/despawns/APP_EVENT/
// chat/snapshot-for-non-transform-fields/etc) keeps flowing through the existing WorkerTransport
// postMessage channel unchanged -- see this row's own PRD detail.
//
// Availability: requires globalThis.crossOriginIsolated === true (real COOP/COEP response headers),
// which the server does NOT yet send (see sibling PRD row physics-coop-coep-headers-sharedarraybuffer-
// enable, still pending as of this row). isRingAvailable()/allocateRingBuffer() degrade explicitly:
// callers MUST check isRingAvailable() (or handle a null return from allocateRingBuffer()) and fall
// back to the existing postMessage-only path when SharedArrayBuffer/Atomics/crossOriginIsolated are
// not all real -- this is not optional, a meaningful fraction of real deployments (iframe embeds
// without the embedder's own COEP cooperation) will never satisfy it.
//
// Memory layout: TWO views over ONE SharedArrayBuffer.
//  - Control block (front of the buffer): one Int32Array pair per slot [generation, playerId].
//    Atomics.store/load ONLY operate on integer typed arrays (Float64Array is rejected at runtime --
//    confirmed live, see this row's own probe), so the generation/playerId torn-read guard MUST live
//    in an Int32Array, not alongside the float payload.
//  - Payload block (rest of the buffer): one Float64Array[10] per slot (px,py,pz, qx,qy,qz,qw, vx,vy,vz)
//    -- ordinary (non-atomic) reads/writes, made safe by the generation bracket around them: the writer
//    bumps generation to odd BEFORE touching the payload and back to even AFTER (both via Atomics.store,
//    which Firefox/V8/JSC all implement with sequential-consistency semantics, i.e. it also acts as a
//    full memory fence for the plain payload stores/loads around it) -- a reader that observes an even
//    generation both before and after reading the payload is guaranteed to have seen a complete write.
export const CTRL_INTS_PER_SLOT = 2 // [generation, playerId]
export const PAYLOAD_FLOATS_PER_SLOT = 10 // px,py,pz, qx,qy,qz,qw, vx,vy,vz
const GEN_OFF = 0, PID_OFF = 1
const POS_OFF = 0, ROT_OFF = 3, VEL_OFF = 7

export function isRingAvailable() {
  return typeof globalThis.crossOriginIsolated !== 'undefined' && globalThis.crossOriginIsolated === true &&
    typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined'
}

function ctrlBytes(capacity) { return capacity * CTRL_INTS_PER_SLOT * 4 }
function payloadBytes(capacity) { return capacity * PAYLOAD_FLOATS_PER_SLOT * 8 }

// Returns { sab, capacity } or null if unavailable. `sab` is the raw SharedArrayBuffer to hand to the
// main thread by reference (SharedArrayBuffer postMessage does NOT need/accept a transfer list -- it is
// already shared, not copied/transferred) from the worker at INIT time.
export function allocateRingBuffer(capacity = 64) {
  if (!isRingAvailable()) return null
  // Float64Array requires its buffer offset to be a multiple of 8; ctrlBytes(capacity) is always a
  // multiple of 8 (capacity*2 int32s = capacity*8 bytes) so the payload block naturally starts aligned.
  const sab = new SharedArrayBuffer(ctrlBytes(capacity) + payloadBytes(capacity))
  return { sab, capacity }
}

function makeViews(sab, capacity) {
  return {
    ctrl: new Int32Array(sab, 0, capacity * CTRL_INTS_PER_SLOT),
    payload: new Float64Array(sab, ctrlBytes(capacity), capacity * PAYLOAD_FLOATS_PER_SLOT)
  }
}

// Producer side (runs inside src/sdk/WorkerEntry.js, one instance for the worker's whole lifetime).
// Owns the playerId -> slot assignment (a simple free-list) so the consumer never needs to negotiate
// slot indices -- it just scans PID_OFF each read.
export class TransformRingWriter {
  constructor(sab, capacity) {
    const { ctrl, payload } = makeViews(sab, capacity)
    this._ctrl = ctrl
    this._payload = payload
    this._capacity = capacity
    this._slotOf = new Map() // playerId -> slot index
    this._free = []
    for (let i = capacity - 1; i >= 0; i--) this._free.push(i)
    // mark every slot empty up front (playerId -1, generation 0/even/stable)
    for (let i = 0; i < capacity; i++) Atomics.store(this._ctrl, i * CTRL_INTS_PER_SLOT + PID_OFF, -1)
  }

  assign(playerId) {
    if (this._slotOf.has(playerId)) return this._slotOf.get(playerId)
    const slot = this._free.pop()
    if (slot === undefined) return -1 // ring exhausted -- caller must fall back to postMessage for this player
    this._slotOf.set(playerId, slot)
    return slot
  }

  release(playerId) {
    const slot = this._slotOf.get(playerId)
    if (slot === undefined) return
    const cbase = slot * CTRL_INTS_PER_SLOT
    const gen = Atomics.load(this._ctrl, cbase + GEN_OFF)
    Atomics.store(this._ctrl, cbase + GEN_OFF, gen + 1) // odd: readers must retry
    Atomics.store(this._ctrl, cbase + PID_OFF, -1)
    Atomics.store(this._ctrl, cbase + GEN_OFF, gen + 2) // even: readable again, now empty
    this._slotOf.delete(playerId)
    this._free.push(slot)
  }

  // position/rotation/velocity: plain arrays (or array-likes), length 3/4/3. Called once per player
  // per tick from the same spot TickHandler.js already calls networkState.updatePlayer.
  write(playerId, position, rotation, velocity) {
    let slot = this._slotOf.get(playerId)
    if (slot === undefined) { slot = this.assign(playerId); if (slot === -1) return false }
    const cbase = slot * CTRL_INTS_PER_SLOT, pbase = slot * PAYLOAD_FLOATS_PER_SLOT
    const gen = Atomics.load(this._ctrl, cbase + GEN_OFF)
    Atomics.store(this._ctrl, cbase + GEN_OFF, gen + 1) // now odd: readers must retry (also fences the payload stores below)
    Atomics.store(this._ctrl, cbase + PID_OFF, playerId)
    this._payload[pbase + POS_OFF] = position[0]; this._payload[pbase + POS_OFF + 1] = position[1]; this._payload[pbase + POS_OFF + 2] = position[2]
    this._payload[pbase + ROT_OFF] = rotation[0]; this._payload[pbase + ROT_OFF + 1] = rotation[1]; this._payload[pbase + ROT_OFF + 2] = rotation[2]; this._payload[pbase + ROT_OFF + 3] = rotation[3]
    this._payload[pbase + VEL_OFF] = velocity[0]; this._payload[pbase + VEL_OFF + 1] = velocity[1]; this._payload[pbase + VEL_OFF + 2] = velocity[2]
    Atomics.store(this._ctrl, cbase + GEN_OFF, gen + 2) // back to even: readable again (fences the payload stores above)
    return true
  }
}

// Consumer side (runs on the main/render thread, e.g. client/BrowserServer.js). Reads the freshest
// transform for every occupied slot with zero postMessage round-trip. A torn read (writer mid-write
// when we sample) is detected via the generation bracket and retried a bounded number of times --
// under real per-tick write cadence (the configured server tickRate, 60Hz default, per-world override) and a render-thread read cadence bound by rAF (<=240Hz
// realistic ceiling), a collision window is a handful of microseconds; 4 retries is generous headroom,
// not a tuned-to-the-wire constant.
export class TransformRingReader {
  constructor(sab, capacity) {
    const { ctrl, payload } = makeViews(sab, capacity)
    this._ctrl = ctrl
    this._payload = payload
    this._capacity = capacity
  }

  // Returns a Map<playerId, {position:[x,y,z], rotation:[x,y,z,w], velocity:[x,y,z], stale:boolean}>.
  // `stale` is true only if every retry hit a torn read for that slot (caller may choose to keep the
  // previous frame's value for that player rather than use a possibly-inconsistent one).
  readAll(maxRetriesPerSlot = 4) {
    const out = new Map()
    for (let i = 0; i < this._capacity; i++) {
      const cbase = i * CTRL_INTS_PER_SLOT, pbase = i * PAYLOAD_FLOATS_PER_SLOT
      let attempt = 0, gen1 = 0, gen2 = -1, pid, px, py, pz, qx, qy, qz, qw, vx, vy, vz
      do {
        gen1 = Atomics.load(this._ctrl, cbase + GEN_OFF)
        if (gen1 & 1) { attempt++; continue } // writer mid-write, retry
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
