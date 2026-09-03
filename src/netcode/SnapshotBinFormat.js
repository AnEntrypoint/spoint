// Pure binary wire-format primitives for SnapshotEncoder.js: the fixed 23-byte numeric record
// (position/velocity/rotation/scale/flags) and the 32-bit packed-quaternion encode/decode. No
// closure/instance state -- split out as the one genuinely self-contained piece of that file.
// See SnapshotEncoder.js's own header comment for the full wire-layout rationale.

const Q1 = 100
const QSCALE = 511 * Math.SQRT2

// --- Binary numeric record (DataView, replaces JS-array-through-msgpackr for the fixed numeric
// fields: position/velocity/rotation/scale). id/model/bodyType/custom stay as native JS values
// alongside this buffer -- they are variable-shape (strings, arbitrary objects) and packing them
// into a fixed byte layout would be strictly worse (lossy or unbounded), not a real win. Position/
// velocity are int16 at the existing Q1=100 (1cm) scale, clamped to +-327.67m -- entity/player
// positions are always encoded relative to a region/session-local origin already (no planetary
// float32 range concern here; see AGENTS.md floating-origin-camera-relative-rendering row for the
// separate concern of >10km world coordinates, which is a rendering-layer issue, not a wire-format
// one). Scale uses uint16 unsigned at the same Q1 scale (0..655.35, entities are never negatively
// scaled). Rotation reuses packQuat's existing 32-bit packed representation verbatim -- not
// reinvented. Fixed player/entity record is 23 bytes: 3*i16 pos + 3*i16 vel + u32 quat + 3*u16
// scale + 1 flags byte = 6+6+4+6+1 = 23.
export const BIN_RECORD_BYTES = 23
export const POS_I16_MAX = 32767 / Q1   // 327.67
export const SCALE_U16_MAX = 65535 / Q1 // 655.35

export function clampI16(v) { return Math.max(-32767, Math.min(32767, Math.round((v || 0) * Q1))) }
export function clampU16Scale(v) { return Math.max(0, Math.min(65535, Math.round((v ?? 1) * Q1))) }

// Packs the fixed numeric fields of one entity/player record into a fresh 23-byte Uint8Array.
// flags: caller-supplied bitfield (onGround/sleeping/etc for players/entities respectively).
export function packBinRecord(px, py, pz, qrot, vx, vy, vz, sx, sy, sz, flags) {
  const buf = new Uint8Array(BIN_RECORD_BYTES)
  const dv = new DataView(buf.buffer)
  dv.setInt16(0, clampI16(px), true); dv.setInt16(2, clampI16(py), true); dv.setInt16(4, clampI16(pz), true)
  dv.setInt16(6, clampI16(vx), true); dv.setInt16(8, clampI16(vy), true); dv.setInt16(10, clampI16(vz), true)
  dv.setUint32(12, qrot >>> 0, true)
  dv.setUint16(16, clampU16Scale(sx), true); dv.setUint16(18, clampU16Scale(sy), true); dv.setUint16(20, clampU16Scale(sz), true)
  dv.setUint8(22, flags & 0xFF)
  return buf
}

export function unpackBinRecord(buf, out) {
  const dv = buf instanceof DataView ? buf : new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  out.px = dv.getInt16(0, true) / Q1; out.py = dv.getInt16(2, true) / Q1; out.pz = dv.getInt16(4, true) / Q1
  out.vx = dv.getInt16(6, true) / Q1; out.vy = dv.getInt16(8, true) / Q1; out.vz = dv.getInt16(10, true) / Q1
  out.qrot = dv.getUint32(12, true)
  out.sx = dv.getUint16(16, true) / Q1; out.sy = dv.getUint16(18, true) / Q1; out.sz = dv.getUint16(20, true) / Q1
  out.flags = dv.getUint8(22)
  return out
}

export function packQuat(rx, ry, rz, rw) {
  const arx = Math.abs(rx), ary = Math.abs(ry), arz = Math.abs(rz), arw = Math.abs(rw)
  let maxIdx = 0, maxAbs = arx
  if (ary > maxAbs) { maxIdx = 1; maxAbs = ary }
  if (arz > maxAbs) { maxIdx = 2; maxAbs = arz }
  if (arw > maxAbs) { maxIdx = 3; maxAbs = arw }
  const mval = maxIdx === 0 ? rx : maxIdx === 1 ? ry : maxIdx === 2 ? rz : rw
  const sign = mval < 0 ? -1 : 1
  let packed = maxIdx
  if (maxIdx !== 0) packed = (packed << 10) | Math.max(0, Math.min(1022, Math.round((rx * sign + Math.SQRT1_2) * QSCALE)))
  if (maxIdx !== 1) packed = (packed << 10) | Math.max(0, Math.min(1022, Math.round((ry * sign + Math.SQRT1_2) * QSCALE)))
  if (maxIdx !== 2) packed = (packed << 10) | Math.max(0, Math.min(1022, Math.round((rz * sign + Math.SQRT1_2) * QSCALE)))
  if (maxIdx !== 3) packed = (packed << 10) | Math.max(0, Math.min(1022, Math.round((rw * sign + Math.SQRT1_2) * QSCALE)))
  return packed >>> 0
}

// Unrolled per maxIdx branch (was a QUAT_IDX[] lookup + generic loop over `indices`) -- this runs
// once per entity/player per snapshot, client-side, the hottest per-frame decode path, so the extra
// array indirection through QUAT_IDX plus a 3-iteration loop with a data-dependent out-index write
// is worth trading for 4 flat, branch-predictable unpacks. Each branch reads the same three 10-bit
// fields off `packed` in the same bit order (most-significant first, j=2..0) as the original loop,
// just with the literal QUAT_IDX[maxIdx] destination slots inlined instead of indexed.
export function unpackQuat(packed, out) {
  const maxIdx = (packed >>> 30) & 0x3
  const c2 = (packed & 0x3FF) / QSCALE - Math.SQRT1_2; packed = packed >>> 10
  const c1 = (packed & 0x3FF) / QSCALE - Math.SQRT1_2; packed = packed >>> 10
  const c0 = (packed & 0x3FF) / QSCALE - Math.SQRT1_2
  const sumSq = c0 * c0 + c1 * c1 + c2 * c2
  const m = Math.sqrt(Math.max(0, 1 - sumSq))
  switch (maxIdx) {
    case 0: out[1] = c0; out[2] = c1; out[3] = c2; out[0] = m; break
    case 1: out[0] = c0; out[2] = c1; out[3] = c2; out[1] = m; break
    case 2: out[0] = c0; out[1] = c1; out[3] = c2; out[2] = m; break
    default: out[0] = c0; out[1] = c1; out[2] = c2; out[3] = m; break
  }
  return out
}
