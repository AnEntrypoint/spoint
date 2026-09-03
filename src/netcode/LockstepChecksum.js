// lockstep-desync-detection-and-recovery: the checksum-fold primitive, extracted from the
// deterministic-fixed-point-lockstep-architecture-for-rts-fighting probe's own proven technique
// (lockstep-worker.mjs, scratch-only, never committed) into a real, reusable module. That probe folded
// every dynamic body's position+rotation into a 64-bit FNV-1a-style checksum via RAW FLOAT64 BIT PATTERNS
// (not string formatting, which the probe's own header comment notes "could mask a real divergence" --
// e.g. 0.1+0.2 and 0.30000000000000004 stringify identically to a naive toFixed(n) or JSON.stringify
// after V8's default Number->String rounding). That discipline is reused verbatim here.
//
// WHY 64-bit, not SnapshotEncoder.js's existing 32-bit fnv1aStep/fnv1aStepNum/fnv1aStepBytes: those exist
// for CHEAP per-field DIRTY-DETECTION (has this one entity's wire-visible state changed since last tick,
// decide whether to re-encode it), a very different bar than a desync CHECKSUM whose entire job is
// distinguishing "these two peers' full physics state are bit-identical" from "they have diverged by even
// one ULP" across potentially thousands of bodies each tick -- a 32-bit fold collides far more readily at
// that volume (birthday-bound ~2^16 states) than a 64-bit one (~2^32), and unlike a wire-format field this
// checksum never needs to be compact on the wire (it's a small periodic side-channel exchange, not sent
// every tick with every entity). Also float64 (not float32): a desync detector's whole purpose is catching
// SUB-ULP divergence a peer with even a slightly different Jolt/Node/V8 build might introduce; truncating to
// float32 before hashing would silently mask exactly the class of divergence this module exists to catch.
//
// Two independent 32-bit FNV-1a lanes (seeded with FNV's own standard 32-bit offset basis 0x811c9dc5 and a
// second, different odd seed 0x1000193 -- FNV-1a's own prime, reused as a second seed purely because it is
// already a well-mixed odd constant with no application-specific meaning attached) folded together into one
// 64-bit-strength value (as two hex halves) rather than a real BigInt/64-bit integer type, matching the
// probe's own "bcc3b564ae46bf35"-shaped hex output and avoiding introducing BigInt into a per-tick-adjacent
// hot path for zero mixing-quality gain over two well-seeded 32-bit lanes.
const FNV_PRIME = 16777619
const _f64buf = new ArrayBuffer(8)
const _f64view = new DataView(_f64buf)

function foldFloat64(hashA, hashB, n) {
  // Normalize -0 to 0 and NaN to a fixed bit pattern: Jolt/JS floating point can legitimately produce
  // either a +0/-0 sign-bit difference or an all-NaN-payloads-are-not-bitwise-equal NaN between two
  // otherwise-identical simulations without those being a REAL desync (both represent "no meaningful
  // value" identically for gameplay purposes) -- hashing the raw bits unnormalized would false-positive
  // a desync on that alone.
  const v = n === 0 ? 0 : (Number.isNaN(n) ? NaN : n)
  _f64view.setFloat64(0, v)
  for (let i = 0; i < 8; i++) {
    const byte = _f64view.getUint8(i)
    hashA ^= byte; hashA = Math.imul(hashA, FNV_PRIME)
    hashB ^= byte + 1; hashB = Math.imul(hashB, FNV_PRIME) // +1 offset decorrelates the second lane from the first
  }
  return [hashA, hashB]
}

// Creates a fresh fold accumulator. Call .push(n) for every float64 component that must participate in the
// checksum, in a FIXED, deterministic order (see checksumBodies below for the canonical order this module
// itself uses) -- two peers folding the identical values in a different order will NOT produce the same
// checksum despite having identical state, so order is part of the contract, not an implementation detail.
export function createChecksumFold() {
  let a = 0x811c9dc5, b = 0x1000193
  return {
    push(n) { [a, b] = foldFloat64(a, b, n); return this },
    pushInt(n) { [a, b] = foldFloat64(a, b, n | 0); return this }, // for tick numbers / counts, coerced through the same float64 path for a single code path
    digest() { return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0') },
  }
}

// Canonical whole-world checksum: folds `tick` (so a checksum computed at the wrong tick can never
// accidentally compare equal to the right one), then every dynamic body's position+rotation+velocity+
// angularVelocity, in the DETERMINISTIC (sorted-by-id) iteration order every peer's own PhysicsWorld.
// snapshotBodies() Map must produce identically (each peer inserts bodies in its own create order, which
// is only guaranteed identical across peers if world construction itself is deterministic -- true today per
// the already-resolved lockstep tick-loop probe's own body-spawn discipline, but sorting here is a second,
// independent guarantee so a checksum comparison is never accidentally order-sensitive on top of that).
// `snap` is exactly the shape PhysicsWorld.snapshotBodies() already returns (a Map id -> {position,
// rotation, velocity, angularVelocity}), reused as-is rather than inventing a parallel state-capture path --
// the SAME primitive rollback-netcode-ggpo-style-input-rollback already ships and trusts for save/restore.
export function checksumBodies(tick, snap) {
  const fold = createChecksumFold().pushInt(tick)
  const ids = snap instanceof Map ? [...snap.keys()] : Object.keys(snap).map(Number)
  ids.sort((x, y) => x - y)
  for (const id of ids) {
    const s = snap instanceof Map ? snap.get(id) : snap[id]
    fold.pushInt(id)
    for (const v of s.position) fold.push(v)
    for (const v of s.rotation) fold.push(v)
    for (const v of s.velocity) fold.push(v)
    for (const v of s.angularVelocity) fold.push(v)
  }
  return fold.digest()
}
